'use strict';

/**
 * 媒体库 API。见 开发任务书 5.1。
 * 另含扫描任务查询（5.8），以独立 router 导出，挂载在 /api/tasks。
 */

const express = require('express');
const fs = require('fs');
const path = require('path');

const db = require('../db');
const watcher = require('../services/watcher');
const scheduler = require('../services/scheduler');
const { scanLibraryById, purgeMissing, getState } = require('../services/scanner');
const { removeThumbFile } = require('../services/thumbnail');
const sprite = require('../services/sprite');
const preview = require('../services/preview');
const { httpError, asyncHandler } = require('../middleware/error');
const { requireAdmin } = require('../middleware/auth');
const { isAbsolutePath } = require('../utils/paths');

const router = express.Router();
const tasks = express.Router();

const DEFAULT_CRON = '0 3 * * *';

/** 校验路径：必须绝对且目录存在；返回规范化后的绝对路径 */
function validatePath(p) {
  if (typeof p !== 'string' || p.trim() === '') {
    throw httpError(400, 'path 不能为空');
  }
  let value = p.trim();
  if (!isAbsolutePath(value)) {
    throw httpError(400, 'path 必须为绝对路径');
  }
  // 规范化：折叠重复分隔符、统一为平台原生分隔符（Windows 保留反斜杠）
  value = path.resolve(value);
  if (!fs.existsSync(value)) {
    throw httpError(400, 'path 目录不存在: ' + value);
  }
  let stat;
  try {
    stat = fs.statSync(value);
  } catch (_) {
    throw httpError(400, 'path 无法访问: ' + value);
  }
  if (!stat.isDirectory()) {
    throw httpError(400, 'path 必须是目录: ' + value);
  }
  return value;
}

// 列表（登录用户均可读，用于侧边栏）
router.get('/', (req, res) => {
  const rows = db
    .prepare(`
      SELECT l.*, (SELECT COUNT(1) FROM video v WHERE v.library_id = l.id) AS video_count
      FROM library l ORDER BY l.id ASC
    `)
    .all();
  res.json(rows);
});

// 新增（仅管理员）
router.post('/', requireAdmin, (req, res) => {
  const { name, path: libPath, scanCron } = req.body || {};
  if (typeof name !== 'string' || name.trim() === '') {
    throw httpError(400, 'name 不能为空');
  }
  const validPath = validatePath(libPath);

  const exists = db.prepare('SELECT id FROM library WHERE path = ?').get(validPath);
  if (exists) throw httpError(400, '该路径已存在: ' + validPath);

  const cron = scanCron && String(scanCron).trim() ? String(scanCron).trim() : DEFAULT_CRON;

  const info = db
    .prepare('INSERT INTO library (name, path, scan_cron, enabled) VALUES (?, ?, ?, 1)')
    .run(name.trim(), validPath, cron);

  const lib = db.prepare('SELECT * FROM library WHERE id = ?').get(info.lastInsertRowid);
  watcher.watchLibrary(lib);
  scheduler.scheduleLibrary(lib);

  res.json({ id: info.lastInsertRowid });
});

// 修改（仅管理员）
router.patch('/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const lib = db.prepare('SELECT * FROM library WHERE id = ?').get(id);
  if (!lib) throw httpError(404, '媒体库不存在');

  const { name, scanCron, enabled } = req.body || {};
  const next = {
    name: typeof name === 'string' && name.trim() ? name.trim() : lib.name,
    scan_cron:
      typeof scanCron === 'string' && scanCron.trim() ? scanCron.trim() : lib.scan_cron,
    enabled:
      enabled === undefined || enabled === null ? lib.enabled : (enabled ? 1 : 0),
  };

  db.prepare('UPDATE library SET name = ?, scan_cron = ?, enabled = ? WHERE id = ?')
    .run(next.name, next.scan_cron, next.enabled, id);

  const updated = db.prepare('SELECT * FROM library WHERE id = ?').get(id);

  scheduler.unscheduleLibrary(id);
  watcher.unwatchLibrary(id).then(() => {
    if (updated.enabled) {
      watcher.watchLibrary(updated);
      scheduler.scheduleLibrary(updated);
    }
  });

  res.json({ ok: true });
});

// 删除（仅管理员）
router.delete('/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const lib = db.prepare('SELECT * FROM library WHERE id = ?').get(id);
  if (!lib) throw httpError(404, '媒体库不存在');

  // 先取出该库视频的缓存引用：删库会级联删 video 行，之后再查就拿不到路径了
  const videos = db.prepare('SELECT id, thumb_path FROM video WHERE library_id = ?').all(id);

  db.prepare('DELETE FROM library WHERE id = ?').run(id);

  // 派生缓存跟着走，避免留下孤儿文件（v1.3 / v1.4）
  for (const v of videos) {
    removeThumbFile(v.thumb_path);
    sprite.removeSprites(v.id);
    preview.removePreviews(v.id);
  }

  scheduler.unscheduleLibrary(id);
  watcher.unwatchLibrary(id);

  res.json({ ok: true, cleaned: videos.length });
});

// 立即扫描（仅管理员）
router.post('/:id/scan', requireAdmin, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const lib = db.prepare('SELECT * FROM library WHERE id = ?').get(id);
  if (!lib) throw httpError(404, '媒体库不存在');
  // 停用的库不允许手动扫描（与 watcher / scheduler 的 enabled=1 过滤保持一致）
  if (!lib.enabled) throw httpError(400, '该媒体库已停用，请先启用后再扫描');

  const result = await scanLibraryById(id);
  res.json(result);
}));

// 确认清理：无视删除闸门，删除该库内文件已不存在的记录（仅管理员，v1.3）
router.post('/:id/purge-missing', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const lib = db.prepare('SELECT * FROM library WHERE id = ?').get(id);
  if (!lib) throw httpError(404, '媒体库不存在');

  res.json(purgeMissing(id));
});

// ---------- 扫描任务（5.8） ----------

// 最近 50 条扫描日志
tasks.get('/', (req, res) => {
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const rows = db
    .prepare(`
      SELECT s.*, l.name AS library_name
      FROM scan_log s
      LEFT JOIN library l ON l.id = s.library_id
      ORDER BY s.id DESC
      LIMIT ?
    `)
    .all(limit);
  res.json(rows);
});

// 当前是否有扫描在进行
tasks.get('/running', (req, res) => {
  res.json(getState());
});

module.exports = { router, tasks };
