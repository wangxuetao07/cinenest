'use strict';

/**
 * 历史与进度 API。见 开发任务书 5.4。
 * v1.2：观看进度 / 历史按账号隔离（user_video_state）。
 */

const express = require('express');
const db = require('../db');
const { httpError } = require('../middleware/error');
const store = require('../services/videoStore');

const router = express.Router();

function uid(req) {
  const id = req.user && req.user.id;
  if (!id) throw httpError(401, '未登录或登录已过期');
  return Number(id);
}

// 上报进度（写当前用户自己的进度；v1.4.11：未授权媒体库的视频不可上报）
router.post('/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT id, library_id FROM video WHERE id = ?').get(id);
  if (!row) throw httpError(404, '视频不存在');
  store.assertVideoVisible(req.user, row);

  const progress = Number((req.body || {}).progress);
  const duration = Number((req.body || {}).duration);

  if (!Number.isFinite(progress) || progress < 0) {
    throw httpError(400, 'progress 必须为非负数字');
  }
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;

  store.saveProgress(uid(req), id, progress, safeDuration);
  res.json({ ok: true });
});

// 历史列表（本用户 + 启用中媒体库）
router.get('/', (req, res) => {
  res.json(store.listHistory(uid(req), req.query.limit));
});

// 清除某视频进度（仅本用户）
router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT id FROM video WHERE id = ?').get(id);
  if (!row) throw httpError(404, '视频不存在');

  store.clearProgress(uid(req), id);
  res.json({ ok: true });
});

module.exports = router;
