'use strict';

/**
 * 目录监听：文件变动后防抖触发扫描。
 * 见 开发任务书 7.6。
 */

const chokidar = require('chokidar');
const db = require('../db');
const logger = require('../utils/logger');
const { scanLibrary } = require('./scanner');
const { toPosix, isVideoExt } = require('../utils/paths');

const DEBOUNCE_MS = 3000;

/** 程序内部改动（重命名等）后，忽略 watcher 事件的窗口 */
const SUPPRESS_MS = 20000;

/** libraryId → { watcher, timer, suppressUntil } */
const watchers = new Map();

/**
 * 声明「接下来这段时间内的文件变动是程序自己造成的」（v1.4.8）。
 *
 * 重命名改了磁盘路径但库里的记录已经同步更新，再触发一次扫描纯属浪费；
 * 更糟的是扫描期间改名会被 409 挡下，管理员连续改几个名字就会撞上。
 * 调用方只需在完成内部改动后声明一次，本库在窗口内的 watcher 事件全部忽略。
 */
function suppress(libraryId, ms = SUPPRESS_MS) {
  const entry = watchers.get(Number(libraryId));
  if (!entry) return false;
  entry.suppressUntil = Date.now() + ms;
  return true;
}

function scheduleScan(library) {
  const entry = watchers.get(library.id);
  if (!entry) return;
  if (entry.suppressUntil && Date.now() < entry.suppressUntil) {
    logger.info('[watcher] 忽略本次变动（程序内部操作导致）#' + library.id);
    return;
  }
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(async () => {
    entry.timer = null;
    try {
      logger.scan('[watcher] 检测到变动，触发扫描 #' + library.id);
      await scanLibrary(library);
    } catch (err) {
      logger.error('[watcher] 扫描失败:', err.message);
    }
  }, DEBOUNCE_MS);
}

/** 为单个启用的媒体库启动监听 */
function watchLibrary(library) {
  if (!library || !library.enabled) return;
  if (watchers.has(library.id)) return;

  const ignore = [
    /(^|[/\\])\../,
    /@eaDir/,
    /\$RECYCLE\.BIN/,
    /System Volume Information/,
  ];

  const watcher = chokidar.watch(toPosix(library.path), {
    ignoreInitial: true,
    followSymlinks: false,
    ignored: ignore,
    awaitWriteFinish: { stabilityThreshold: 5000, pollInterval: 200 },
    depth: 10,
  });

  watcher
    .on('add', (p) => { if (isVideoExt(p)) scheduleScan(library); })
    .on('unlink', (p) => { if (isVideoExt(p)) scheduleScan(library); })
    .on('change', (p) => { if (isVideoExt(p)) scheduleScan(library); })
    .on('error', (err) => logger.error('[watcher] 错误 #' + library.id, err.message));

  watchers.set(library.id, { watcher, timer: null, suppressUntil: 0, library });
  logger.info('[watcher] 已监听媒体库 #' + library.id + ' ' + library.path);
}

/** 停止单个库的监听 */
async function unwatchLibrary(libraryId) {
  const entry = watchers.get(libraryId);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  try { await entry.watcher.close(); } catch (_) { /* ignore */ }
  watchers.delete(libraryId);
}

/** 启动全部启用库的监听 */
function startAll() {
  const libs = db.prepare('SELECT * FROM library WHERE enabled = 1').all();
  for (const lib of libs) watchLibrary(lib);
  logger.info('[watcher] 启动完成，共监听 ' + libs.length + ' 个媒体库');
}

/** 关闭全部监听 */
async function stopAll() {
  const ids = Array.from(watchers.keys());
  for (const id of ids) await unwatchLibrary(id);
}

module.exports = { startAll, stopAll, watchLibrary, unwatchLibrary, scheduleScan, suppress };
