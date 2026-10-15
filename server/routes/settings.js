'use strict';

/**
 * 设置 API。见 开发任务书 5.9。
 * 附加：清空缩略图缓存、备份数据库（设置页系统 Tab 使用）。
 *
 * 权限：
 * - GET  读取：登录即可，但普通用户只返回播放相关（playback.*）偏好
 * - 其余写操作 / 缓存 / 备份 / 系统信息：仅管理员
 */

const express = require('express');
const fs = require('fs');

const db = require('../db');
const config = require('../config');
const logger = require('../utils/logger');
const { clearThumbCache } = require('../services/thumbnail');
const cache = require('../services/cache');
const sprite = require('../services/sprite');
const preview = require('../services/preview');
const hls = require('../services/hls');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

/** 默认设置 */
const DEFAULTS = {
  'playback.volume': '1',
  'playback.autoplay': 'true',
  'playback.rememberProgress': 'true',
};

/** 普通用户可见的设置前缀 */
const USER_VISIBLE_PREFIX = 'playback.';

function readAll() {
  const rows = db.prepare('SELECT key, value FROM setting').all();
  const map = Object.assign({}, DEFAULTS);
  for (const r of rows) map[r.key] = r.value;
  return map;
}

function pickVisible(map, isAdmin) {
  if (isAdmin) return map;
  const out = {};
  for (const [k, v] of Object.entries(map)) {
    if (k.startsWith(USER_VISIBLE_PREFIX)) out[k] = v;
  }
  // 兜底：确保播放偏好一定有值
  for (const [k, v] of Object.entries(DEFAULTS)) {
    if (out[k] === undefined) out[k] = v;
  }
  return out;
}

// 读取
router.get('/', (req, res) => {
  res.json(pickVisible(readAll(), req.user && req.user.role === 'admin'));
});

// 批量更新（仅管理员）
router.patch('/', requireAdmin, (req, res) => {
  const body = req.body || {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ error: '请求体必须为对象' });
  }
  const upsert = db.prepare(
    'INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  const tx = db.transaction((entries) => {
    for (const [k, v] of entries) {
      upsert.run(String(k), v === null || v === undefined ? '' : String(v));
    }
  });
  tx(Object.entries(body));
  res.json({ ok: true });
});

// 清空缩略图缓存（仅管理员）
router.post('/clear-thumbs', requireAdmin, (req, res) => {
  const count = clearThumbCache();
  db.prepare('UPDATE video SET thumb_path = NULL').run();
  logger.info('[settings] 已清空缩略图缓存，共 ' + count + ' 个文件');
  res.json({ ok: true, count });
});

// 回收孤儿缓存（仅管理员，v1.3）
// 删视频 / 删媒体库 / 重扫改名都会留下无主缩略图与精灵图，历史版本漏了这条链路。
router.post('/gc-cache', requireAdmin, (req, res) => {
  const r = cache.sweepOrphans();

  // 顺带修掉「字段还指着、文件已经不在」的失效引用，避免前端拿到坏 URL
  let stale = 0;
  for (const row of db.prepare('SELECT id, sprite_path FROM video WHERE sprite_path IS NOT NULL').all()) {
    let alive = false;
    try { alive = fs.existsSync(row.sprite_path); } catch (_) { alive = false; }
    if (alive) continue;
    db.prepare('UPDATE video SET sprite_path = NULL, sprite_meta = NULL WHERE id = ?').run(row.id);
    stale += 1;
  }

  // 同样修掉悬停预览片段的失效引用（v1.4）
  for (const row of db.prepare('SELECT id, preview_path FROM video WHERE preview_path IS NOT NULL').all()) {
    let alive = false;
    try { alive = fs.existsSync(row.preview_path); } catch (_) { alive = false; }
    if (alive) continue;
    db.prepare('UPDATE video SET preview_path = NULL WHERE id = ?').run(row.id);
    stale += 1;
  }

  res.json({
    ok: true,
    thumbs: r.thumbs,
    sprites: r.sprites,
    previews: r.previews,
    bytes: r.bytes,
    staleRefs: stale,
  });
});

// 备份数据库（仅管理员）
router.get('/backup', requireAdmin, (req, res) => {
  try {
    // 确保 WAL 内容落盘
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch (err) {
    logger.warn('[settings] wal_checkpoint 失败:', err.message);
  }

  if (!fs.existsSync(config.dbFile)) {
    return res.status(404).json({ error: '数据库文件不存在' });
  }

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', 'attachment; filename="cinenest-' + stamp + '.db"');
  fs.createReadStream(config.dbFile).pipe(res);
});

// 数据目录信息（仅管理员）
router.get('/system-info', requireAdmin, (req, res) => {
  let dbSize = 0;
  try { dbSize = fs.statSync(config.dbFile).size; } catch (_) { /* ignore */ }
  let thumbCount = 0;
  try { thumbCount = fs.readdirSync(config.thumbDir).length; } catch (_) { /* ignore */ }

  res.json({
    port: config.port,
    host: config.host,
    root: config.root,
    dataDir: config.dataDir,
    dbFile: config.dbFile,
    dbSize,
    thumbCount,
    ffmpeg: config.ffmpeg,
    ffprobe: config.ffprobe,
    node: process.version,
    platform: process.platform,
    hls: hls.getStats(),
    sprite: sprite.getStats(),
    preview: preview.getStats(),
    cache: cache.stats(),
  });
});

module.exports = router;
