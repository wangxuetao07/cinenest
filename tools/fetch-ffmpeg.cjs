'use strict';

/**
 * FFmpeg 获取器 —— 供打包器在缺少 bin/ffmpeg 时自动补齐。
 *
 * 为什么单独成文件：bin/ffmpeg/ 下的两个 exe 合计约 337MB，且单文件远超 GitHub 的
 * 100MB 上限，因此不入版本库。新克隆的仓库要打离线包时，本模块负责把 FFmpeg 拉回来。
 *
 * 注意：包内启动器 launcher.cjs 里有一份**功能等价的内联实现**（启动器必须自包含，
 * 不能 require 外部文件，所以那部分是内联源码）。两边镜像列表与行为需保持一致，
 * 改动其中一处请同步另一处。本模块不依赖任何第三方包，只用 Node 内置能力。
 */

const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const http = require('http');
const https = require('https');

const IS_WIN = process.platform === 'win32';

/** 镜像顺序：环境变量追加的源优先（便于内网镜像），其后为公开源 */
const DEFAULT_MIRRORS = [
  'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
  'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip',
];

/** 环境变量 CINENEST_FFMPEG_MIRROR 可追加自定义源，多个用 | 分隔 */
function mirrorList() {
  const extra = (process.env.CINENEST_FFMPEG_MIRROR || '')
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);
  return extra.concat(DEFAULT_MIRRORS);
}

/** 目录里是否已有可用的 FFmpeg（两个可执行文件都在且体积正常） */
function ffmpegReady(dir) {
  try {
    const f = path.join(dir, IS_WIN ? 'ffmpeg.exe' : 'ffmpeg');
    const p = path.join(dir, IS_WIN ? 'ffprobe.exe' : 'ffprobe');
    const min = 1024 * 1024;
    return fs.statSync(f).size > min && fs.statSync(p).size > min;
  } catch (_) {
    return false;
  }
}

/** 下载文件（跟随重定向 + 进度回调） */
function download(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const visit = (u, depth) => {
      if (depth > 6) return reject(new Error('重定向次数过多'));
      let mod;
      try {
        mod = new URL(u).protocol === 'http:' ? http : https;
      } catch (err) {
        return reject(err);
      }
      const req = mod.get(u, { headers: { 'User-Agent': 'CineNest-Packager' } }, (res) => {
        const code = res.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
          res.resume();
          return visit(new URL(res.headers.location, u).toString(), depth + 1);
        }
        if (code !== 200) {
          res.resume();
          return reject(new Error('HTTP ' + code));
        }
        const total = Number(res.headers['content-length'] || 0);
        let got = 0;
        const out = fs.createWriteStream(dest);
        res.on('data', (chunk) => {
          got += chunk.length;
          if (onProgress) onProgress(got, total);
        });
        res.on('error', reject);
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve(dest)));
        out.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(120000, () => req.destroy(new Error('连接超时（120 秒）')));
    };
    visit(url, 0);
  });
}

/** 解压 zip：优先用 tar（bsdtar 支持 zip），失败回退 PowerShell Expand-Archive */
function extractZip(zipFile, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const sysTar = IS_WIN
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    : '';
  const tarExe = sysTar && fs.existsSync(sysTar) ? sysTar : 'tar';
  let r = cp.spawnSync(tarExe, ['-xf', zipFile, '-C', destDir], { stdio: 'ignore' });
  if (r.status === 0) return true;
  if (!IS_WIN) return false;
  r = cp.spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    'Expand-Archive -LiteralPath "' + zipFile + '" -DestinationPath "' + destDir + '" -Force',
  ], { stdio: 'ignore' });
  return r.status === 0;
}

/** 递归查找文件（限制深度，避免在超大解压目录里白跑） */
function findFileDeep(dir, name, depth) {
  if ((depth || 0) > 6) return null;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return null;
  }
  for (const e of entries) {
    if (e.isFile() && e.name.toLowerCase() === name.toLowerCase()) return path.join(dir, e.name);
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      const found = findFileDeep(path.join(dir, e.name), name, (depth || 0) + 1);
      if (found) return found;
    }
  }
  return null;
}

function rmrf(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch (_) {
    /* ignore */
  }
}

/**
 * 下载并放置 FFmpeg。
 * @param {object} opts
 * @param {string} opts.destDir  目标目录（ffmpeg.exe / ffprobe.exe 落在这里）
 * @param {string} [opts.cacheDir] 下载与解压的临时目录
 * @param {(msg:string)=>void} [opts.log] 日志回调
 * @returns {Promise<boolean>} 是否成功
 */
async function fetchFfmpeg(opts) {
  const destDir = opts.destDir;
  const cacheDir = opts.cacheDir || path.join(path.dirname(destDir), '.cache');
  const log = opts.log || (() => {});
  const mirrors = mirrorList();
  const zipFile = path.join(cacheDir, 'ffmpeg.zip');
  const extractDir = path.join(cacheDir, 'extract');

  for (let i = 0; i < mirrors.length; i += 1) {
    try {
      fs.mkdirSync(cacheDir, { recursive: true });
      log('  [..]   正在下载 FFmpeg（约 80~150MB，仅首次需要）...');
      let lastTick = 0;
      await download(mirrors[i], zipFile, (got, total) => {
        const now = Date.now();
        if (now - lastTick < 500) return;
        lastTick = now;
        const mb = (got / 1048576).toFixed(1);
        const pct = total ? '  ' + ((got / total) * 100).toFixed(0) + '%' : '';
        process.stdout.write('\r         ' + mb + ' MB' + pct + '        ');
      });
      process.stdout.write('\r' + ' '.repeat(40) + '\r');

      const size = fs.statSync(zipFile).size;
      if (size < 1024 * 1024) throw new Error('文件过小，可能不是有效压缩包');

      log('  [..]   正在解压 FFmpeg ...');
      if (!extractZip(zipFile, extractDir)) throw new Error('解压失败');

      const ffmpeg = findFileDeep(extractDir, IS_WIN ? 'ffmpeg.exe' : 'ffmpeg');
      const ffprobe = findFileDeep(extractDir, IS_WIN ? 'ffprobe.exe' : 'ffprobe');
      if (!ffmpeg || !ffprobe) throw new Error('压缩包内未找到 ffmpeg / ffprobe');

      fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(ffmpeg, path.join(destDir, IS_WIN ? 'ffmpeg.exe' : 'ffmpeg'));
      fs.copyFileSync(ffprobe, path.join(destDir, IS_WIN ? 'ffprobe.exe' : 'ffprobe'));
      log('  [OK]   FFmpeg 已就绪：' + destDir);
      rmrf(cacheDir);
      return true;
    } catch (err) {
      log('  [!]    镜像 ' + (i + 1) + ' 失败：' + err.message);
      // 只清理本次的半成品，保留 cache 目录本身，否则下一个镜像会因目录不存在直接失败
      try { fs.rmSync(zipFile, { force: true }); } catch (_) { /* ignore */ }
      rmrf(extractDir);
    }
  }

  rmrf(cacheDir);
  return false;
}

module.exports = { fetchFfmpeg, ffmpegReady, mirrorList, findFileDeep, extractZip };
