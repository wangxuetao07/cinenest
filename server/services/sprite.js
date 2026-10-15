'use strict';

/**
 * 进度条抽帧预览 —— 精灵图（v1.3）。
 *
 * 把整片按固定间隔抽成 N 张小帧，拼成一张大图（雪碧图），
 * 前端把它交给 Artplayer 的 thumbnails 控件：桌面悬停进度条、
 * 手机拖动进度条时显示该时间点的画面。
 *
 * 命令要点（实测数据见 CHANGELOG v1.3）：
 *   -skip_frame nokey   只解码关键帧。瓶颈在解码而非抽帧，因此 100 帧与
 *                       30 帧耗时几乎相同，可以直接用 100 帧上限。
 *   -hwaccel d3d11va    Windows 上启用硬解，4K HEVC 实测 88s → 27s（3.2 倍）。
 *                       失败时自动回退软解。
 *   tile=10xN           每行 10 格，行数按实际帧数计算。
 *
 * 命名：data/sprites/v<id>-<mtime>.jpg —— 源文件变更（mtime 变）自动失效，
 * 删视频时按 'v<id>-' 前缀直接清理，无需查库。
 *
 * 单张 4K 素材需 20-30 秒，因此**一律后台异步生成**，接口只返回状态；
 * 失败静默降级（没有精灵图就不显示预览，不影响播放）。
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const db = require('../db');
const config = require('../config');
const logger = require('../utils/logger');

const SPRITE_DIR = path.join(config.dataDir, 'sprites');

const FRAME_W = 160;            // 单帧宽（px）
const FRAME_H = 90;             // 单帧高（px）
const COLUMN = 10;              // 每行帧数
const MAX_FRAMES = 100;         // 单张精灵图最大帧数
const MIN_FRAMES = 4;           // 最短视频也至少抽这么多帧
const MAX_CONCURRENCY = 2;      // 同时生成的精灵图数（避免与 HLS 转码抢资源）
const GEN_TIMEOUT_MS = 5 * 60 * 1000;
const JOB_KEEP_MS = 10 * 60 * 1000;

/** videoId → { status:'running'|'done'|'failed', error, startedAt, finishedAt } */
const jobs = new Map();

/** 批量生成任务状态 */
const batch = {
  running: false,
  cancelled: false,
  total: 0,
  done: 0,
  failed: 0,
  currentId: null,
  startedAt: null,
  finishedAt: null,
};

/* ------------------------------------------------------------------ *
 * 几何 / 路径
 * ------------------------------------------------------------------ */

/** 抽帧数量：时长的一半，限制在 [MIN_FRAMES, MAX_FRAMES] */
function framesFor(duration) {
  const d = Number(duration) || 0;
  if (d <= 0) return MIN_FRAMES;
  return Math.min(MAX_FRAMES, Math.max(MIN_FRAMES, Math.round(d / 2)));
}

/** 精灵图元信息（前端 art.thumbnails 直接使用） */
function metaFor(video) {
  const number = framesFor(video && video.duration);
  return {
    number,
    column: COLUMN,
    row: Math.ceil(number / COLUMN),
    width: FRAME_W,
    height: FRAME_H,
  };
}

/** 精灵图绝对路径（随源文件 mtime 变化） */
function spritePathFor(video) {
  const mtime = Number(video && video.mtime) || 0;
  return path.join(SPRITE_DIR, 'v' + Number(video && video.id) + '-' + mtime + '.jpg');
}

/** 读取库里存的 meta（解析失败则按当前时长重算） */
function readMeta(video) {
  if (video && video.sprite_meta) {
    try {
      const parsed = JSON.parse(video.sprite_meta);
      if (parsed && parsed.number > 0 && parsed.column > 0) return parsed;
    } catch (_) { /* 落到按需重算 */ }
  }
  return metaFor(video);
}

/** 该视频的精灵图是否已就绪（路径一致 + 文件存在且非空） */
function isReady(video) {
  if (!video || !video.sprite_path) return false;
  try {
    const expected = spritePathFor(video);
    if (path.resolve(video.sprite_path) !== expected) return false;
    return fs.existsSync(expected) && fs.statSync(expected).size > 0;
  } catch (_) {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * ffmpeg 调用
 * ------------------------------------------------------------------ */

function run(args, timeoutMs) {
  return new Promise((resolve) => {
    let stderr = '';
    let killed = false;
    const child = spawn(config.ffmpeg, args, { windowsHide: true });
    const timer = setTimeout(() => {
      killed = true;
      try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
    }, timeoutMs);

    if (child.stderr) {
      child.stderr.on('data', (d) => { if (stderr.length < 4000) stderr += d.toString('utf8'); });
    }
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stderr: err.message, killed });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: killed ? -2 : code, stderr, killed });
    });
  });
}

/**
 * 统计源文件的关键帧数量（只解关键帧，速度很快）。
 * 帧数必须与实际可用画面数一致：抽的帧多于关键帧时，tile 会用黑块补位，
 * 前端拖到那些位置就是一片黑。失败返回 0（由调用方回退估算）。
 */
function countKeyframes(video) {
  return new Promise((resolve) => {
    const args = [
      '-v', 'error',
      '-skip_frame', 'nokey',
      '-select_streams', 'v:0',
      '-show_entries', 'frame=pts_time',
      '-of', 'csv=p=0',
      video.file_path,
    ];
    let out = '';
    let killed = false;
    const child = spawn(config.ffprobe, args, { windowsHide: true });
    const timer = setTimeout(() => {
      killed = true;
      try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
    }, 30 * 1000);

    if (child.stdout) {
      child.stdout.on('data', (d) => { if (out.length < 1024 * 512) out += d.toString('utf8'); });
    }
    child.on('error', () => { clearTimeout(timer); resolve(0); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed || code !== 0) return resolve(0);
      resolve(out.split(/\r?\n/).filter((l) => l.trim() !== '').length);
    });
  });
}

/** 确定抽帧数量与解码方式（v1.3.1：杜绝黑格） */
async function planFrames(video) {
  const duration = Number(video.duration) || 0;

  // 短片（<15s）：关键帧可能只有 1-2 个，直接全解码抽帧，
  // 按每秒 2 帧取，画面密度才有意义；这一步即使 4K 也只需数秒。
  if (duration > 0 && duration < 15) {
    return { number: Math.min(40, Math.max(MIN_FRAMES, Math.floor(duration * 2))), skipFrame: false };
  }

  // 长视频：数一遍关键帧（很快），帧数取「关键帧数」与「时长/2」的较小者，
  // 保证 tile 里每一格都有画面、不会出现黑块。
  const kf = await countKeyframes(video);
  if (kf > 0) {
    const byDuration = duration > 0 ? Math.round(duration / 2) : MAX_FRAMES;
    const number = Math.min(MAX_FRAMES, Math.max(MIN_FRAMES, byDuration, kf), kf);
    return { number, skipFrame: true };
  }

  // 数不出关键帧（异常源文件）：退回按时长估算，可能出现少量黑格
  return { number: framesFor(duration), skipFrame: true };
}

function buildArgs(video, out, number, skipFrame, hwaccel) {
  const duration = Number(video.duration) || 0;
  // 抽帧间隔：把整片均匀切成 number 份
  const step = duration > 0 ? Math.max(0.1, duration / number) : 2;
  const row = Math.ceil(number / COLUMN);
  const vf = [
    'fps=1/' + step.toFixed(4),
    // 统一铺满 160x90（超宽片居中裁切），保证网格尺寸固定
    'scale=' + FRAME_W + ':' + FRAME_H + ':force_original_aspect_ratio=increase',
    'crop=' + FRAME_W + ':' + FRAME_H,
    'tile=' + COLUMN + 'x' + row,
  ].join(',');

  const args = ['-hide_banner', '-loglevel', 'error'];
  if (hwaccel) args.push('-hwaccel', hwaccel);
  // -skip_frame 是输入选项，必须在 -i 之前
  if (skipFrame) args.push('-skip_frame', 'nokey');
  args.push('-i', video.file_path);
  args.push('-vf', vf, '-frames:v', '1', '-q:v', '5', '-y', out);
  return args;
}

/**
 * 生成一张精灵图。
 * @returns {Promise<{path:string, meta:object}|null>} 失败返回 null（不抛异常）
 */
async function generate(video) {
  if (!video || !video.file_path) return null;
  if (!fs.existsSync(video.file_path)) {
    logger.warn('[sprite] 源文件不存在，跳过:', video.file_path);
    return null;
  }

  const out = spritePathFor(video);

  try {
    if (!fs.existsSync(SPRITE_DIR)) fs.mkdirSync(SPRITE_DIR, { recursive: true });
  } catch (err) {
    logger.warn('[sprite] 创建目录失败:', err.message);
    return null;
  }

  const plan = await planFrames(video);
  const meta = Object.assign({ column: COLUMN, width: FRAME_W, height: FRAME_H }, plan, {
    row: Math.ceil(plan.number / COLUMN),
  });

  // Windows 上优先硬解（HEVC 约 3 倍提速），失败回退软解
  const hwList = process.platform === 'win32' ? ['d3d11va', null] : [null];

  for (const hw of hwList) {
    try { fs.rmSync(out, { force: true }); } catch (_) { /* ignore */ }

    const started = Date.now();
    const r = await run(buildArgs(video, out, plan.number, plan.skipFrame, hw), GEN_TIMEOUT_MS);
    const cost = ((Date.now() - started) / 1000).toFixed(1);

    if (r.code === 0) {
      try {
        if (fs.existsSync(out) && fs.statSync(out).size > 0) {
          logger.info(
            '[sprite] 生成完成 video #' + video.id + '（' + cost + 's，' + plan.number + ' 帧' +
            (plan.skipFrame ? '，关键帧' : '，全解') + (hw ? '，硬解 ' + hw : '，软解') + '）'
          );
          return { path: out, meta };
        }
      } catch (_) { /* 落到重试 */ }
    }

    logger.warn(
      '[sprite] 生成失败 video #' + video.id + '（' + (hw || '软解') + '，退出码 ' + r.code +
      '，' + cost + 's）：' + String(r.stderr || '').trim().slice(-200)
    );
  }

  try { fs.rmSync(out, { force: true }); } catch (_) { /* ignore */ }
  return null;
}

/* ------------------------------------------------------------------ *
 * 任务状态 / 懒生成
 * ------------------------------------------------------------------ */

/** 清理过期的终态任务记录 */
function sweepJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.status !== 'running' && job.finishedAt && now - job.finishedAt > JOB_KEEP_MS) {
      jobs.delete(id);
    }
  }
}

/** 当前状态（不触发任何生成） */
function statusOf(video) {
  const job = jobs.get(Number(video.id));
  return {
    ready: isReady(video),
    generating: !!job && job.status === 'running',
    error: job && job.status === 'failed' ? (job.error || '生成失败') : null,
  };
}

/**
 * 懒生成：已就绪直接返回；否则后台启动生成（幂等，同片只跑一个）。
 */
function ensure(video) {
  sweepJobs();

  if (isReady(video)) return { ready: true, generating: false, error: null };

  const id = Number(video.id);
  const running = jobs.get(id);
  if (running && running.status === 'running') {
    return { ready: false, generating: true, error: null };
  }

  const job = { status: 'running', error: null, startedAt: Date.now(), finishedAt: null };
  jobs.set(id, job);

  Promise.resolve()
    .then(() => generate(video))
    .then((r) => {
      if (r) {
        try {
          db.prepare(
            "UPDATE video SET sprite_path = ?, sprite_meta = ?, updated_at = datetime('now','localtime') WHERE id = ?"
          ).run(r.path, JSON.stringify(r.meta), id);
          // 同步内存对象，后续 isReady 直接命中
          video.sprite_path = r.path;
          video.sprite_meta = JSON.stringify(r.meta);
        } catch (err) {
          logger.warn('[sprite] 写回 sprite_path 失败 #' + id + ':', err.message);
        }
        job.status = 'done';
      } else {
        job.status = 'failed';
        job.error = '抽帧失败（源文件可能无法解码）';
      }
    })
    .catch((err) => {
      job.status = 'failed';
      job.error = err.message;
      logger.warn('[sprite] 生成异常 #' + id + ':', err.message);
    })
    .finally(() => { job.finishedAt = Date.now(); });

  return { ready: false, generating: true, error: null };
}

/* ------------------------------------------------------------------ *
 * 批量生成
 * ------------------------------------------------------------------ */

function getBatchState() {
  return Object.assign({}, batch);
}

/** 内置并发限制器（无需 ESM 依赖） */
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
      .finally(() => { active -= 1; next(); });
  };
  return function limit(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
  };
}

/**
 * 启动批量生成（只处理尚未就绪的视频）。
 * @returns {object} 启动后的任务状态
 */
function startBatch() {
  if (batch.running) return getBatchState();

  const rows = db
    .prepare('SELECT id, title, file_path, duration, mtime, sprite_path, sprite_meta FROM video ORDER BY id ASC')
    .all();
  const targets = rows.filter((v) => !isReady(v));

  batch.running = true;
  batch.cancelled = false;
  batch.total = targets.length;
  batch.done = 0;
  batch.failed = 0;
  batch.currentId = null;
  batch.startedAt = new Date().toISOString();
  batch.finishedAt = null;

  if (targets.length === 0) {
    batch.running = false;
    batch.finishedAt = new Date().toISOString();
    return getBatchState();
  }

  logger.info('[sprite] 批量生成启动，待处理 ' + targets.length + ' 个视频');

  const limit = simpleLimit(MAX_CONCURRENCY);
  Promise.all(
    targets.map((v) =>
      limit(async () => {
        if (batch.cancelled) return;
        batch.currentId = v.id;
        const r = await generate(v);
        if (r) {
          try {
            db.prepare(
              "UPDATE video SET sprite_path = ?, sprite_meta = ?, updated_at = datetime('now','localtime') WHERE id = ?"
            ).run(r.path, JSON.stringify(r.meta), v.id);
            batch.done += 1;
          } catch (err) {
            logger.warn('[sprite] 批量写回失败 #' + v.id + ':', err.message);
            batch.failed += 1;
          }
        } else {
          batch.failed += 1;
        }
      })
    )
  )
    .catch((err) => logger.error('[sprite] 批量任务异常:', err.message))
    .finally(() => {
      batch.running = false;
      batch.currentId = null;
      batch.finishedAt = new Date().toISOString();
      logger.info(
        '[sprite] 批量生成结束：成功 ' + batch.done + '，失败 ' + batch.failed +
        (batch.cancelled ? '（已取消）' : '')
      );
    });

  return getBatchState();
}

/** 取消批量生成（当前正在生成的那批跑完即停） */
function cancelBatch() {
  if (batch.running) {
    batch.cancelled = true;
    logger.info('[sprite] 收到取消请求，将在当前批次结束后停止');
  }
  return getBatchState();
}

/* ------------------------------------------------------------------ *
 * 清理
 * ------------------------------------------------------------------ */

/** 删除单个文件（Windows 下可能被短暂占用，失败重试） */
function removeFile(file) {
  for (let i = 0; i < 3; i += 1) {
    try {
      fs.rmSync(file, { force: true });
      return true;
    } catch (_) {
      if (i === 2) return false;
    }
  }
  return false;
}

/** 删除某个视频的全部精灵图（按 'v<id>-' 前缀） */
function removeSprites(videoId) {
  let count = 0;
  try {
    const prefix = 'v' + Number(videoId) + '-';
    for (const f of fs.readdirSync(SPRITE_DIR)) {
      if (!f.startsWith(prefix)) continue;
      if (removeFile(path.join(SPRITE_DIR, f))) count += 1;
    }
  } catch (_) { /* 目录不存在等，忽略 */ }
  jobs.delete(Number(videoId));
  return count;
}

/** 当前精灵图占用（数量 / 字节） */
function getStats() {
  const out = { dir: SPRITE_DIR, count: 0, bytes: 0, ready: 0, total: 0 };
  try {
    for (const f of fs.readdirSync(SPRITE_DIR)) {
      try {
        out.bytes += fs.statSync(path.join(SPRITE_DIR, f)).size;
        out.count += 1;
      } catch (_) { /* ignore */ }
    }
  } catch (_) { /* ignore */ }

  try {
    const rows = db.prepare('SELECT id, duration, mtime, sprite_path, sprite_meta FROM video').all();
    out.total = rows.length;
    out.ready = rows.filter((v) => !!v.sprite_path).length;
  } catch (_) { /* ignore */ }

  out.running = jobs.size;
  return out;
}

module.exports = {
  SPRITE_DIR,
  FRAME_W,
  FRAME_H,
  COLUMN,
  MAX_FRAMES,
  MIN_FRAMES,
  framesFor,
  metaFor,
  spritePathFor,
  readMeta,
  isReady,
  generate,
  statusOf,
  ensure,
  startBatch,
  cancelBatch,
  getBatchState,
  removeSprites,
  getStats,
};
