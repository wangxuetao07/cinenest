'use strict';

/**
 * HLS / m3u8 服务（v1.2 新增）。
 *
 * 覆盖两条路径：
 *
 * 1. **本地 m3u8**：媒体库里本身就是 HLS 的（.m3u8 + .ts 分片）。
 *    直接把播放列表重写成可访问的 URL（相对路径 → /api/stream/:id/hls/*），
 *    分片仍然从磁盘原样直出（带 Range 支持），不做任何转码。
 *
 * 2. **按需转码**：源文件是 mp4/mkv/avi… 时，用 ffmpeg 实时切成 HLS。
 *    - 转码进行中：返回「合成 VOD 播放列表」——时长来自 ffprobe，分片边界由
 *      -force_key_frames 固定为 SEGMENT_TIME 秒，因此前端一上来就有完整时长，
 *      可以任意拖拽；请求到尚未生成的分片时服务端会等它落盘。
 *    - 转码结束后：改用 ffmpeg 自己写出的播放列表（时长精确、带 ENDLIST）。
 *
 * 会话管理：每个视频一个会话（同一源文件 mtime 变化则重建），并发上限
 * MAX_TRANSCODES，空闲 IDLE_MS 后回收；进程退出时清理临时目录。
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const config = require('../config');
const logger = require('../utils/logger');
const { isWithin, mimeType } = require('../utils/paths');
const { httpError } = require('../middleware/error');

const HLS_DIR = path.join(config.dataDir, 'hls');
const SEGMENT_TIME = 6;                 // 秒
const MAX_TRANSCODES = 2;               // 同时进行的转码数
const IDLE_MS = 30 * 60 * 1000;         // 会话空闲回收时间
const READY_TIMEOUT_MS = 60 * 1000;     // 等待首个分片的最长时间
const RESOURCE_WAIT_MS = 30 * 1000;     // 等待单个分片生成的最长时间

const sessions = new Map(); // videoId → session
let janitor = null;

/* ------------------------------------------------------------------ *
 * 播放列表文本处理
 * ------------------------------------------------------------------ */

const PLAYLIST_EXT = ['.m3u8', '.m3u'];

/** 是否本地 HLS 播放列表 */
function isLocalPlaylist(filePath) {
  return PLAYLIST_EXT.includes(path.extname(String(filePath || '')).toLowerCase());
}

function readPlaylist(filePath) {
  let text = fs.readFileSync(filePath, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}

/** 绝对 URL / data URI 一律不改写 */
function isExternalUri(uri) {
  return /^(https?:|data:|blob:|rtsp:|rtmp:|\/\/)/i.test(uri);
}

/**
 * 重写 m3u8 文本。
 * @param {string} text 原始播放列表
 * @param {(uri:string) => string|null} mapper 相对 URI → 新地址；返回 null 表示保持原样
 */
function rewritePlaylist(text, mapper) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      out.push(line);
      continue;
    }

    if (trimmed.startsWith('#')) {
      // #EXT-X-KEY / #EXT-X-MAP / #EXT-X-MEDIA / #EXT-X-I-FRAME-STREAM-INF 里的 URI="..."
      out.push(line.replace(/URI="([^"]*)"/g, (whole, uri) => {
        if (!uri || isExternalUri(uri)) return whole;
        const mapped = mapper(uri);
        return mapped ? 'URI="' + mapped + '"' : whole;
      }));
      continue;
    }

    if (isExternalUri(trimmed)) {
      out.push(line);
      continue;
    }

    out.push(mapper(trimmed) || line);
  }
  return out.join('\n');
}

/** 统一正斜杠并去掉开头的 ./ 与 / */
function normalizeRel(uri) {
  return String(uri || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

/** 本地 m3u8：分片地址 → /api/stream/:id/hls/<相对路径> */
function hlsUrl(videoId, relName) {
  const encoded = String(relName)
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');
  return '/api/stream/' + videoId + '/hls/' + encoded;
}

function localMapper(videoId) {
  return (uri) => hlsUrl(videoId, normalizeRel(uri));
}

/* ------------------------------------------------------------------ *
 * 转码会话
 * ------------------------------------------------------------------ */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function activeTranscodes() {
  let n = 0;
  for (const s of sessions.values()) if (!s.done) n += 1;
  return n;
}

/** 销毁会话：杀进程 + 删临时目录 */
function destroySession(videoId) {
  const s = sessions.get(Number(videoId));
  if (!s) return;
  sessions.delete(Number(videoId));
  try {
    if (s.proc && !s.proc.killed) s.proc.kill();
  } catch (_) { /* ignore */ }
  try {
    fs.rmSync(s.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  } catch (err) {
    logger.warn('[hls] 清理临时目录失败:', s.dir, err.message);
  }
}

/** 空闲会话回收 */
function janitorTick() {
  const now = Date.now();
  for (const s of Array.from(sessions.values())) {
    if (now - s.lastAccess > IDLE_MS) {
      logger.info('[hls] 回收空闲转码会话 video #' + s.videoId);
      destroySession(s.videoId);
    }
  }
}

function init() {
  try {
    fs.mkdirSync(HLS_DIR, { recursive: true });
    // 清掉上一次进程残留的分片目录
    for (const name of fs.readdirSync(HLS_DIR)) {
      try {
        fs.rmSync(path.join(HLS_DIR, name), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      } catch (_) { /* ignore */ }
    }
  } catch (err) {
    logger.warn('[hls] 初始化工作目录失败:', err.message);
  }

  if (janitor) clearInterval(janitor);
  janitor = setInterval(janitorTick, 60 * 1000);
  if (janitor.unref) janitor.unref();
}

function stopAll() {
  for (const id of Array.from(sessions.keys())) destroySession(id);
  if (janitor) {
    clearInterval(janitor);
    janitor = null;
  }
}

function buildArgs(video, dir) {
  return [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', video.file_path,
    '-map', '0:v:0?', '-map', '0:a:0?',
    '-sn', '-dn',
    // 统一成浏览器可解：H.264 + yuv420p + AAC
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21',
    '-pix_fmt', 'yuv420p',
    // 固定分片边界，保证合成播放列表的时长精确
    '-force_key_frames', 'expr:gte(t,n_forced*' + SEGMENT_TIME + ')',
    '-c:a', 'aac', '-b:a', '160k', '-ac', '2',
    '-max_muxing_queue_size', '2048',
    '-f', 'hls',
    '-hls_time', String(SEGMENT_TIME),
    '-hls_list_size', '0',
    '-hls_playlist_type', 'event',
    '-hls_flags', 'independent_segments',
    '-hls_segment_filename', path.join(dir, 'seg_%05d.ts'),
    path.join(dir, 'index.m3u8'),
  ];
}

/** ffmpeg 正常结束后补写 #EXT-X-ENDLIST（部分版本对 event 类型不写） */
function finalizePlaylist(session) {
  try {
    if (!fs.existsSync(session.playlistPath)) return;
    let text = readPlaylist(session.playlistPath);
    if (!/#EXT-X-ENDLIST/.test(text)) {
      text = text.replace(/\s*$/, '\n') + '#EXT-X-ENDLIST\n';
      fs.writeFileSync(session.playlistPath, text, 'utf8');
    }
  } catch (err) {
    logger.warn('[hls] 补写 ENDLIST 失败 #' + session.videoId + ':', err.message);
  }
}

function startSession(video, mtime) {
  const videoId = Number(video.id);
  const dir = path.join(HLS_DIR, 'v' + videoId + '-' + mtime);
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  } catch (_) { /* ignore */ }
  fs.mkdirSync(dir, { recursive: true });

  const session = {
    videoId,
    dir,
    playlistPath: path.join(dir, 'index.m3u8'),
    source: video.file_path,
    mtime,
    proc: null,
    done: false,
    error: null,
    lastAccess: Date.now(),
  };

  logger.info('[hls] 开始转码 video #' + videoId + ' → ' + video.file_path);
  const proc = spawn(config.ffmpeg, buildArgs(video, dir), { windowsHide: true });
  session.proc = proc;

  let stderr = '';
  if (proc.stderr) {
    proc.stderr.on('data', (d) => {
      if (stderr.length < 4000) stderr += d.toString('utf8');
    });
  }

  proc.on('error', (err) => {
    session.error = 'ffmpeg 启动失败：' + err.message;
    session.done = true;
    logger.error('[hls] ' + session.error);
  });

  proc.on('close', (code) => {
    session.done = true;
    if (code !== 0) {
      session.error = 'ffmpeg 退出码 ' + code + '（' + stderr.trim().slice(-200) + '）';
      logger.warn('[hls] 转码失败 #' + videoId + '：' + session.error);
    } else {
      finalizePlaylist(session);
      logger.info('[hls] 转码完成 #' + videoId);
    }
  });

  return session;
}

/** 等第一个分片落盘 */
function waitReady(session) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (fs.existsSync(session.playlistPath)) return resolve();
      if (session.error) return reject(httpError(500, session.error));
      if (session.done) return reject(httpError(500, '转码结束但未生成播放列表'));
      if (Date.now() - start > READY_TIMEOUT_MS) {
        return reject(httpError(504, '转码超时：等待首个分片超过 ' + Math.round(READY_TIMEOUT_MS / 1000) + ' 秒'));
      }
      setTimeout(tick, 250);
    };
    tick();
  });
}

/** 确保存在可用的转码会话 */
async function ensureSession(video) {
  const videoId = Number(video.id);
  const st = fs.statSync(video.file_path);
  const mtime = Math.floor(st.mtimeMs);

  const existing = sessions.get(videoId);
  if (existing && existing.mtime === mtime && !existing.error) {
    existing.lastAccess = Date.now();
    await waitReady(existing);
    return existing;
  }
  if (existing) destroySession(videoId);

  // 并发上限：回收最久未使用的转码会话
  while (activeTranscodes() >= MAX_TRANSCODES) {
    const victim = Array.from(sessions.values())
      .filter((s) => !s.done)
      .sort((a, b) => a.lastAccess - b.lastAccess)[0];
    if (!victim) break;
    logger.warn('[hls] 转码并发已达上限，回收 video #' + victim.videoId);
    destroySession(victim.videoId);
  }

  const session = startSession(video, mtime);
  sessions.set(videoId, session);
  await waitReady(session);
  return session;
}

/* ------------------------------------------------------------------ *
 * 播放列表输出
 * ------------------------------------------------------------------ */

/** 转码中使用的合成 VOD 播放列表：时长已知 → 前端可立即拖拽 */
function syntheticPlaylist(video) {
  const duration = Number(video.duration) || 0;
  const count = Math.max(1, Math.ceil(duration / SEGMENT_TIME));
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:' + SEGMENT_TIME,
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
  ];
  for (let i = 0; i < count; i += 1) {
    const isLast = i === count - 1;
    let d = SEGMENT_TIME;
    if (isLast && duration > 0) {
      const rest = duration - i * SEGMENT_TIME;
      if (rest > 0) d = rest;
    }
    lines.push('#EXTINF:' + d.toFixed(3) + ',');
    lines.push(hlsUrl(video.id, 'seg_' + String(i).padStart(5, '0') + '.ts'));
  }
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n') + '\n';
}

/**
 * 取该视频的 HLS 播放列表文本。
 * 本地 m3u8 → 重写；其它 → 按需转码。
 */
async function getPlaylist(video) {
  if (isLocalPlaylist(video.file_path)) {
    const text = readPlaylist(video.file_path);
    return rewritePlaylist(text, localMapper(video.id));
  }

  const session = await ensureSession(video);
  session.lastAccess = Date.now();

  if (session.done && !session.error) {
    // 转码完成：ffmpeg 自己写的列表时长精确
    return rewritePlaylist(readPlaylist(session.playlistPath), localMapper(video.id));
  }
  if (Number(video.duration) > 0) {
    return syntheticPlaylist(video);
  }
  // 时长未知（极少见）：退回 ffmpeg 正在增长的列表
  return rewritePlaylist(readPlaylist(session.playlistPath), localMapper(video.id));
}

/* ------------------------------------------------------------------ *
 * 分片 / 子播放列表输出
 * ------------------------------------------------------------------ */

/** 相对路径 → 绝对路径（带路径穿越防护） */
function resolveTarget(video, rel) {
  const clean = normalizeRel(decodeURIComponentSafe(rel));
  if (!clean) return null;

  if (isLocalPlaylist(video.file_path)) {
    const root = path.dirname(video.file_path);
    const abs = path.resolve(root, clean);
    return isWithin(root, abs) ? { abs, root } : null;
  }

  const session = sessions.get(Number(video.id));
  if (!session) return null;
  const abs = path.resolve(session.dir, clean);
  return isWithin(session.dir, abs) ? { abs, root: session.dir, session } : null;
}

function decodeURIComponentSafe(v) {
  try {
    return decodeURIComponent(String(v || ''));
  } catch (_) {
    return String(v || '');
  }
}

/** 等文件生成且写入稳定 */
async function waitForFile(file, session, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    let st = null;
    try {
      st = fs.statSync(file);
    } catch (_) { /* 还没生成 */ }

    if (st && st.size > 0) {
      // 转码中的最新分片可能仍在写入，再确认一次大小是否稳定
      if (!session || session.done) return true;
      await sleep(250);
      try {
        if (fs.statSync(file).size === st.size) return true;
      } catch (_) { /* ignore */ }
      continue;
    }

    if (session && session.done) return false;
    await sleep(200);
  }
  return false;
}

function contentTypeFor(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.ts') return 'video/mp2t';
  if (ext === '.m4s' || ext === '.mp4') return 'video/mp4';
  if (ext === '.aac') return 'audio/aac';
  if (ext === '.key') return 'application/octet-stream';
  return mimeType(file);
}

/**
 * 输出 /api/stream/:id/hls/<rel> 指向的资源。
 * @param {(req,res,file,opts)=>void} streamFile 由调用方注入，避免循环依赖
 */
async function serveResource(req, res, video, rel, streamFile) {
  if (!isLocalPlaylist(video.file_path)) {
    // 会话可能已被回收，按需重建
    await ensureSession(video);
  }

  const target = resolveTarget(video, rel);
  if (!target) throw httpError(404, '资源不存在或越界');

  const session = target.session || null;
  const ok = await waitForFile(target.abs, session, RESOURCE_WAIT_MS);
  if (!ok) throw httpError(404, '资源尚未生成');

  const ext = path.extname(target.abs).toLowerCase();

  // 嵌套播放列表（master / 变体）→ 递归重写
  if (PLAYLIST_EXT.includes(ext)) {
    const baseDir = path.dirname(target.abs);
    const body = rewritePlaylist(readPlaylist(target.abs), (uri) => {
      const abs = path.resolve(baseDir, normalizeRel(uri));
      if (!isWithin(target.root, abs)) return null;
      const relOut = path.relative(target.root, abs).split(path.sep).join('/');
      return hlsUrl(video.id, relOut);
    });
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache');
    return res.send(body);
  }

  res.setHeader('Cache-Control', 'public, max-age=3600');
  return streamFile(req, res, target.abs, { contentType: contentTypeFor(target.abs) });
}

/** 当前转码状态（供系统信息 / 调试） */
function getStats() {
  const list = Array.from(sessions.values()).map((s) => ({
    videoId: s.videoId,
    running: !s.done,
    error: s.error,
    dir: s.dir,
  }));
  return { total: list.length, running: activeTranscodes(), sessions: list, workDir: HLS_DIR };
}

module.exports = {
  HLS_DIR,
  SEGMENT_TIME,
  isLocalPlaylist,
  readPlaylist,
  rewritePlaylist,
  localMapper,
  hlsUrl,
  getPlaylist,
  serveResource,
  ensureSession,
  getStats,
  init,
  stopAll,
  destroySession,
};
