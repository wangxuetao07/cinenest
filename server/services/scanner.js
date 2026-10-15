'use strict';

/**
 * 扫描器：遍历媒体库目录，提取元数据、生成缩略图，落库。
 *
 * 流程见 开发任务书 7.1。
 * 并发：p-limit(3)（p-limit v5 为 ESM，使用动态 import + 内置回退）。
 */

const fs = require('fs');
const path = require('path');
const fg = require('fast-glob');

const db = require('../db');
const config = require('../config');
const logger = require('../utils/logger');
const { probe } = require('./probe');
const { makeThumb, removeThumbFile } = require('./thumbnail');
const sprite = require('./sprite');
const preview = require('./preview');
const { toPosix, isVideoExt } = require('../utils/paths');

const IGNORE_DIRS = ['**/@eaDir/**', '**/$RECYCLE.BIN/**', '**/System Volume Information/**', '**/.git/**'];

/**
 * 删除闸门（v1.3）。
 *
 * 「文件不存在 → 删记录」这条规则本身没错，但它无法区分两种截然不同的情况：
 * 用户真的删了片子，还是存储没挂上（外接盘未插、NAS 掉线、共享未连接）。
 * 后者一次扫描就能把整库记录连同标签 / 收藏 / 观看进度一起级联清光。
 *
 * 因此加两道刹车：库内记录数达到 MIN_GUARD_SAMPLE 后，若缺失比例超过
 * MISSING_RATIO，或**整库全部缺失**，则跳过删除，只记告警，
 * 等管理员在任务页确认后走「确认清理」接口。
 */
const MIN_GUARD_SAMPLE = 5;   // 记录数低于此值不做比例判定（小库频繁增删，误判成本高）
const MISSING_RATIO = 0.3;    // 缺失比例阈值

// ---------- 并发限制器 ----------
let _limitFactory = null;
async function getLimitFactory() {
  if (_limitFactory) return _limitFactory;
  try {
    const mod = await import('p-limit');
    _limitFactory = mod.default || mod;
  } catch (_) {
    _limitFactory = simpleLimit;
  }
  return _limitFactory;
}

/** 内置并发限制器（p-limit 不可用时回退） */
function simpleLimit(concurrency) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= concurrency || queue.length === 0) return;
    active += 1;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        next();
      });
  };
  return function limit(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
  };
}

// ---------- 扫描状态（供 /api/tasks/running 查询） ----------
const state = {
  running: false,
  libraryId: null,
  startedAt: null,
  scanned: 0,
  total: 0,
};

function getState() {
  return Object.assign({}, state);
}

// ---------- 预编译 SQL ----------
const SQL = {
  getLibrary: () => db.prepare('SELECT * FROM library WHERE id = ?'),
  getVideoByPath: () => db.prepare('SELECT * FROM video WHERE file_path = ?'),
  listVideosOfLibrary: () => db.prepare('SELECT id, file_path, thumb_path FROM video WHERE library_id = ?'),
  insertVideo: () => db.prepare(`
    INSERT INTO video
      (library_id, file_path, file_name, title, ext, size, mtime, duration,
       width, height, video_codec, audio_codec, bitrate, thumb_path, poster_path)
    VALUES
      (@library_id, @file_path, @file_name, @title, @ext, @size, @mtime, @duration,
       @width, @height, @video_codec, @audio_codec, @bitrate, @thumb_path, @poster_path)
  `),
  // 内容变化（size/mtime 变）时一并清空精灵图：抽帧结果依赖源文件，
  // 留着旧图会显示错画面；下次进播放页会自动重新懒生成。
  updateVideo: () => db.prepare(`
    UPDATE video SET
      file_name = @file_name,
      title = COALESCE(title, @title),
      size = @size,
      mtime = @mtime,
      duration = @duration,
      width = @width,
      height = @height,
      video_codec = @video_codec,
      audio_codec = @audio_codec,
      bitrate = @bitrate,
      thumb_path = COALESCE(@thumb_path, thumb_path),
      sprite_path = NULL,
      sprite_meta = NULL,
      preview_path = NULL,
      updated_at = datetime('now','localtime')
    WHERE id = @id
  `),
  deleteVideo: () => db.prepare('DELETE FROM video WHERE id = ?'),
  insertScanLog: () => db.prepare(`
    INSERT INTO scan_log (library_id, started_at, finished_at, added, updated, deleted, failed, blocked, message)
    VALUES (@library_id, @started_at, @finished_at, @added, @updated, @deleted, @failed, @blocked, @message)
  `),
};

/** 生成标题：文件名去扩展名 */
function titleFromFile(fileName) {
  return path.basename(fileName, path.extname(fileName)).trim();
}

/**
 * 扫描单个媒体库。
 * @param {{id:number, path:string}} library
 * @returns {Promise<{total:number,added:number,updated:number,deleted:number,failed:number}>}
 */
async function scanLibrary(library) {
  if (!library || !library.path) throw new Error('媒体库路径无效');

  const libRoot = library.path;
  if (!fs.existsSync(libRoot)) {
    throw new Error('媒体库目录不存在: ' + libRoot);
  }

  const startedAt = new Date().toISOString();
  const startedSql = new Date().toISOString().slice(0, 19).replace('T', ' ');

  state.running = true;
  state.libraryId = library.id;
  state.startedAt = startedAt;
  state.scanned = 0;
  state.total = 0;

  logger.scan('开始扫描媒体库 #' + library.id + ' ' + libRoot);

  // 1) 遍历
  const pattern = path.posix.join(toPosix(libRoot), '**/*');
  let entries = [];
  try {
    entries = await fg(pattern, {
      onlyFiles: true,
      dot: false,
      followSymbolicLinks: false,
      suppressErrors: true,
      ignore: IGNORE_DIRS,
    });
  } catch (err) {
    logger.error('[scanner] 遍历失败:', err.message);
  }

  const allVideo = entries.filter((f) => isVideoExt(path.extname(f)));

  // HLS 库：与 .m3u8 同目录的分片（.ts/.m4s/.aac）属于该播放列表的一部分，
  // 不单独计为一个「视频」，否则一个 HLS 目录会刷出成百上千条记录。
  const PLAYLIST_EXT = ['.m3u8', '.m3u'];
  const hlsDirs = new Set(
    allVideo
      .filter((f) => PLAYLIST_EXT.includes(path.extname(f).toLowerCase()))
      .map((f) => toPosix(path.dirname(path.resolve(f))))
  );
  const files = allVideo.filter((f) => {
    const ext = path.extname(f).toLowerCase();
    if (!config.hlsSegmentExt.includes(ext)) return true;
    return !hlsDirs.has(toPosix(path.dirname(path.resolve(f))));
  });

  state.total = files.length;

  const limit = (await getLimitFactory())(3);

  let added = 0;
  let updated = 0;
  let failed = 0;

  const getVideoByPath = SQL.getVideoByPath();

  // 2) 逐个处理（并发 3）
  const tasks = files.map((raw) =>
    limit(async () => {
      // fast-glob 返回正斜杠，统一规范化为平台原生路径（Windows 保留反斜杠）
      const file = path.normalize(path.resolve(raw));
      try {
        const stat = fs.statSync(file);
        const size = stat.size;
        const mtime = Math.floor(stat.mtimeMs);

        const existing = getVideoByPath.get(file);

        // 未变化 → 跳过
        if (existing && Number(existing.size) === size && Number(existing.mtime) === mtime) {
          state.scanned += 1;
          return;
        }

        let meta = { duration: 0, bitrate: 0, width: 0, height: 0, videoCodec: null, audioCodec: null };
        try {
          meta = await probe(file);
        } catch (e) {
          // ffprobe 失败仍入库（标记 failed），保留基本信息
          failed += 1;
          logger.warn('[scanner] ffprobe 失败:', file, e.message);
        }

        let thumb = null;
        try {
          thumb = await makeThumb(file, meta.duration);
        } catch (_) {
          thumb = null;
        }

        const fileName = path.basename(file);
        const ext = path.extname(file).toLowerCase();

        if (existing) {
          // 源文件变了 → 旧的抽帧预览/悬停片段作废（updateVideo 会清空对应字段）
          if (Number(existing.mtime) !== mtime) {
            sprite.removeSprites(existing.id);
            preview.removePreviews(existing.id);
          }
          SQL.updateVideo().run({
            id: existing.id,
            file_name: fileName,
            title: titleFromFile(fileName),
            size,
            mtime,
            duration: meta.duration,
            width: meta.width,
            height: meta.height,
            video_codec: meta.videoCodec,
            audio_codec: meta.audioCodec,
            bitrate: meta.bitrate,
            thumb_path: thumb,
          });
          updated += 1;
        } else {
          SQL.insertVideo().run({
            library_id: library.id,
            file_path: file,
            file_name: fileName,
            title: titleFromFile(fileName),
            ext,
            size,
            mtime,
            duration: meta.duration,
            width: meta.width,
            height: meta.height,
            video_codec: meta.videoCodec,
            audio_codec: meta.audioCodec,
            bitrate: meta.bitrate,
            thumb_path: thumb,
            poster_path: null,
          });
          added += 1;
        }
      } catch (err) {
        failed += 1;
        logger.warn('[scanner] 处理失败:', file, err.message);
      } finally {
        state.scanned += 1;
      }
    })
  );

  await Promise.all(tasks);

  // 3) 清理：库内已不存在的文件 → 删记录（带删除闸门，见文件顶部注释）
  let deleted = 0;
  let blocked = 0;
  let libTotal = 0;
  try {
    const rows = SQL.listVideosOfLibrary().all(library.id);
    libTotal = rows.length;
    const missing = rows.filter((row) => !fs.existsSync(row.file_path));

    const guardTriggered =
      rows.length >= MIN_GUARD_SAMPLE &&
      (missing.length === rows.length || missing.length / rows.length > MISSING_RATIO);

    if (guardTriggered) {
      blocked = missing.length;
      logger.warn(
        '[scanner] 疑似存储离线，已跳过删除：媒体库 #' + library.id +
        ' 有 ' + missing.length + '/' + rows.length + ' 条记录的文件不存在'
      );
    } else {
      for (const row of missing) {
        SQL.deleteVideo().run(row.id);
        removeThumbFile(row.thumb_path);
        sprite.removeSprites(row.id);
        preview.removePreviews(row.id);
        deleted += 1;
      }
    }
  } catch (err) {
    logger.error('[scanner] 清理失败:', err.message);
  }

  // 4) 写日志
  const finishedSql = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const result = { total: files.length, added, updated, deleted, failed, blocked };

  let message =
    '扫描完成：共 ' + files.length + ' 个视频，新增 ' + added + '，更新 ' + updated +
    '，删除 ' + deleted + '，失败 ' + failed;
  if (blocked > 0) {
    message +=
      '；⚠️ 有 ' + blocked + '/' + libTotal + ' 条记录的文件不存在，疑似存储离线，' +
      '已跳过删除。确认文件确实已移除后可点击「确认清理」';
  }

  try {
    SQL.insertScanLog().run({
      library_id: library.id,
      started_at: startedSql,
      finished_at: finishedSql,
      added,
      updated,
      deleted,
      failed,
      blocked,
      message,
    });
  } catch (err) {
    logger.error('[scanner] 写 scan_log 失败:', err.message);
  }

  logger.scan('扫描结束 #' + library.id + ' →', result);

  // 5) 扫描后自动补齐悬停预览片段（v1.4）：只处理未就绪的，后台静默执行；
  //    若批量任务已在跑则直接复用（startBatch 幂等）。
  try {
    preview.startBatch();
  } catch (err) {
    logger.warn('[preview] 扫描后自动生成启动失败:', err.message);
  }

  state.running = false;
  state.libraryId = null;
  state.startedAt = null;
  state.scanned = 0;
  state.total = 0;

  return result;
}

/**
 * 扫描指定 library id。
 */
async function scanLibraryById(libraryId) {
  const lib = SQL.getLibrary().get(libraryId);
  if (!lib) throw new Error('媒体库不存在: ' + libraryId);
  return scanLibrary(lib);
}

/**
 * 「确认清理」：无视删除闸门，把库内所有文件已不存在的记录删掉（v1.3）。
 * 只在管理员明确确认「文件确实已移除、存储没离线」后调用。
 * @returns {{deleted:number, checked:number}}
 */
function purgeMissing(libraryId) {
  const rows = SQL.listVideosOfLibrary().all(Number(libraryId));
  let deleted = 0;
  for (const row of rows) {
    if (fs.existsSync(row.file_path)) continue;
    SQL.deleteVideo().run(row.id);
    removeThumbFile(row.thumb_path);
    sprite.removeSprites(row.id);
    preview.removePreviews(row.id);
    deleted += 1;
  }
  if (deleted) {
    logger.info('[scanner] 确认清理：媒体库 #' + libraryId + ' 删除 ' + deleted + ' 条失效记录');
  }
  return { deleted, checked: rows.length };
}

/** 统计某库当前有多少条记录的文件已不存在（用于前端展示告警条数） */
function countMissing(libraryId) {
  const rows = SQL.listVideosOfLibrary().all(Number(libraryId));
  return rows.filter((row) => !fs.existsSync(row.file_path)).length;
}

module.exports = { scanLibrary, scanLibraryById, purgeMissing, countMissing, getState, IGNORE_DIRS };
