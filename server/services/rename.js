'use strict';

/**
 * 视频重命名（v1.4.8）。
 *
 * 管理员在详情页 / 播放页改「视频名」时，磁盘上的文件同步改名。
 * 看起来只是一次 fs.rename，实际要一并照顾三件事，否则会留下后遗症：
 *
 * 1. **数据库里的路径**：file_path / file_name 必须跟着变。否则 watcher 触发的
 *    扫描会把旧路径判为「已删除」、把新路径当「新视频」，于是 id 变了 ——
 *    收藏、观看进度、历史、标签全部丢失，缩略图与预览也要重做。
 * 2. **同名字幕**：services/subtitle 按「与视频同基本名」查找（含 xxx.zh-CN.srt
 *    这类追加标记），只改视频不改字幕，播放页的字幕就失效了。
 * 3. **缩略图缓存**：thumbnail 用 md5(file_path) 命名，路径一变缓存即作废。
 *    这里直接把旧图改名到新键位（4K HEVC 重新抽帧要好几秒），并更新 DB。
 *
 * 精灵图 / 悬停预览片段按 `v<id>-<mtime>`、`p<id>-<mtime>` 命名，与路径无关；
 * 重命名不会改 mtime，因此两者继续有效，无需重建。
 */

const fs = require('fs');
const path = require('path');

const db = require('../db');
const config = require('../config');
const logger = require('../utils/logger');
const { httpError } = require('../middleware/error');
const { thumbPathFor } = require('./thumbnail');
const scanner = require('./scanner');
const watcher = require('./watcher');

/** 名称长度上限（Windows 单个文件名上限 255，这里留足余量并避免过长路径） */
const MAX_NAME_LEN = 120;

/** Windows 文件名非法字符（含控制字符） */
const INVALID_CHARS = /[<>:"/\\|?*\u0000-\u001f]/;

/** Windows 保留设备名 */
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * 校验并归一化新名称，返回**不含扩展名**的纯名称。
 *
 * - 用户把扩展名一起打进来（`我和我的祖国.mp4`）→ 自动剥离；
 * - 想借重命名改扩展名（`...avi`）→ 明确拒绝，扩展名决定封装与播放方式，
 *   换扩展名属于另一个功能（转封装），不该在这里悄悄做。
 *
 * @param {string} input 用户输入
 * @param {string} ext 当前文件的扩展名（含点，保留原大小写）
 * @returns {string}
 */
function normalizeName(input, ext) {
  let name = String(input == null ? '' : input).trim();

  const lower = name.toLowerCase();
  if (ext && lower.endsWith(ext.toLowerCase())) {
    name = name.slice(0, name.length - ext.length).trim();
  } else {
    const tail = path.extname(name).toLowerCase();
    if (tail && config.videoExt.includes(tail)) {
      throw httpError(400, '扩展名不能修改（当前文件为 ' + ext + '）');
    }
  }

  if (!name) throw httpError(400, '名称不能为空');
  if (name.length > MAX_NAME_LEN) {
    throw httpError(400, '名称过长（最多 ' + MAX_NAME_LEN + ' 个字符）');
  }
  if (INVALID_CHARS.test(name)) {
    throw httpError(400, '名称不能包含 \\ / : * ? " < > | 等字符');
  }
  if (/[. ]$/.test(name)) {
    throw httpError(400, '名称不能以空格或点号结尾');
  }
  if (RESERVED_NAMES.test(name)) {
    throw httpError(400, '该名称是系统保留名，请换一个');
  }
  return name;
}

/**
 * 同目录下与视频同名的字幕文件跟着改名。
 *
 * 匹配两条规则（均忽略大小写）：
 *   - 基本名完全相同：`影片.srt`
 *   - 基本名带追加标记：`影片.zh-CN.srt` / `影片.chs.ass`
 *
 * 单个字幕改名失败只记警告，不影响主流程（主文件已经改好了）。
 *
 * @returns {{from:string,to:string}[]} 实际改名的文件对（便于失败回滚）
 */
function renameSidecars(dir, oldBase, newBase) {
  const renamed = [];
  const lowerOld = oldBase.toLowerCase();
  const subExts = config.subExt.map((e) => e.toLowerCase());

  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    logger.warn('[rename] 读取目录失败，跳过字幕同步:', dir, err.message);
    return renamed;
  }

  for (const f of entries) {
    const rawExt = path.extname(f);
    if (!subExts.includes(rawExt.toLowerCase())) continue;

    const stem = f.slice(0, f.length - rawExt.length);
    const stemLower = stem.toLowerCase();
    if (stemLower !== lowerOld && !stemLower.startsWith(lowerOld + '.')) continue;

    // stem 里超出老基本名的部分就是语言/版本标记（`.zh-CN` / `.chs`），必须原样保留，
    // 否则 `影片.zh-CN.srt` 会被算成 `新名.srt`，与 `影片.srt` 撞名而整条被跳过。
    const suffix = stem.slice(oldBase.length);
    const targetName = newBase + suffix + rawExt;
    if (targetName.toLowerCase() === f.toLowerCase()) continue;

    const from = path.join(dir, f);
    const to = path.join(dir, targetName);
    if (fs.existsSync(to)) {
      logger.warn('[rename] 字幕目标名已存在，已跳过:', targetName);
      continue;
    }
    try {
      renameWithRetry(from, to);
      renamed.push({ from: f, to: targetName });
    } catch (err) {
      logger.warn('[rename] 字幕改名失败:', f, err.message);
    }
  }
  return renamed;
}

/** 同步等待（用于占用重试，不能用 async 打断改名的事务性） */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 带占用重试的改名。
 *
 * Windows 上文件被打开时拒绝改名（EBUSY/EPERM/EACCES）。扫描后会自动批量生成
 * 悬停预览片段，ffmpeg 恰好读着同一个文件时改名就会撞上；这类占用通常只持续
 * 几百毫秒到几秒，等一下再试即可，比直接报错友好得多。
 */
function renameWithRetry(from, to, attempts = 4) {
  const delays = [300, 600, 900];
  for (let i = 0; ; i += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      const retriable = err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES';
      if (!retriable || i >= attempts - 1) throw err;
      sleepSync(delays[Math.min(i, delays.length - 1)]);
    }
  }
}

function moveFileCaseOnly(from, to) {
  const dir = path.dirname(from);
  const ext = path.extname(from);
  const tmp = path.join(dir, '.cinenest-rename-' + Date.now() + ext);
  renameWithRetry(from, tmp);
  try {
    renameWithRetry(tmp, to);
  } catch (err) {
    try { fs.renameSync(tmp, from); } catch (_) { /* 尽力还原 */ }
    throw err;
  }
}

/** 把 Windows 上的占用类错误翻译成人话 */
function fsError(err) {
  if (err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES')) {
    return httpError(409, '文件被占用，改名失败（可能正在播放或生成预览），请稍后重试');
  }
  if (err && err.code === 'ENOENT') {
    return httpError(404, '源文件不存在，可能已被移动或删除');
  }
  if (err && err.code === 'ENAMETOOLONG') {
    return httpError(400, '新文件名过长，请缩短后重试');
  }
  return httpError(500, '改名失败：' + (err && err.message ? err.message : String(err)));
}

/**
 * 重命名视频（磁盘文件 + 数据库记录）。
 *
 * @param {number} videoId
 * @param {{name: string, syncTitle?: boolean}} input
 *        name      新的文件基本名（不含扩展名，或含相同扩展名）
 *        syncTitle 是否把显示名同步为新名称（默认 true）
 * @returns {{changed: boolean, fileRenamed: boolean, subtitles: string[], row: object}}
 */
function renameVideo(videoId, input = {}) {
  const id = Number(videoId);
  const payload = input || {};

  // 扫描进行中时改名会与「文件存在性判定」交叉，容易把记录判成「消失 + 新增」
  if (scanner.getState().running) {
    throw httpError(409, '媒体库正在扫描，请等扫描结束后再改名');
  }

  const row = db.prepare('SELECT * FROM video WHERE id = ?').get(id);
  if (!row) throw httpError(404, '视频不存在');

  const oldPath = row.file_path;
  const dir = path.dirname(oldPath);
  const oldFileName = path.basename(oldPath);
  const ext = path.extname(oldFileName);
  const oldBase = oldFileName.slice(0, oldFileName.length - ext.length);

  const newBase = normalizeName(payload.name, ext);
  const newFileName = newBase + ext;
  const newPath = path.join(dir, newFileName);
  const syncTitle = payload.syncTitle !== false;
  const newTitle = syncTitle ? newBase : (row.title == null ? null : String(row.title));

  if (!fs.existsSync(oldPath)) {
    throw httpError(404, '磁盘上找不到源文件，无法改名（可先扫描媒体库）');
  }

  // 主文件是否真的需要改名；仅大小写不同时 Windows 会判定为同一文件，需走「两步改名」
  const exactSame = newFileName === oldFileName;
  const caseOnly = !exactSame && newFileName.toLowerCase() === oldFileName.toLowerCase();
  const nameChanged = !exactSame;

  let fileRenamed = false;
  let subtitles = [];
  let newThumb = row.thumb_path || null;

  if (nameChanged) {
    // 仅大小写变化时 existsSync 会命中自身，不能当作「重名」
    if (!caseOnly && fs.existsSync(newPath)) {
      throw httpError(409, '目标文件名已存在：' + newFileName);
    }

    try {
      if (caseOnly) moveFileCaseOnly(oldPath, newPath);
      else renameWithRetry(oldPath, newPath);
      fileRenamed = true;
    } catch (err) {
      throw fsError(err);
    }

    subtitles = renameSidecars(dir, oldBase, newBase);

    // 缩略图缓存键迁移（md5 基于路径）；失败就保留旧文件，thumb 路由仍能读到
    if (newThumb && fs.existsSync(newThumb)) {
      const target = thumbPathFor(newPath);
      if (path.resolve(target) !== path.resolve(newThumb)) {
        try {
          if (fs.existsSync(target)) fs.rmSync(target, { force: true });
          fs.renameSync(newThumb, target);
          newThumb = target;
        } catch (err) {
          logger.warn('[rename] 缩略图迁移失败(保留旧文件):', newThumb, err.message);
        }
      }
    }
  }

  const titleChanged = (row.title == null ? null : String(row.title)) !== newTitle;

  if (!fileRenamed && !titleChanged) {
    return { changed: false, fileRenamed: false, subtitles: [], row };
  }

  try {
    db.prepare(
      "UPDATE video SET file_path = @file_path, file_name = @file_name, title = @title," +
      " thumb_path = @thumb_path, updated_at = datetime('now','localtime') WHERE id = @id"
    ).run({
      id,
      file_path: newPath,
      file_name: newFileName,
      title: newTitle,
      thumb_path: newThumb,
    });
  } catch (err) {
    // 库写失败 → 把磁盘改动回滚，避免「磁盘已改、库里仍是旧路径」的错位
    if (fileRenamed) {
      try { fs.renameSync(newPath, oldPath); } catch (_) { /* 尽力还原 */ }
      for (const s of subtitles) {
        try {
          fs.renameSync(path.join(dir, s.to), path.join(dir, s.from));
        } catch (_) { /* ignore */ }
      }
    }
    throw httpError(500, '改名失败（数据库写入异常）：' + err.message);
  }

  const fresh = db.prepare('SELECT * FROM video WHERE id = ?').get(id);

  // 库里的路径已经同步好了，再让 watcher 触发一次扫描没有意义，
  // 而且扫描期间下一次改名会被挡下 —— 直接声明这是程序内部改动。
  if (fileRenamed) watcher.suppress(row.library_id);

  logger.info(
    '[rename] 视频 #' + id + ' ' + oldFileName + ' → ' + newFileName +
    (subtitles.length ? '（同步字幕 ' + subtitles.length + ' 个）' : '')
  );
  return { changed: true, fileRenamed, subtitles, row: fresh };
}

module.exports = { renameVideo, normalizeName, renameSidecars, MAX_NAME_LEN };
