'use strict';

/**
 * 抽帧预览（精灵图）API —— v1.3。
 *
 *   GET  /api/sprite/:id/info   状态查询；未生成时顺带在后台启动懒生成
 *   GET  /api/sprite/:id        精灵图本体（jpg）
 *   GET  /api/sprite/batch      批量生成进度（仅管理员）
 *   POST /api/sprite/batch      启动批量生成（仅管理员）
 *   POST /api/sprite/batch/cancel  取消批量生成（仅管理员）
 *
 * 生成是重活（4K 素材单张 20-30 秒），因此接口一律不等待，只返回状态，
 * 前端拿到 generating=true 后轮询。失败静默降级：没图就不显示预览。
 *
 * 注意：/batch 必须排在 /:id 之前，否则会被单段通配吃掉。
 */

const express = require('express');
const fs = require('fs');

const db = require('../db');
const { httpError } = require('../middleware/error');
const { requireAdmin } = require('../middleware/auth');
const sprite = require('../services/sprite');

const router = express.Router();

function getVideo(id) {
  const row = db
    .prepare(
      'SELECT id, title, file_path, duration, mtime, sprite_path, sprite_meta FROM video WHERE id = ?'
    )
    .get(Number(id));
  if (!row) throw httpError(404, '视频不存在');
  return row;
}

/* ------------------------------------------------------------------ *
 * 批量生成（仅管理员）
 * ------------------------------------------------------------------ */

router.get('/batch', requireAdmin, (req, res) => {
  res.json(sprite.getBatchState());
});

router.post('/batch', requireAdmin, (req, res) => {
  res.json(sprite.startBatch());
});

router.post('/batch/cancel', requireAdmin, (req, res) => {
  res.json(sprite.cancelBatch());
});

/* ------------------------------------------------------------------ *
 * 单个视频
 * ------------------------------------------------------------------ */

// 状态查询：未生成则在后台启动懒生成（幂等）
router.get('/:id/info', (req, res) => {
  const row = getVideo(req.params.id);
  if (!fs.existsSync(row.file_path)) throw httpError(404, '源文件不存在');

  sprite.ensure(row);

  const st = sprite.statusOf(row);
  const meta = sprite.readMeta(row);

  res.json({
    ready: st.ready,
    generating: st.generating,
    error: st.error,
    url: '/api/sprite/' + row.id + '?v=' + (Number(row.mtime) || 0),
    number: meta.number,
    column: meta.column,
    row: meta.row,
    width: meta.width,
    height: meta.height,
  });
});

// 精灵图本体
router.get('/:id', (req, res) => {
  const row = getVideo(req.params.id);
  const file = row.sprite_path;
  if (!file || !fs.existsSync(file)) throw httpError(404, '预览图尚未生成');

  res.setHeader('Cache-Control', 'public, max-age=604800');
  res.setHeader('Content-Type', 'image/jpeg');
  fs.createReadStream(file).pipe(res);
});

module.exports = router;
