'use strict';

/**
 * 卡片悬停预览片段 API —— v1.4。
 *
 *   GET  /api/preview/:id/info   状态查询；未生成时顺带在后台启动懒生成
 *   GET  /api/preview/:id        预览片段本体（mp4，支持 Range，边下边播）
 *   GET  /api/preview/batch      批量生成进度（仅管理员）
 *   POST /api/preview/batch      启动批量生成（仅管理员）
 *   POST /api/preview/batch/cancel  取消批量生成（仅管理员）
 *
 * 注意：/batch 必须排在 /:id 之前，否则会被单段通配吃掉。
 */

const express = require('express');
const fs = require('fs');

const db = require('../db');
const { httpError } = require('../middleware/error');
const { requireAdmin } = require('../middleware/auth');
const preview = require('../services/preview');

const router = express.Router();

function getVideo(id) {
  const row = db
    .prepare(
      'SELECT id, title, file_path, duration, mtime, preview_path FROM video WHERE id = ?'
    )
    .get(Number(id));
  if (!row) throw httpError(404, '视频不存在');
  return row;
}

/* ------------------------------------------------------------------ *
 * 批量生成（仅管理员）
 * ------------------------------------------------------------------ */

router.get('/batch', requireAdmin, (req, res) => {
  res.json(preview.getBatchState());
});

router.post('/batch', requireAdmin, (req, res) => {
  res.json(preview.startBatch());
});

router.post('/batch/cancel', requireAdmin, (req, res) => {
  res.json(preview.cancelBatch());
});

/* ------------------------------------------------------------------ *
 * 单个视频
 * ------------------------------------------------------------------ */

// 状态查询：未生成则在后台启动懒生成（幂等）
router.get('/:id/info', (req, res) => {
  const row = getVideo(req.params.id);
  if (!fs.existsSync(row.file_path)) throw httpError(404, '源文件不存在');

  preview.ensure(row);

  const st = preview.statusOf(row);

  res.json({
    ready: st.ready,
    generating: st.generating,
    error: st.error,
    url: '/api/preview/' + row.id + '?v=' + (Number(row.mtime) || 0),
    duration: Number(row.duration) || 0,
  });
});

// 预览片段本体（小文件直出；sendFile 自带 Range / If-Modified-Since 支持）
router.get('/:id', (req, res) => {
  const row = getVideo(req.params.id);
  const file = row.preview_path;
  if (!file || !fs.existsSync(file)) throw httpError(404, '预览片段尚未生成');

  res.setHeader('Cache-Control', 'public, max-age=604800');
  res.sendFile(file, (err) => {
    if (err && !res.headersSent) {
      res.status(err.statusCode || 500).end();
    }
  });
});

module.exports = router;
