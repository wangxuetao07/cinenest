'use strict';

/**
 * 视频 API。见 开发任务书 5.2。
 * 另含收藏列表（5.5），以独立 router 导出，挂载在 /api/favorites。
 *
 * v1.2 起：
 * - 收藏 / 观看进度 / 最后播放时间按账号隔离（user_video_state，见 services/videoStore）
 * - 所有列表只返回「启用中」媒体库的视频
 * - 标题 / 标签属于全站共享元数据，仅管理员可改；收藏任何人都能改自己的
 */

const express = require('express');
const db = require('../db');
const { httpError } = require('../middleware/error');
const { requireAdmin } = require('../middleware/auth');
const store = require('../services/videoStore');
const { removeThumbFile } = require('../services/thumbnail');
const sprite = require('../services/sprite');
const preview = require('../services/preview');
const { serializeVideo } = require('../utils/paths');

const router = express.Router();
const favorites = express.Router();

/** 当前用户 id（全局鉴权门保证必然存在） */
function uid(req) {
  const id = req.user && req.user.id;
  if (!id) throw httpError(401, '未登录或登录已过期');
  return Number(id);
}

function requireVideo(userId, id) {
  const row = store.findRaw(userId, id);
  if (!row) throw httpError(404, '视频不存在');
  return row;
}

// ---------- 具体路由（注意顺序：固定路径在 :id 之前） ----------

// 最近添加
router.get('/recent', (req, res) => {
  res.json(store.listRecent(uid(req), req.query.limit));
});

// 继续观看：有进度且未看完（本用户）
router.get('/continue', (req, res) => {
  res.json(store.listContinue(uid(req), req.query.limit));
});

// 分页列表
router.get('/', (req, res) => {
  res.json(store.listVideos(uid(req), req.query));
});

// 详情
router.get('/:id', (req, res) => {
  const userId = uid(req);
  const id = Number(req.params.id);
  const row = requireVideo(userId, id);

  const video = serializeVideo(row);
  video.tags = store.tagsByVideo([id]).get(id) || [];
  res.json(video);
});

// 修改：收藏（本人）/ 标题与标签（仅管理员）
router.patch('/:id', (req, res) => {
  const userId = uid(req);
  const id = Number(req.params.id);
  requireVideo(userId, id);

  const { title, favorite, tags } = req.body || {};

  if (favorite !== undefined) {
    store.setFavorite(userId, id, !!favorite);
  }

  const isAdmin = req.user.role === 'admin';

  if (title !== undefined || Array.isArray(tags)) {
    if (!isAdmin) throw httpError(403, '标题与标签仅管理员可修改');
  }

  if (title !== undefined) {
    db.prepare("UPDATE video SET title = ?, updated_at = datetime('now','localtime') WHERE id = ?")
      .run(title === null ? null : String(title), id);
  }

  if (Array.isArray(tags)) {
    const tx = db.transaction((names) => {
      db.prepare('DELETE FROM video_tag WHERE video_id = ?').run(id);
      for (const raw of names) {
        const name = String(raw || '').trim();
        if (!name) continue;
        db.prepare('INSERT OR IGNORE INTO tag (name) VALUES (?)').run(name);
        const t = db.prepare('SELECT id FROM tag WHERE name = ?').get(name);
        db.prepare('INSERT OR IGNORE INTO video_tag (video_id, tag_id) VALUES (?, ?)').run(id, t.id);
      }
    });
    tx(tags);
  }

  res.json({ ok: true });
});

// 删除记录（仅管理员，属于全站共享数据）
router.delete('/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT id, thumb_path FROM video WHERE id = ?').get(id);
  if (!row) throw httpError(404, '视频不存在');

  // 只删记录与派生缓存，磁盘上的原始视频文件保持不动
  removeThumbFile(row.thumb_path);
  sprite.removeSprites(id);
  preview.removePreviews(id);

  db.prepare('DELETE FROM video WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ---------- 收藏列表（本用户） ----------
favorites.get('/', (req, res) => {
  res.json(store.listVideos(uid(req), Object.assign({}, req.query, { favorite: '1' })));
});

module.exports = { router, favorites };
