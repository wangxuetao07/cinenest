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

/** libraryId → { watcher, timer } */
const watchers = new Map();

function scheduleScan(library) {
  const entry = watchers.get(library.id);
  if (!entry) return;
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

  watchers.set(library.id, { watcher, timer: null, library });
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

module.exports = { startAll, stopAll, watchLibrary, unwatchLibrary, scheduleScan };
