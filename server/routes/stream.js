'use strict';

/**
 * 播放相关路由：流媒体 / HLS(m3u8) / 缩略图 / 海报 / 字幕。
 * 见 开发任务书 5.3。
 *
 * 导出多个 router，分别挂载到：
 *   /api/stream   → stream   （/:id 直出、/:id/hls.m3u8、/:id/hls/*）
 *   /api/thumb    → thumb
 *   /api/poster   → poster
 *   /api/subtitle → subtitle
 */

const express = require('express');
const fs = require('fs');

const db = require('../db');
const { httpError, asyncHandler } = require('../middleware/error');
const store = require('../services/videoStore');
const { streamFile } = require('../services/stream');
const { makeThumb, thumbPathFor } = require('../services/thumbnail');
const { findSubtitle, toVtt } = require('../services/subtitle');
const hls = require('../services/hls');

const stream = express.Router();
const thumb = express.Router();
const poster = express.Router();
const subtitle = express.Router();

/**
 * 取视频行并校验当前用户可见性（v1.4.11）。
 * 管理员：存在即可；普通用户：媒体库启用 + 已授权（library_access），
 * 否则一律 404 —— 不泄露未授权内容的存在性。
 */
function getVideo(req) {
  const row = db.prepare('SELECT * FROM video WHERE id = ?').get(Number(req.params.id));
  if (!row) throw httpError(404, '视频不存在');
  store.assertVideoVisible(req.user, row);
  return row;
}

const HLS_MIME = 'application/vnd.apple.mpegurl';

/* ------------------------------------------------------------------ *
 * HLS / m3u8（注意：必须排在 '/:id' 之前，避免被单段通配吃掉）
 * ------------------------------------------------------------------ */

// 播放列表：本地 m3u8 重写；其它按需转码
stream.get('/:id/hls.m3u8', asyncHandler(async (req, res) => {
  const row = getVideo(req);
  if (!fs.existsSync(row.file_path)) throw httpError(404, '源文件不存在');

  const body = await hls.getPlaylist(row);
  res.setHeader('Content-Type', HLS_MIME);
  res.setHeader('Cache-Control', 'no-cache');
  res.send(body);
}));

// 分片 / 子播放列表
stream.get('/:id/hls/*', asyncHandler(async (req, res) => {
  const row = getVideo(req);
  if (!fs.existsSync(row.file_path)) throw httpError(404, '源文件不存在');

  const rel = req.params[0];
  await hls.serveResource(req, res, row, rel, streamFile);
}));

/* ------------------------------------------------------------------ *
 * 流媒体直出
 * ------------------------------------------------------------------ */

stream.get('/:id', asyncHandler(async (req, res) => {
  const row = getVideo(req);
  if (!fs.existsSync(row.file_path)) throw httpError(404, '源文件不存在');

  // 本地 HLS：直出重写后的播放列表，这样 hls.js 直接指向 /api/stream/:id 也能播
  if (hls.isLocalPlaylist(row.file_path)) {
    const body = hls.rewritePlaylist(hls.readPlaylist(row.file_path), hls.localMapper(row.id));
    res.setHeader('Content-Type', HLS_MIME);
    res.setHeader('Cache-Control', 'no-cache');
    return res.send(body);
  }

  streamFile(req, res, row.file_path);
}));

stream.head('/:id', (req, res) => {
  const row = getVideo(req);
  if (!fs.existsSync(row.file_path)) throw httpError(404, '源文件不存在');
  if (hls.isLocalPlaylist(row.file_path)) {
    res.setHeader('Content-Type', HLS_MIME);
    return res.end();
  }
  streamFile(req, res, row.file_path);
});

/* ------------------------------------------------------------------ *
 * 缩略图
 * ------------------------------------------------------------------ */

thumb.get('/:id', asyncHandler(async (req, res) => {
  const row = getVideo(req);

  let file = row.thumb_path && fs.existsSync(row.thumb_path) ? row.thumb_path : null;

  // 缺失时按需生成
  if (!file) {
    const generated = await makeThumb(row.file_path, row.duration);
    if (generated) {
      file = generated;
      db.prepare("UPDATE video SET thumb_path = ?, updated_at = datetime('now','localtime') WHERE id = ?")
        .run(generated, row.id);
    }
  }

  if (!file || !fs.existsSync(file)) throw httpError(404, '缩略图不存在');
  // URL 带 ?v=<mtime> 指纹（见 utils/paths.serializeVideo），内容变化即换 URL，
  // 因此这里可以放心长缓存；即使有人不带指纹直连，7 天后也会自动刷新。
  res.setHeader('Cache-Control', 'public, max-age=604800');
  res.setHeader('Content-Type', 'image/jpeg');
  fs.createReadStream(file).pipe(res);
}));

/* ------------------------------------------------------------------ *
 * 海报
 * ------------------------------------------------------------------ */

poster.get('/:id', (req, res) => {
  const row = getVideo(req);

  if (row.poster_path && fs.existsSync(row.poster_path)) {
    res.setHeader('Cache-Control', 'public, max-age=604800');
    res.setHeader('Content-Type', 'image/jpeg');
    return fs.createReadStream(row.poster_path).pipe(res);
  }

  // 回退 thumb
  const t = row.thumb_path && fs.existsSync(row.thumb_path)
    ? row.thumb_path
    : thumbPathFor(row.file_path);

  if (t && fs.existsSync(t)) {
    res.setHeader('Cache-Control', 'public, max-age=604800');
    res.setHeader('Content-Type', 'image/jpeg');
    return fs.createReadStream(t).pipe(res);
  }

  throw httpError(404, '海报不存在');
});

/* ------------------------------------------------------------------ *
 * 字幕
 * ------------------------------------------------------------------ */

subtitle.get('/:id', asyncHandler(async (req, res) => {
  const row = getVideo(req);
  const sub = findSubtitle(row.file_path);
  if (!sub) throw httpError(404, '未找到同名字幕');

  const vtt = await toVtt(sub);
  res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(vtt);
}));

module.exports = { stream, thumb, poster, subtitle };
