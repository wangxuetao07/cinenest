'use strict';

/**
 * better-sqlite3 是原生（C++）模块，Node 每个大版本的 ABI 编号不同
 * （process.versions.modules，如 20→115、22→127、24→137）。
 * ABI 不匹配时 require 不出错，但第一次 new Database() 会抛
 *   ERR_DLOPEN_FAILED: NODE_MODULE_VERSION 127 ... requires 137
 *
 * 仓库里的 vendor/sqlite3/ 预置了多个 ABI 的预编译二进制。这里在加载原生模块
 * 之前，把「当前 Node 对应的那一份」落位到 node_modules，于是：
 *   - 换 Node 大版本后 npm run dev 直接可用，不必 npm rebuild；
 *   - 不需要联网（不依赖 GitHub 预编译包）；
 *   - 不需要本机有 C++ 编译环境。
 *
 * 部署包内同理：包里的 server/ 与本文件一起分发，启动后自动适配目标机 Node。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const ABI = process.versions.modules;
const KEY = 'node-v' + ABI + '-' + process.platform + '-' + process.arch;

const VENDOR_DIR = path.join(ROOT, 'vendor', 'sqlite3');
const VENDOR_FILE = path.join(VENDOR_DIR, KEY, 'better_sqlite3.node');
const TARGET_FILE = path.join(ROOT, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');

/** 两个文件是否内容一致（先比体积，一致再比 sha1，省掉大文件哈希） */
function sameFile(a, b) {
  try {
    if (fs.statSync(a).size !== fs.statSync(b).size) return false;
    const digest = (p) => crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
    return digest(a) === digest(b);
  } catch (_) {
    return false;
  }
}

/** vendor 中可用的 ABI 列表，用于提示信息 */
function availableAbis() {
  try {
    return fs
      .readdirSync(VENDOR_DIR)
      .filter((n) => /^node-v\d+-win32-x64$/.test(n))
      .map((n) => n.replace(/^node-v(\d+)-win32-x64$/, '$1'))
      .sort((a, b) => Number(a) - Number(b));
  } catch (_) {
    return [];
  }
}

/**
 * 把当前 Node ABI 对应的原生模块落位到 node_modules。
 * 失败不抛错——真正的加载错误由调用方捕获并交给 abiHint() 转成可操作提示。
 * @returns {{state:'match'|'switched'|'no-vendor'|'failed', key?:string, error?:Error}}
 */
function ensureNativeAbi() {
  if (fs.existsSync(VENDOR_FILE) && sameFile(VENDOR_FILE, TARGET_FILE)) {
    return { state: 'match', key: KEY };
  }
  if (!fs.existsSync(VENDOR_FILE)) {
    // 没有对应 ABI 的备份：可能是在非 win32-x64 平台，或 vendor 未随仓库带上
    return { state: 'no-vendor', key: KEY };
  }
  try {
    fs.mkdirSync(path.dirname(TARGET_FILE), { recursive: true });
    fs.copyFileSync(VENDOR_FILE, TARGET_FILE);
    return { state: 'switched', key: KEY };
  } catch (err) {
    return { state: 'failed', key: KEY, error: err };
  }
}

/**
 * 判断错误是否为原生模块 ABI 不匹配，是则返回带排查步骤的完整提示。
 * @param {Error} err
 * @returns {string}
 */
function abiHint(err) {
  const raw = (err && (err.message || String(err))) || '';
  const isAbi = err && (err.code === 'ERR_DLOPEN_FAILED' || /NODE_MODULE_VERSION/.test(raw));
  if (!isAbi) return raw;

  const need = /NODE_MODULE_VERSION (\d+)/.exec(raw);
  const have = /requires NODE_MODULE_VERSION (\d+)/.exec(raw);
  const lines = [
    'better-sqlite3 原生模块与当前 Node.js 版本不匹配：',
    '  模块编译时 ABI ' + (need ? need[1] : '?') + '，当前 Node.js ' + process.version + ' 需要 ABI ' + (have ? have[1] : ABI),
    '',
    '  本仓库已内置多版本二进制，正常情况下会自动适配。出现此提示说明自动适配没成功：',
    '    1. 确认 vendor/sqlite3/node-v' + ABI + '-' + process.platform + '-' + process.arch + '/better_sqlite3.node 存在；',
    '    2. 若该目录被占用（本地已有服务在跑），先关掉再重试；',
    '    3. 仍不行就执行 npm install（需联网；vendor 中缺这个 ABI 时才会用到）。',
  ];
  const abis = availableAbis();
  if (abis.length) lines.push('  vendor 中现有的 ABI：' + abis.join(' / ') + '（当前需要 ' + ABI + '）');
  return lines.join('\n');
}

/**
 * 启动时调用：自适应并在发生切换时打印一行日志。
 * 注意必须在 require('better-sqlite3') 之前调用。
 */
function setupNativeAbi(logger) {
  const r = ensureNativeAbi();
  const say = (msg) => (logger && typeof logger.info === 'function' ? logger.info(msg) : console.log(msg));
  if (r.state === 'switched') {
    say('[native] better-sqlite3 原生模块已切换为当前 Node.js 对应的 ' + r.key + '（ABI ' + ABI + '）');
  } else if (r.state === 'no-vendor') {
    say('[native] 未找到 ' + r.key + ' 的预编译二进制，沿用 node_modules 中现有模块');
  } else if (r.state === 'failed') {
    say('[native] 无法写入原生模块（' + (r.error && r.error.code) + '），沿用现有模块');
  }
  return r;
}

module.exports = { ensureNativeAbi, setupNativeAbi, abiHint, availableAbis, KEY, ABI };
