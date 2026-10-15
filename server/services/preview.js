'use strict';

/**
 * 卡片悬停预览片段（v1.4）—— 类 B 站「鼠标悬停即播放」。
 *
 * 为什么不能直接播原片：
 *   - 库里大量 HEVC 源浏览器根本不支持解码；
 *   - 高码率源（实测中位 134Mbps）悬停即拉走几十 MB 流量。
 * 因此预生成一个低码率 MP4 小片段，悬停时 <video> 直连播放，秒开。
 *
 * 生成策略（实测数据见 CHANGELOG v1.4）：
 *   全片均匀取 5 段 × 2 秒（1/6..5/6 处）。
 *   每段独立 ffmpeg 进程快速 seek 抽取（单输入 seek 准确），最后 concat demuxer
 *   无损拼接 —— 不可用「多路输入 + filter_complex concat」一把出：实测 ≥3 路输入
 *   时输入 seek 失效，5 段会全部落到第一个采样点（v1.4.2 修复的真实缺陷）。
 *   4K HEVC 单段 2s 约 2s 出片，全片段约 10s；短片（<12s）整片直取；时长未知从头取 6 秒。
 *
 * 输出参数（悬停场景的最优平衡）：
 *   H.264 Main / yuv420p（全平台可解）· 12fps · CRF30 · 无音轨（悬停静音是 B 站惯例，
 *   也规避浏览器自动播放策略）· faststart（moov 前置，边下边播）。
 *
 * 命名：data/previews/p<id>-<mtime>.mp4 —— 源文件变更（mtime 变）自动失效，
 * 删视频时按 'p<id>-' 前缀直接清理，无需查库。
 *
 * 生成时机三重保障：扫描完成后自动批量 + 悬停时懒生成 + 设置页手动批量。
 * 失败静默降级（没有片段就保持静态缩略图，不影响任何功能）。
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const db = require('../db');
const config = require('../config');
const logger = require('../utils/logger');

const PREVIEW_DIR = path.join(config.dataDir, 'previews');

const OUT_W = 480;             // 输出宽（卡片宽 220-300px，480p 留有余量）
const OUT_H = 270;             // 输出高
const FPS = 12;                // 输出帧率（悬停预览够流畅，体积减半）
const SEGMENTS = 5;            // 均匀采样段数
const SEG_DUR = 2;             // 每段时长（秒）
const WHOLE_BELOW = 12;        // 短于此秒数的视频整片直取、不拼接
const FALLBACK_DUR = 6;        // 时长未知时从头取的秒数
const CRF = '30';
const MAX_CONCURRENCY = 2;     // 与 HLS 转码/精灵图错峰，避免打满 CPU
const GEN_TIMEOUT_MS = 10 * 60 * 1000;
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
 * 路径 / 状态
 * ------------------------------------------------------------------ */

/** 预览片段绝对路径（随源文件 mtime 变化） */
function previewPathFor(video) {
  const mtime = Number(video && video.mtime) || 0;
  return path.join(PREVIEW_DIR, 'p' + Number(video && video.id) + '-' + mtime + '.mp4');
}

/** 该视频的预览片段是否已就绪（路径一致 + 文件存在且非空） */
function isReady(video) {
  if (!video || !video.preview_path) return false;
  try {
    const expected = previewPathFor(video);
    if (path.resolve(video.preview_path) !== expected) return false;
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
 * 采样方案：
 *   - 短片（< WHOLE_BELOW 秒）或时长未知 → 整片直取（whole=true）
 *   - 其余 → 全片均匀 5 段，每段 SEG_DUR 秒，起点按 10%..90% 均布并夹在片内
 * @returns {{whole:boolean, points:number[]}}
 */
function planSegments(video) {
  const duration = Number(video && video.duration) || 0;

  if (duration <= 0) return { whole: true, points: [] };
  if (duration < WHOLE_BELOW) return { whole: true, points: [] };

  const maxStart = duration - SEG_DUR - 0.2; // 留 0.2s 余量防越界出黑帧
  const points = [];
  for (let i = 1; i <= SEGMENTS; i += 1) {
    const p = (duration * i) / (SEGMENTS + 1);
    points.push(Math.max(0, Math.min(p, maxStart)));
  }
  return { whole: false, points };
}

/** 编码输出参数（所有片段保持一致，保证 concat 兼容 + 浏览器直解） */
function encodeArgs() {
  return [
    '-an',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', CRF,
    '-pix_fmt', 'yuv420p',
    '-profile:v', 'main',
    '-movflags', '+faststart',
  ];
}

/** 统一缩放滤镜：铺满 480x270（超宽片居中裁切） */
function scaleFilter() {
  return (
    'fps=' + FPS +
    ',scale=' + OUT_W + ':' + OUT_H + ':force_original_aspect_ratio=increase' +
    ',crop=' + OUT_W + ':' + OUT_H
  );
}

function buildArgs(video, out, plan, hwaccel) {
  const args = ['-hide_banner', '-loglevel', 'error'];
  const file = video.file_path;

  if (plan.whole) {
    if (hwaccel) args.push('-hwaccel', hwaccel);
    args.push('-i', file);
    const dur = Number(video.duration) || 0;
    const take = dur > 0 ? Math.min(dur, FALLBACK_DUR) : FALLBACK_DUR;
    args.push('-t', take.toFixed(3));
    args.push('-vf', scaleFilter());
  } else {
    // 单段抽取：-ss 前置做快速 seek，只解码该段 2 秒。
    // 注意：不能用「多路输入 + filter_complex concat」一把出——实测本机 ffmpeg
    // 在 ≥3 路输入 + concat 时输入 seek 会失效，5 段全部落到第一个采样点
    // （表现为预览变成同一段 2 秒循环 5 次）。因此每段独立进程，最后 concat demuxer 拼接。
    if (hwaccel) args.push('-hwaccel', hwaccel);
    args.push('-ss', Number(plan.start).toFixed(3), '-t', String(SEG_DUR), '-i', file);
    args.push('-vf', scaleFilter());
  }

  args.push(...encodeArgs(), '-y', out);
  return args;
}

/** 分段临时文件（点前缀，生成后即删，也不会被按 'p<id>-' 前缀的清理逻辑误伤） */
function partFileFor(out, i) {
  return path.join(path.dirname(out), '.' + path.basename(out, '.mp4') + '.seg' + i + '.part.mp4');
}

/** concat demuxer 清单文件 */
function listFileFor(out) {
  return path.join(path.dirname(out), '.' + path.basename(out, '.mp4') + '.concat.txt');
}

/** 把各段无损拼接成最终片段（-c copy：各段编码参数一致，直接搬包） */
async function concatSegments(out, segFiles) {
  const list = listFileFor(out);
  const lines = segFiles.map(
    (f) => "file '" + f.replace(/\\/g, '/').replace(/'/g, "'\\''") + "'"
  );
  fs.writeFileSync(list, lines.join('\n') + '\n', 'utf8');
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'concat', '-safe', '0', '-i', list,
    '-c', 'copy', '-movflags', '+faststart',
    '-y', out,
  ];
  return run(args, GEN_TIMEOUT_MS);
}

/** 输出文件是否有效（存在且非空） */
function validOut(file) {
  try {
    return fs.existsSync(file) && fs.statSync(file).size > 0;
  } catch (_) {
    return false;
  }
}

/** 删除分段临时文件与清单 */
function cleanupParts(out, count) {
  for (let i = 0; i < count; i += 1) {
    try { fs.rmSync(partFileFor(out, i), { force: true }); } catch (_) { /* ignore */ }
  }
  try { fs.rmSync(listFileFor(out), { force: true }); } catch (_) { /* ignore */ }
}

/**
 * 生成一个预览片段。
 * @returns {Promise<{path:string}|null>} 失败返回 null（不抛异常）
 */
async function generate(video) {
  if (!video || !video.file_path) return null;
  if (!fs.existsSync(video.file_path)) {
    logger.warn('[preview] 源文件不存在，跳过:', video.file_path);
    return null;
  }

  const out = previewPathFor(video);

  try {
    if (!fs.existsSync(PREVIEW_DIR)) fs.mkdirSync(PREVIEW_DIR, { recursive: true });
  } catch (err) {
    logger.warn('[preview] 创建目录失败:', err.message);
    return null;
  }

  const plan = planSegments(video);

  // Windows 上优先硬解（4K HEVC 约 1.5 倍提速），失败回退软解
  const hwList = process.platform === 'win32' ? ['d3d11va', null] : [null];

  for (const hw of hwList) {
    try { fs.rmSync(out, { force: true }); } catch (_) { /* ignore */ }

    const started = Date.now();
    let failReason = null;

    if (plan.whole) {
      const r = await run(buildArgs(video, out, plan, hw), GEN_TIMEOUT_MS);
      if (r.code === 0 && validOut(out)) {
        failReason = null;
      } else {
        failReason = r;
      }
    } else {
      // 每段独立进程抽取（单输入 seek 准确），再 concat demuxer 无损拼接
      const segFiles = plan.points.map((_, i) => partFileFor(out, i));
      let failed = null;
      for (let i = 0; i < plan.points.length; i += 1) {
        const segOut = segFiles[i];
        try { fs.rmSync(segOut, { force: true }); } catch (_) { /* ignore */ }
        const r = await run(
          buildArgs(video, segOut, { whole: false, start: plan.points[i] }, hw),
          GEN_TIMEOUT_MS
        );
        if (r.code === 0 && validOut(segOut)) continue;
        failed = r;
        break;
      }
      if (!failed) {
        const rc = await concatSegments(out, segFiles);
        if (!(rc.code === 0 && validOut(out))) failed = rc;
      }
      cleanupParts(out, segFiles.length);
      failReason = failed;
    }

    const cost = ((Date.now() - started) / 1000).toFixed(1);

    if (!failReason) {
      logger.info(
        '[preview] 生成完成 video #' + video.id + '（' + cost + 's，' +
        (plan.whole ? '整片直取' : plan.points.length + ' 段拼接') +
        (hw ? '，硬解 ' + hw : '，软解') + '）'
      );
      return { path: out };
    }

    logger.warn(
      '[preview] 生成失败 video #' + video.id + '（' + (hw || '软解') + '，退出码 ' +
      (failReason.code == null ? '?' : failReason.code) + '，' + cost + 's）：' +
      String(failReason.stderr || '').trim().slice(-200)
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
            "UPDATE video SET preview_path = ?, updated_at = datetime('now','localtime') WHERE id = ?"
          ).run(r.path, id);
          video.preview_path = r.path;
        } catch (err) {
          logger.warn('[preview] 写回 preview_path 失败 #' + id + ':', err.message);
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
      logger.warn('[preview] 生成异常 #' + id + ':', err.message);
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
    .prepare('SELECT id, title, file_path, duration, mtime, preview_path FROM video ORDER BY id ASC')
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

  logger.info('[preview] 批量生成启动，待处理 ' + targets.length + ' 个视频');

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
              "UPDATE video SET preview_path = ?, updated_at = datetime('now','localtime') WHERE id = ?"
            ).run(r.path, v.id);
            batch.done += 1;
          } catch (err) {
            logger.warn('[preview] 批量写回失败 #' + v.id + ':', err.message);
            batch.failed += 1;
          }
        } else {
          batch.failed += 1;
        }
      })
    )
  )
    .catch((err) => logger.error('[preview] 批量任务异常:', err.message))
    .finally(() => {
      batch.running = false;
      batch.currentId = null;
      batch.finishedAt = new Date().toISOString();
      logger.info(
        '[preview] 批量生成结束：成功 ' + batch.done + '，失败 ' + batch.failed +
        (batch.cancelled ? '（已取消）' : '')
      );
    });

  return getBatchState();
}

/** 取消批量生成（当前正在生成的那批跑完即停） */
function cancelBatch() {
  if (batch.running) {
    batch.cancelled = true;
    logger.info('[preview] 收到取消请求，将在当前批次结束后停止');
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

/** 删除某个视频的全部预览片段（按 'p<id>-' 前缀） */
function removePreviews(videoId) {
  let count = 0;
  try {
    const prefix = 'p' + Number(videoId) + '-';
    for (const f of fs.readdirSync(PREVIEW_DIR)) {
      if (!f.startsWith(prefix)) continue;
      if (removeFile(path.join(PREVIEW_DIR, f))) count += 1;
    }
  } catch (_) { /* 目录不存在等，忽略 */ }
  jobs.delete(Number(videoId));
  return count;
}

/** 当前预览片段占用（数量 / 字节） */
function getStats() {
  const out = { dir: PREVIEW_DIR, count: 0, bytes: 0, ready: 0, total: 0 };
  try {
    for (const f of fs.readdirSync(PREVIEW_DIR)) {
      try {
        out.bytes += fs.statSync(path.join(PREVIEW_DIR, f)).size;
        out.count += 1;
      } catch (_) { /* ignore */ }
    }
  } catch (_) { /* ignore */ }

  try {
    const rows = db.prepare('SELECT id, preview_path FROM video').all();
    out.total = rows.length;
    out.ready = rows.filter((v) => !!v.preview_path).length;
  } catch (_) { /* ignore */ }

  out.running = jobs.size;
  return out;
}

module.exports = {
  PREVIEW_DIR,
  OUT_W,
  OUT_H,
  FPS,
  SEGMENTS,
  SEG_DUR,
  previewPathFor,
  planSegments,
  isReady,
  generate,
  statusOf,
  ensure,
  startBatch,
  cancelBatch,
  getBatchState,
  removePreviews,
  getStats,
};
