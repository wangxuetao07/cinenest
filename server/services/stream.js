'use strict';

/**
 * 流媒体：支持 HTTP Range 的直出。
 * 见 开发任务书 5.3 / 7.4。
 */

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { mimeType } = require('../utils/paths');

/**
 * 以 Range 语义输出本地文件。
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {string} filePath 绝对路径
 * @param {Object} [opts]
 * @param {string} [opts.contentType] 覆盖 MIME
 */
function streamFile(req, res, filePath, opts = {}) {
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: '文件不存在' });
  }

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    logger.error('[stream] stat 失败:', filePath, err.message);
    return res.status(500).json({ error: '读取文件失败' });
  }

  if (!stat.isFile()) {
    return res.status(404).json({ error: '不是有效文件' });
  }

  const total = stat.size;
  const type = opts.contentType || mimeType(filePath);

  res.setHeader('Content-Type', type);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'no-cache');

  const rangeHeader = req.headers.range;
  if (!rangeHeader) {
    res.setHeader('Content-Length', String(total));
    res.status(200);
    if (req.method === 'HEAD') return res.end();
    return fs
      .createReadStream(filePath)
      .on('error', (err) => {
        logger.error('[stream] 读取失败:', filePath, err.message);
        if (!res.headersSent) res.status(500).json({ error: '读取文件失败' });
        else res.end();
      })
      .pipe(res);
  }

  // 解析 Range: bytes=start-end
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim());
  if (!match) {
    res.setHeader('Content-Range', 'bytes */' + total);
    return res.status(416).json({ error: 'Range 格式不支持' });
  }

  let start;
  let end;
  const hasStart = match[1] !== '';
  const hasEnd = match[2] !== '';

  if (!hasStart && hasEnd) {
    // 后缀范围：最后 N 字节
    const suffix = parseInt(match[2], 10);
    if (suffix <= 0) {
      res.setHeader('Content-Range', 'bytes */' + total);
      return res.status(416).json({ error: 'Range 越界' });
    }
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = hasStart ? parseInt(match[1], 10) : 0;
    end = hasEnd ? parseInt(match[2], 10) : total - 1;
  }

  if (
    Number.isNaN(start) || Number.isNaN(end) ||
    start > end || start >= total || end >= total || start < 0
  ) {
    res.setHeader('Content-Range', 'bytes */' + total);
    return res.status(416).json({ error: 'Range 越界' });
  }

  const chunkSize = end - start + 1;
  res.status(206);
  res.setHeader('Content-Range', 'bytes ' + start + '-' + end + '/' + total);
  res.setHeader('Content-Length', String(chunkSize));

  if (req.method === 'HEAD') return res.end();

  const stream = fs.createReadStream(filePath, { start, end });
  stream.on('error', (err) => {
    logger.error('[stream] 分片读取失败:', filePath, err.message);
    if (!res.headersSent) res.status(500).json({ error: '读取文件失败' });
    else res.end();
  });
  stream.pipe(res);
}

module.exports = { streamFile };
