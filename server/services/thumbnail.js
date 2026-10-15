'use strict';

/**
 * 缩略图生成。
 * 命名：md5(file_path) + '.jpg'；已存在直接返回；失败返回 null，不抛异常。
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const config = require('../config');
const logger = require('../utils/logger');
const { md5 } = require('../utils/paths');

/** 缩略图输出绝对路径 */
function thumbPathFor(filePath) {
  return path.join(config.thumbDir, md5(filePath) + '.jpg');
}

/**
 * 生成缩略图。
 * @param {string} filePath 视频绝对路径
 * @param {number} duration 视频时长（秒）
 * @returns {Promise<string|null>} 缩略图绝对路径 / null
 */
async function makeThumb(filePath, duration) {
  const out = thumbPathFor(filePath);

  // 缓存命中
  try {
    if (fs.existsSync(out) && fs.statSync(out).size > 0) return out;
  } catch (_) { /* ignore */ }

  if (!fs.existsSync(config.thumbDir)) {
    fs.mkdirSync(config.thumbDir, { recursive: true });
  }

  // seek 时间：max(1, min(duration*0.1, 30))
  const d = Number(duration) > 0 ? Number(duration) : 0;
  const seek = String(Math.max(1, Math.min(d * 0.1, 30)));

  const args = [
    '-ss', seek,
    '-i', filePath,
    '-frames:v', '1',
    '-vf', 'scale=480:-1',
    '-q:v', '4',
    '-y', out,
  ];

  return new Promise((resolve) => {
    let stderr = '';
    const child = spawn(config.ffmpeg, args, { windowsHide: true });
    child.stderr.on('data', (dd) => { stderr += dd.toString('utf8'); });
    child.on('error', (err) => {
      logger.warn('[thumbnail] spawn 失败:', filePath, err.message);
      resolve(null);
    });
    child.on('close', (code) => {
      if (code !== 0) {
        logger.warn('[thumbnail] 生成失败(' + code + '):', filePath, stderr.trim().slice(0, 200));
        return resolve(null);
      }
      try {
        if (fs.existsSync(out) && fs.statSync(out).size > 0) return resolve(out);
      } catch (_) { /* ignore */ }
      resolve(null);
    });
  });
}

/** 删除缩略图缓存文件 */
function removeThumb(filePath) {
  try {
    const p = thumbPathFor(filePath);
    if (fs.existsSync(p)) fs.rmSync(p, { force: true });
  } catch (_) { /* ignore */ }
}

/**
 * 按绝对路径删除缩略图（v1.3）。
 * 删视频 / 删媒体库时直接拿库里的 thumb_path 删，比按 file_path 重算 md5 更可靠。
 */
function removeThumbFile(absPath) {
  if (!absPath) return false;
  try {
    if (fs.existsSync(absPath)) {
      fs.rmSync(absPath, { force: true });
      return true;
    }
  } catch (_) { /* ignore */ }
  return false;
}

/** 清空缩略图缓存目录 */
function clearThumbCache() {
  let count = 0;
  try {
    if (!fs.existsSync(config.thumbDir)) return 0;
    for (const f of fs.readdirSync(config.thumbDir)) {
      try {
        fs.rmSync(path.join(config.thumbDir, f), { force: true });
        count += 1;
      } catch (_) { /* ignore */ }
    }
  } catch (_) { /* ignore */ }
  return count;
}

module.exports = { makeThumb, thumbPathFor, removeThumb, removeThumbFile, clearThumbCache };
