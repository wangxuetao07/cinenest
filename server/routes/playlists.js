'use strict';

/**
 * 播放列表 API。见 开发任务书 5.6。
 * 附加：PATCH /:id 重命名、PATCH /:id/items/:videoId 调整排序（供上下移动按钮使用）。
 *
 * v1.2：播放列表归属创建者账号（playlist.user_id），他人不可见、不可改；
 *       条目同样排除停用媒体库的视频。
 */

const express = require('express');
const db = require('../db');
const { httpError } = require('../middleware/error');
const store = require('../services/videoStore');
const { serializeVideo } = require('../utils/paths');

const router = express.Router();

function uid(req) {
  const id = req.user && req.user.id;
  if (!id) throw httpError(401, '未登录或登录已过期');
  return Number(id);
}

/** 取属于当前用户的播放列表，不存在或非本人 → 404（不泄露他人资源是否存在） */
function ownPlaylist(userId, id) {
  const row = db
    .prepare('SELECT * FROM playlist WHERE id = ? AND user_id = ?')
    .get(Number(id), Number(userId));
  if (!row) throw httpError(404, '播放列表不存在');
  return row;
}

// 列表（仅本人）
router.get('/', (req, res) => {
  const rows = db
    .prepare(`
      SELECT p.*, (SELECT COUNT(1) FROM playlist_item pi WHERE pi.playlist_id = p.id) AS item_count
      FROM playlist p WHERE p.user_id = ? ORDER BY p.id ASC
    `)
    .all(uid(req));
  res.json(rows);
});

// 新建
router.post('/', (req, res) => {
  const name = (req.body || {}).name;
  if (typeof name !== 'string' || !name.trim()) throw httpError(400, 'name 不能为空');
  const info = db
    .prepare('INSERT INTO playlist (user_id, name) VALUES (?, ?)')
    .run(uid(req), name.trim());
  res.json({ id: info.lastInsertRowid });
});

// 重命名
router.patch('/:id', (req, res) => {
  const userId = uid(req);
  const id = Number(req.params.id);
  ownPlaylist(userId, id);
  const name = (req.body || {}).name;
  if (typeof name !== 'string' || !name.trim()) throw httpError(400, 'name 不能为空');
  db.prepare('UPDATE playlist SET name = ? WHERE id = ? AND user_id = ?').run(name.trim(), id, userId);
  res.json({ ok: true });
});

// 删除
router.delete('/:id', (req, res) => {
  const userId = uid(req);
  const id = Number(req.params.id);
  ownPlaylist(userId, id);
  db.prepare('DELETE FROM playlist WHERE id = ? AND user_id = ?').run(id, userId);
  res.json({ ok: true });
});

// 条目列表（带当前用户收藏/进度；跳过停用媒体库里的视频；
// v1.4.11：普通用户再过滤掉未授权媒体库，管理员不受限）
router.get('/:id/items', (req, res) => {
  const userId = uid(req);
  const id = Number(req.params.id);
  ownPlaylist(userId, id);

  const gate =
    req.user && req.user.role === 'admin'
      ? ''
      : ' AND EXISTS (SELECT 1 FROM library_access la WHERE la.library_id = l.id AND la.user_id = @uid)';

  const rows = db
    .prepare(`
      SELECT ${store.VIDEO_COLS}, pi.sort AS __sort, pi.id AS __item_id
      FROM playlist_item pi
      JOIN video v ON v.id = pi.video_id
      JOIN library l ON l.id = v.library_id AND l.enabled = 1${gate}
      ${store.JOIN_STATE}
      WHERE pi.playlist_id = @pid
      ORDER BY pi.sort ASC, pi.id ASC
    `)
    .all({ uid: userId, pid: id });

  res.json(rows.map((r) => {
    const v = serializeVideo(r);
    v.sort = r.__sort;
    v.item_id = r.__item_id;
    delete v.__sort;
    delete v.__item_id;
    return v;
  }));
});

// 添加条目
router.post('/:id/items', (req, res) => {
  const userId = uid(req);
  const id = Number(req.params.id);
  ownPlaylist(userId, id);

  const videoId = Number((req.body || {}).videoId);
  const video = db.prepare('SELECT id, library_id FROM video WHERE id = ?').get(videoId);
  if (!video) throw httpError(400, 'videoId 无效');
  // v1.4.11：只能把「自己看得到」的视频加进播放列表
  store.assertVideoVisible(req.user, video);

  const dup = db
    .prepare('SELECT id FROM playlist_item WHERE playlist_id = ? AND video_id = ?')
    .get(id, videoId);
  if (dup) return res.json({ ok: true, duplicated: true });

  const maxSort = db
    .prepare('SELECT IFNULL(MAX(sort), 0) AS m FROM playlist_item WHERE playlist_id = ?')
    .get(id).m;

  db.prepare('INSERT INTO playlist_item (playlist_id, video_id, sort) VALUES (?, ?, ?)')
    .run(id, videoId, maxSort + 1);

  res.json({ ok: true });
});

// 调整条目排序
router.patch('/:id/items/:videoId', (req, res) => {
  const userId = uid(req);
  const id = Number(req.params.id);
  const videoId = Number(req.params.videoId);
  ownPlaylist(userId, id);

  const sort = Number((req.body || {}).sort);
  if (!Number.isFinite(sort)) throw httpError(400, 'sort 必须为数字');

  const info = db
    .prepare('UPDATE playlist_item SET sort = ? WHERE playlist_id = ? AND video_id = ?')
    .run(sort, id, videoId);

  if (info.changes === 0) throw httpError(404, '该视频不在此播放列表中');
  res.json({ ok: true });
});

// 移除条目
router.delete('/:id/items/:videoId', (req, res) => {
  const userId = uid(req);
  const id = Number(req.params.id);
  const videoId = Number(req.params.videoId);
  ownPlaylist(userId, id);
  db.prepare('DELETE FROM playlist_item WHERE playlist_id = ? AND video_id = ?').run(id, videoId);
  res.json({ ok: true });
});

module.exports = router;
