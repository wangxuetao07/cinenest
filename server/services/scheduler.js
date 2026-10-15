'use strict';

/**
 * 定时扫描：按 library.scan_cron 注册 node-cron 任务。
 * 见 开发任务书 7.7。
 */

const cron = require('node-cron');
const db = require('../db');
const config = require('../config');
const logger = require('../utils/logger');
const { scanLibrary } = require('./scanner');

/** libraryId → cron task */
const tasks = new Map();

/** 为单个库注册定时任务 */
function scheduleLibrary(library) {
  if (!library || !library.enabled) return;
  const expr = (library.scan_cron || '').trim();
  if (!expr || !cron.validate(expr)) {
    logger.warn('[scheduler] 无效的 cron 表达式，跳过 #' + library.id + ':', expr);
    return;
  }
  const task = cron.schedule(
    expr,
    async () => {
      try {
        logger.scan('[scheduler] 定时扫描触发 #' + library.id);
        await scanLibrary(library);
      } catch (err) {
        logger.error('[scheduler] 定时扫描失败:', err.message);
      }
    },
    { scheduled: true, timezone: config.timezone }
  );
  tasks.set(library.id, task);
  logger.info('[scheduler] 已注册定时扫描 #' + library.id + ' → ' + expr);
}

/** 取消单个库的定时任务 */
function unscheduleLibrary(libraryId) {
  const task = tasks.get(libraryId);
  if (task) {
    try { task.stop(); } catch (_) { /* ignore */ }
    tasks.delete(libraryId);
  }
}

/** 启动：注册所有启用库 */
function startAll() {
  const libs = db.prepare('SELECT * FROM library WHERE enabled = 1').all();
  for (const lib of libs) scheduleLibrary(lib);
  logger.info('[scheduler] 启动完成，共注册 ' + libs.length + ' 个定时任务');
}

/** 关闭全部定时任务 */
function stopAll() {
  for (const [id, task] of tasks) {
    try { task.stop(); } catch (_) { /* ignore */ }
    void id;
  }
  tasks.clear();
}

module.exports = { startAll, stopAll, scheduleLibrary, unscheduleLibrary };
