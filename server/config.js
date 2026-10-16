'use strict';

/**
 * 全局配置。
 * 所有路径均为绝对路径，供各 service / route 引用。
 */

const path = require('path');
const fs = require('fs');

// 加载 .env（项目根目录）
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// Windows CRT 按 POSIX 语义（符号相反）解析 TZ 环境变量：
// 某些终端/沙箱注入的 "TZ=UTC-1" 会被 SQLite 的 localtime 读成 UTC+1，
// 导致 datetime('now','localtime') 偏差数小时（Node 自己的 Date 走 ICU 不受影响）。
// 删掉它，让 CRT 回退到 Windows 系统时区。
delete process.env.TZ;

const root = path.resolve(__dirname, '..');

// 端口容错：PORT 写了非法值（非整数 / 越界）时不要变成 NaN 交给 listen，
// 否则报错晦涩难懂。这里显式回退 8080 并提示。
const rawPort = process.env.PORT;
const parsedPort = Number(rawPort);
const portValid = Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535;
if (rawPort !== undefined && rawPort !== '' && !portValid) {
  // 此时 logger 还没加载，直接用 console 输出
  console.warn('[警告] PORT=' + rawPort + ' 不是 1~65535 的整数，已回退 8080');
}

const config = {
  root,
  port: portValid ? parsedPort : 8080,
  host: process.env.HOST || '0.0.0.0',

  dataDir: path.join(root, 'data'),
  dbFile: path.join(root, 'data', 'cinenest.db'),
  thumbDir: path.join(root, 'data', 'thumbs'),
  posterDir: path.join(root, 'data', 'posters'),
  spriteDir: path.join(root, 'data', 'sprites'),
  previewDir: path.join(root, 'data', 'previews'),
  hlsDir: path.join(root, 'data', 'hls'),
  errorLog: path.join(root, 'data', 'error.log'),

  // 外部二进制：优先 bin/ffmpeg，缺失时回退系统 PATH（见 resolveBinary）
  ffmpeg: path.join(root, 'bin', 'ffmpeg', 'ffmpeg.exe'),
  ffprobe: path.join(root, 'bin', 'ffmpeg', 'ffprobe.exe'),

  distDir: path.join(root, 'dist'),

  videoExt: [
    '.mp4', '.mkv', '.avi', '.mov', '.wmv',
    '.flv', '.webm', '.m4v', '.ts', '.mpg', '.mpeg',
    '.m3u8', '.m3u',
  ],
  subExt: ['.srt', '.ass', '.vtt'],

  /** HLS 分片后缀：与 .m3u8 同目录时不计为独立视频 */
  hlsSegmentExt: ['.ts', '.m4s', '.aac'],

  timezone: process.env.TZ || 'Asia/Shanghai',
};

/**
 * 解析外部二进制路径：bin/ffmpeg → 系统 PATH。
 * @returns {string|null} 可用路径，或 null
 */
function resolveBinary(binPath, name) {
  if (fs.existsSync(binPath)) return binPath;
  // 回退：在 PATH 中查找同名可执行文件
  const pathExts = (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean);
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of pathExts) {
      const candidate = path.join(dir, name + ext.toLowerCase());
      if (fs.existsSync(candidate)) return candidate;
      const upper = path.join(dir, name + ext.toUpperCase());
      if (fs.existsSync(upper)) return upper;
    }
    const plain = path.join(dir, name);
    if (fs.existsSync(plain)) return plain;
  }
  return null;
}

/**
 * 启动自检：确保 ffmpeg / ffprobe 可用，数据目录存在。
 * 缺失时打印明确错误并退出进程。
 */
function assertEnvironment() {
  // 数据目录
  for (const dir of [config.dataDir, config.thumbDir, config.posterDir, config.spriteDir, config.previewDir]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  const ffmpeg = resolveBinary(config.ffmpeg, 'ffmpeg.exe' === path.basename(config.ffmpeg) ? 'ffmpeg' : 'ffmpeg');
  const ffprobe = resolveBinary(config.ffprobe, 'ffprobe');

  if (!ffmpeg || !ffprobe) {
    const missing = [];
    if (!ffmpeg) missing.push('ffmpeg.exe');
    if (!ffprobe) missing.push('ffprobe.exe');
    console.error('');
    console.error('============================================================');
    console.error('  启动失败：缺少外部依赖 ' + missing.join('、'));
    console.error('------------------------------------------------------------');
    console.error('  请下载 Windows 静态版 FFmpeg，并将可执行文件放到：');
    console.error('    ' + path.join(config.root, 'bin', 'ffmpeg'));
    console.error('');
    console.error('  下载地址（任选其一）：');
    console.error('    https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip');
    console.error('    https://github.com/BtbN/FFmpeg-Builds/releases');
    console.error('');
    console.error('  解压后将 bin/ffmpeg.exe 与 bin/ffprobe.exe 复制到上述目录。');
    console.error('============================================================');
    console.error('');
    process.exit(1);
  }

  config.ffmpeg = ffmpeg;
  config.ffprobe = ffprobe;
  return config;
}

module.exports = config;
module.exports.assertEnvironment = assertEnvironment;
module.exports.resolveBinary = resolveBinary;
