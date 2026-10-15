'use strict';

/**
 * 字幕：查找视频同名字幕并转为 WebVTT。
 * 见 开发任务书 5.3 / 7.5。
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const config = require('../config');
const logger = require('../utils/logger');

/**
 * 在视频同目录查找同名字幕文件。
 * @param {string} videoPath
 * @returns {string|null} 字幕文件绝对路径
 */
function findSubtitle(videoPath) {
  const dir = path.dirname(videoPath);
  const base = path.basename(videoPath, path.extname(videoPath));
  for (const ext of config.subExt) {
    const candidate = path.join(dir, base + ext);
    if (fs.existsSync(candidate)) return candidate;
    // 大小写变体（Windows 不敏感，但保险起见）
    const upper = path.join(dir, base + ext.toUpperCase());
    if (fs.existsSync(upper)) return upper;
  }
  return null;
}

/**
 * 将字幕转为 WebVTT 文本。
 * .vtt 直接读取；.srt/.ass 用 ffmpeg 转。
 * @param {string} subPath
 * @returns {Promise<string>}
 */
function toVtt(subPath) {
  return new Promise((resolve, reject) => {
    const ext = path.extname(subPath).toLowerCase();

    if (ext === '.vtt') {
      try {
        let text = fs.readFileSync(subPath, 'utf8');
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
        if (!/^WEBVTT/.test(text.trim())) {
          text = 'WEBVTT\n\n' + text;
        }
        return resolve(text);
      } catch (err) {
        return reject(err);
      }
    }

    // srt / ass → vtt（输出到 stdout）
    const args = ['-v', 'error', '-i', subPath, '-f', 'webvtt', '-'];
    let stdout = '';
    let stderr = '';
    const child = spawn(config.ffmpeg, args, { windowsHide: true });
    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        logger.warn('[subtitle] 转换失败(' + code + '):', subPath, stderr.trim().slice(0, 200));
        return reject(new Error('字幕转换失败'));
      }
      let text = stdout;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      if (!/^WEBVTT/.test(text.trim())) text = 'WEBVTT\n\n' + text;
      resolve(text);
    });
  });
}

module.exports = { findSubtitle, toVtt };
