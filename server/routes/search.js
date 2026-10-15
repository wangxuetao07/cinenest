'use strict';

/**
 * 搜索 API。见 开发任务书 5.7。
 * v1.2：附加当前用户的收藏与进度，并排除停用媒体库。
 * v1.2.2：除 title / file_name 外，标签名也参与匹配；另支持 ?tag= 按标签过滤。
 * v1.2.3：关键词以空白分隔，多个关键词为「或」关系（任一命中即返回）；
 *         响应额外返回 keywords（服务端实际使用的关键词数组，供前端展示搜索条件）。
 */

const express = require('express');
const store = require('../services/videoStore');
const { httpError } = require('../middleware/error');

const router = express.Router();

router.get('/', (req, res) => {
  const q = String(req.query.q || '').trim();
  const tag = String(req.query.tag || '').trim();
  if (!q && !tag) return res.json({ items: [], keywords: [] });

  const userId = req.user && req.user.id;
  if (!userId) throw httpError(401, '未登录或登录已过期');

  res.json({
    items: store.search(userId, { q, tag }, req.query.limit),
    keywords: store.splitKeywords(q),
  });
});

module.exports = router;
