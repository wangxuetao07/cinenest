'use strict';

/**
 * ffprobe 封装。
 * 严格使用 spawn + 参数数组，禁止字符串拼接（中文路径/空格安全）。
 */

const { spawn } = require('child_process');
const config = require('../config');

/**
 * 探测视频元数据。
 * @param {string} filePath 绝对路径
 * @returns {Promise<{duration:number,bitrate:number,width:number,height:number,videoCodec:string|null,audioCodec:string|null}>}
 */
function probe(filePath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath,
    ];

    let stdout = '';
    let stderr = '';

    const child = spawn(config.ffprobe, args, { windowsHide: true });

    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });

    child.on('error', (err) => reject(err));

    child.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error('ffprobe 退出码 ' + code + (stderr ? ': ' + stderr.trim() : '')));
      }
      let json;
      try {
        json = JSON.parse(stdout);
      } catch (e) {
        return reject(new Error('ffprobe 输出解析失败: ' + e.message));
      }

      const streams = Array.isArray(json.streams) ? json.streams : [];
      const v = streams.find((s) => s.codec_type === 'video');
      const a = streams.find((s) => s.codec_type === 'audio');
      const format = json.format || {};

      const duration = parseFloat(format.duration) || (v && parseFloat(v.duration)) || 0;
      const bitrate = parseInt(format.bit_rate, 10) || (v && parseInt(v.bit_rate, 10)) || 0;

      resolve({
        duration: Number.isFinite(duration) ? duration : 0,
        bitrate: Number.isFinite(bitrate) ? bitrate : 0,
        width: v && Number(v.width) ? Number(v.width) : 0,
        height: v && Number(v.height) ? Number(v.height) : 0,
        videoCodec: (v && v.codec_name) || null,
        audioCodec: (a && a.codec_name) || null,
      });
    });
  });
}

module.exports = { probe };
