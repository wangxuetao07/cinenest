'use strict';

/**
 * 路径 / 媒体类型 / 序列化 工具。
 */

const os = require('os');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');

/** Windows 反斜杠 → 正斜杠（供 fast-glob 使用） */
function toPosix(p) {
  return p.replace(/\\/g, '/');
}

/** 去掉扩展名，返回纯文件名 */
function basename(p) {
  return path.basename(p, path.extname(p));
}

/** md5(字符串) */
function md5(input) {
  return crypto.createHash('md5').update(input, 'utf8').digest('hex');
}

/** 是否绝对路径（兼容 Windows 盘符） */
function isAbsolutePath(p) {
  if (!p || typeof p !== 'string') return false;
  if (path.isAbsolute(p)) return true;
  return /^[a-zA-Z]:[\\/]/.test(p);
}

/**
 * 路径穿越防护：target 必须位于 root 之内。
 * 两者先 resolve 再比较。
 */
function isWithin(root, target) {
  const r = path.resolve(root);
  const t = path.resolve(target);
  const rel = path.relative(r, t);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

const VIDEO_MIME = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.ts': 'video/mp2t',
  '.flv': 'video/x-flv',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.m3u': 'audio/x-mpegurl',
};

/** 扩展名 → MIME，未知返回 application/octet-stream */
function mimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return VIDEO_MIME[ext] || 'application/octet-stream';
}

function isVideoExt(ext) {
  return config.videoExt.includes(String(ext || '').toLowerCase());
}

function isSubExt(ext) {
  return config.subExt.includes(String(ext || '').toLowerCase());
}

/**
 * 将数据库 video 行序列化为 API 输出：
 * thumb_path / poster_path 转为对外 API 路径，隐藏磁盘绝对路径。
 *
 * v1.3：URL 追加 ?v=<mtime> 作为缓存指纹。缩略图响应头不再依赖 max-age
 * 做唯一判据，源文件被替换（mtime 变）后 URL 随之变化，浏览器立刻取新图，
 * 不会出现「重扫后还显示旧缩略图」。
 */
function serializeVideo(row) {
  if (!row) return null;
  const out = Object.assign({}, row);
  out.favorite = row.favorite ? 1 : 0;
  const v = Number(row.mtime) || 0;
  out.thumb_path = '/api/thumb/' + row.id + '?v=' + v;
  out.poster_path = '/api/poster/' + row.id + '?v=' + v;
  // v1.4：卡片悬停预览片段（未生成为 null，前端悬停时调 info 接口触发懒生成）
  out.preview_path = row.preview_path ? '/api/preview/' + row.id + '?v=' + v : null;
  delete out.__has_thumb;
  return out;
}

/** 生成同名剧集分组的 key：目录 + 文件名前缀（去掉末尾季集号） */
function episodeKey(filePath) {
  const dir = path.dirname(filePath);
  let name = basename(filePath);
  name = name
    .replace(/[\s._-]*(s\d{1,2}e\d{1,3})/gi, '')
    .replace(/[\s._-]*(ep?\s?\d{1,3})$/gi, '')
    .replace(/[\s._-]*第\s?\d{1,3}\s?[集话]/g, '')
    .replace(/[\s._-]*\d{1,3}$/, '')
    .trim();
  return toPosix(dir) + '::' + (name || basename(filePath));
}

module.exports = {
  toPosix,
  basename,
  md5,
  isAbsolutePath,
  isWithin,
  mimeType,
  isVideoExt,
  isSubExt,
  serializeVideo,
  episodeKey,
  VIDEO_MIME,
};
