'use strict';

/**
 * 缓存回收（v1.3）。
 *
 * 缩略图 / 精灵图都是派生缓存，删视频、删媒体库、重扫改名时都应该跟着走。
 * 早期版本漏了这条链路，导致大量孤儿文件（实测 113 条记录 vs 150 个文件）。
 *
 * 这里提供「孤儿回收」：拿缓存目录里的文件名，与数据库中被引用的文件名集合
 * 做差集，多出来的即无主文件，直接删掉。
 *
 * 引用集合同时取两路，避免误删：
 *   1. video 表上的 *_path 字段（生成后写回的真实路径）
 *   2. 按命名规则推算的期望路径（md5(file_path).jpg / v<id>-<mtime>.jpg）
 */

const fs = require('fs');
const path = require('path');

const db = require('../db');
const config = require('../config');
const logger = require('../utils/logger');
const { md5 } = require('../utils/paths');

/** 列出目录内所有普通文件（目录不存在返回空数组） */
function listFiles(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => {
      try {
        return fs.statSync(path.join(dir, f)).isFile();
      } catch (_) {
        return false;
      }
    });
  } catch (_) {
    return [];
  }
}

/** 被引用的缩略图文件名集合 */
function thumbKeepSet() {
  const keep = new Set();
  try {
    for (const r of db.prepare('SELECT thumb_path FROM video WHERE thumb_path IS NOT NULL').all()) {
      if (r.thumb_path) keep.add(path.basename(r.thumb_path));
    }
  } catch (_) { /* ignore */ }
  try {
    for (const r of db.prepare('SELECT file_path FROM video').all()) {
      if (r.file_path) keep.add(md5(r.file_path) + '.jpg');
    }
  } catch (_) { /* ignore */ }
  return keep;
}

/** 被引用的精灵图文件名集合 */
function spriteKeepSet() {
  const keep = new Set();
  try {
    for (const r of db.prepare('SELECT id, mtime FROM video').all()) {
      keep.add('v' + r.id + '-' + (Number(r.mtime) || 0) + '.jpg');
    }
  } catch (_) { /* ignore */ }
  try {
    for (const r of db.prepare('SELECT sprite_path FROM video WHERE sprite_path IS NOT NULL').all()) {
      if (r.sprite_path) keep.add(path.basename(r.sprite_path));
    }
  } catch (_) { /* ignore */ }
  return keep;
}

/** 被引用的悬停预览片段文件名集合 */
function previewKeepSet() {
  const keep = new Set();
  try {
    for (const r of db.prepare('SELECT id, mtime FROM video').all()) {
      keep.add('p' + r.id + '-' + (Number(r.mtime) || 0) + '.mp4');
    }
  } catch (_) { /* ignore */ }
  try {
    for (const r of db.prepare('SELECT preview_path FROM video WHERE preview_path IS NOT NULL').all()) {
      if (r.preview_path) keep.add(path.basename(r.preview_path));
    }
  } catch (_) { /* ignore */ }
  return keep;
}

/** 删除单个文件（Windows 下文件可能被杀软 / 索引器短暂占用，失败重试） */
function removeFile(file) {
  for (let i = 0; i < 3; i += 1) {
    try {
      fs.rmSync(file, { force: true });
      return true;
    } catch (err) {
      if (i === 2) {
        logger.warn('[cache] 删除文件失败(' + err.code + '):', file, err.message);
        return false;
      }
    }
  }
  return false;
}

/** 通用差集回收 */
function sweepDir(dir, keep) {
  let removed = 0;
  let bytes = 0;
  for (const f of listFiles(dir)) {
    if (keep.has(f)) continue;
    const full = path.join(dir, f);
    let size = 0;
    try {
      size = fs.statSync(full).size;
    } catch (_) { /* ignore */ }
    if (removeFile(full)) {
      bytes += size;
      removed += 1;
    }
  }
  return { removed, bytes };
}

/**
 * 回收孤儿缓存。
 * @returns {{thumbs:{removed:number,bytes:number}, sprites:{removed:number,bytes:number}, previews:{removed:number,bytes:number}, bytes:number}}
 */
function sweepOrphans() {
  const thumbs = sweepDir(config.thumbDir, thumbKeepSet());
  const sprites = sweepDir(config.spriteDir, spriteKeepSet());
  const previews = sweepDir(config.previewDir, previewKeepSet());
  const result = {
    thumbs,
    sprites,
    previews,
    bytes: thumbs.bytes + sprites.bytes + previews.bytes,
  };
  if (thumbs.removed || sprites.removed || previews.removed) {
    logger.info(
      '[cache] 孤儿回收：缩略图 ' + thumbs.removed + ' 个、精灵图 ' + sprites.removed +
      ' 个、预览片段 ' + previews.removed + ' 个，释放 ' + (result.bytes / 1048576).toFixed(1) + ' MB'
    );
  }
  return result;
}

/** 缓存占用统计 */
function stats() {
  const sizeOf = (dir) => {
    let count = 0;
    let bytes = 0;
    for (const f of listFiles(dir)) {
      try {
        bytes += fs.statSync(path.join(dir, f)).size;
        count += 1;
      } catch (_) { /* ignore */ }
    }
    return { count, bytes };
  };
  return { thumbs: sizeOf(config.thumbDir), sprites: sizeOf(config.spriteDir), previews: sizeOf(config.previewDir) };
}

module.exports = { sweepOrphans, stats, listFiles };
