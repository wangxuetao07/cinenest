'use strict';

/**
 * 视频查询统一入口（v1.2）。
 *
 * 把两件事收敛到一处，避免每个路由各写一份 SQL 时漏掉：
 *
 * 1. **按用户隔离**：收藏 / 观看进度 / 最后播放时间全部取自 user_video_state，
 *    以 (user_id, video_id) 为主键；video 表上的同名字段自 v1.2 起不再读写。
 * 2. **停用媒体库全局隐藏**：所有列表类查询都 INNER JOIN library 且限定
 *    library.enabled = 1 —— 管理员在设置页关闭媒体库后，其视频立即从
 *    首页、媒体库页、搜索、收藏、历史、播放列表中消失。
 *
 * 约定：所有查询都使用命名参数 @uid（当前用户 id）。
 */

const db = require('../db');
const { httpError } = require('../middleware/error');
const { serializeVideo } = require('../utils/paths');

/** 视频字段 + 当前用户状态字段（状态列放在末尾，覆盖 v.* 里的旧同名列） */
const VIDEO_COLS = `
  v.id, v.library_id, v.file_path, v.file_name, v.title, v.ext, v.size, v.mtime,
  v.duration, v.width, v.height, v.video_codec, v.audio_codec, v.bitrate,
  v.thumb_path, v.poster_path, v.preview_path, v.added_at, v.updated_at,
  IFNULL(s.favorite, 0)      AS favorite,
  IFNULL(s.play_progress, 0) AS play_progress,
  IFNULL(s.play_duration, 0) AS play_duration,
  s.last_played              AS last_played
`;

/** 用户状态 join 片段（依赖 @uid） */
const JOIN_STATE = 'LEFT JOIN user_video_state s ON s.video_id = v.id AND s.user_id = @uid';

/** 启用中的媒体库 + 用户状态（管理员视角：全部媒体库） */
const FROM_ACTIVE = 'FROM video v JOIN library l ON l.id = v.library_id AND l.enabled = 1 ' + JOIN_STATE;

/**
 * 启用中**且已授权**的媒体库 + 用户状态（普通用户视角）。
 * v1.4.11 起媒体库可配置可见用户：library_access 表为空 = 仅管理员可见，
 * 普通用户只能看到被明确授权的库。
 */
const FROM_ACTIVE_USER =
  'FROM video v JOIN library l ON l.id = v.library_id AND l.enabled = 1' +
  ' AND EXISTS (SELECT 1 FROM library_access la WHERE la.library_id = l.id AND la.user_id = @uid)' +
  ' ' + JOIN_STATE;

/** 不限媒体库状态（管理员的详情 / 播放等直链场景使用） */
const FROM_ANY = 'FROM video v ' + JOIN_STATE;

/** 该用户是否为启用中的管理员 */
function isAdminUser(userId) {
  const row = db
    .prepare("SELECT 1 FROM user WHERE id = ? AND role = 'admin' AND enabled = 1")
    .get(Number(userId));
  return !!row;
}

/** 按用户身份取列表 FROM 片段：管理员看全部启用库，普通用户只看被授权的启用库 */
function fromFor(userId) {
  return isAdminUser(userId) ? FROM_ACTIVE : FROM_ACTIVE_USER;
}

/** 单次搜索最多拆出的关键词数量（防止超长输入拖慢 SQLite） */
const MAX_KEYWORDS = 8;

/**
 * 拆分搜索关键词（v1.2.3）。
 *
 * 以空白字符（半角空格 / 全角空格 / Tab / 换行）分隔，**关键词之间是「或」的关系**：
 * 任一关键词命中即返回该视频。去空、按不区分大小写去重、限量，保持输入顺序。
 *
 * @param {string} input 原始输入
 * @returns {string[]}
 */
function splitKeywords(input, max = MAX_KEYWORDS) {
  const seen = new Set();
  const out = [];
  for (const part of String(input || '').split(/[\s\u3000]+/)) {
    const kw = part.trim();
    if (!kw) continue;
    const key = kw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(kw);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * 单个关键词的匹配片段：标题 / 文件名 / 标签名，三者任一命中即算该关键词命中。
 * 依赖命名参数 @kwN（N 为关键词下标，形如 %关键词%）。
 */
function keywordMatchAt(index) {
  const p = 'kw' + index;
  return `(
  IFNULL(v.title, v.file_name) LIKE @${p}
  OR v.file_name LIKE @${p}
  OR EXISTS (
    SELECT 1 FROM video_tag ${p}vt JOIN tag ${p}t ON ${p}t.id = ${p}vt.tag_id
    WHERE ${p}vt.video_id = v.id AND ${p}t.name LIKE @${p}
  )
)`;
}

/**
 * 多关键词「或」条件：`(kw0) OR (kw1) OR ...`
 * @param {string[]} keywords
 * @returns {{ sql: string, params: Record<string,string> }}
 */
function keywordOrClause(keywords) {
  const params = {};
  keywords.forEach((kw, i) => {
    params['kw' + i] = '%' + kw + '%';
  });
  return {
    sql: '(' + keywords.map((_, i) => keywordMatchAt(i)).join('\n  OR ') + ')',
    params,
  };
}

/**
 * 命中关键词个数的评分表达式（命中越多越靠前），依赖与 keywordOrClause 相同的命名参数。
 * @param {string[]} keywords
 */
function keywordHitScore(keywords) {
  return keywords.map((_, i) => `CASE WHEN ${keywordMatchAt(i)} THEN 1 ELSE 0 END`).join('\n    + ');
}

/** 标签精确匹配子查询（依赖命名参数 @tag 与别名区分） */
function tagExists(alias) {
  return `EXISTS (
    SELECT 1 FROM video_tag ${alias}vt JOIN tag ${alias}t ON ${alias}t.id = ${alias}vt.tag_id
    WHERE ${alias}vt.video_id = v.id AND ${alias}t.name = @tag
  )`;
}

const SORT_MAP = {
  'added_at DESC': 'v.added_at DESC, v.id DESC',
  'added_at ASC': 'v.added_at ASC, v.id ASC',
  'title ASC': 'v.title COLLATE NOCASE ASC',
  'duration DESC': 'v.duration DESC',
  'size DESC': 'v.size DESC',
};

function flag(value) {
  return value !== undefined && value !== null && value !== '' && value !== '0' && value !== 'false' && value !== 0;
}

/** 组装 WHERE 子句（不含 LIMIT），返回 { whereSql, params } */
function buildConditions(query = {}) {
  const where = [];
  const params = {};

  if (query.libraryId !== undefined && query.libraryId !== '') {
    const lid = Number(query.libraryId);
    if (Number.isFinite(lid)) {
      where.push('v.library_id = @libraryId');
      params.libraryId = lid;
    }
  }

  // 关键词：空格分隔、多个关键词为「或」关系（任一命中即算）
  const keywords = splitKeywords(query.q);
  if (keywords.length) {
    const or = keywordOrClause(keywords);
    where.push(or.sql);
    Object.assign(params, or.params);
  }

  // 标签过滤：按标签名精确匹配
  if (query.tag && String(query.tag).trim()) {
    where.push(tagExists('b'));
    params.tag = String(query.tag).trim();
  }

  if (flag(query.favorite)) where.push('IFNULL(s.favorite, 0) = 1');

  if (query.minDuration !== undefined && query.minDuration !== '') {
    where.push('v.duration >= @minDuration');
    params.minDuration = Number(query.minDuration) || 0;
  }
  if (query.maxDuration !== undefined && query.maxDuration !== '') {
    where.push('v.duration <= @maxDuration');
    params.maxDuration = Number(query.maxDuration) || 0;
  }
  if (query.minHeight !== undefined && query.minHeight !== '') {
    where.push('v.height >= @minHeight');
    params.minHeight = Number(query.minHeight) || 0;
  }
  if (query.maxHeight !== undefined && query.maxHeight !== '') {
    where.push('v.height <= @maxHeight');
    params.maxHeight = Number(query.maxHeight) || 0;
  }

  return {
    // 前置空格：调用方直接拼在 FROM 子句之后（...@uid + whereSql）
    whereSql: where.length ? ' WHERE ' + where.join(' AND ') : '',
    params,
  };
}

function pageParams(query = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const size = Math.min(200, Math.max(1, parseInt(query.size, 10) || 40));
  return { page, size, offset: (page - 1) * size };
}

/* ------------------------------------------------------------------ *
 * 查询
 * ------------------------------------------------------------------ */

/** 分页列表 */
function listVideos(userId, query = {}) {
  const { whereSql, params } = buildConditions(query);
  const { page, size, offset } = pageParams(query);
  const orderBy = SORT_MAP[String(query.sort || '')] || SORT_MAP['added_at DESC'];
  const bind = Object.assign({ uid: Number(userId) }, params);

  const total = db.prepare('SELECT COUNT(1) AS c ' + fromFor(userId) + whereSql).get(bind).c;

  const rows = db
    .prepare('SELECT ' + VIDEO_COLS + fromFor(userId) + whereSql + ' ORDER BY ' + orderBy + ' LIMIT @limit OFFSET @offset')
    .all(Object.assign({}, bind, { limit: size, offset }));

  return { total, page, size, items: rows.map(serializeVideo) };
}

/** 最近添加 */
function listRecent(userId, limit = 20) {
  const n = Math.min(200, Math.max(1, Number(limit) || 20));
  const rows = db
    .prepare('SELECT ' + VIDEO_COLS + fromFor(userId) + ' ORDER BY v.added_at DESC, v.id DESC LIMIT @limit')
    .all({ uid: Number(userId), limit: n });
  return rows.map(serializeVideo);
}

/** 继续观看：有进度且未看完 */
function listContinue(userId, limit = 20) {
  const n = Math.min(200, Math.max(1, Number(limit) || 20));
  const rows = db
    .prepare(
      'SELECT ' + VIDEO_COLS + fromFor(userId) +
      ' WHERE IFNULL(s.play_progress, 0) > 5' +
      '   AND (IFNULL(s.play_duration, 0) = 0 OR s.play_progress < s.play_duration - 5)' +
      ' ORDER BY s.last_played DESC, v.id DESC LIMIT @limit'
    )
    .all({ uid: Number(userId), limit: n });
  return rows.map(serializeVideo);
}

/** 观看历史（本用户） */
function listHistory(userId, limit = 50) {
  const n = Math.min(500, Math.max(1, Number(limit) || 50));
  const rows = db
    .prepare(
      'SELECT ' + VIDEO_COLS + fromFor(userId) +
      ' WHERE s.last_played IS NOT NULL' +
      ' ORDER BY s.last_played DESC, v.id DESC LIMIT @limit'
    )
    .all({ uid: Number(userId), limit: n });
  return rows.map(serializeVideo);
}

/**
 * 按视频 id 批量取标签名。
 * @param {number[]} ids
 * @returns {Map<number, string[]>} videoId → 标签名数组
 */
function tagsByVideo(ids) {
  const map = new Map();
  const list = (ids || []).map(Number).filter((n) => Number.isFinite(n));
  if (!list.length) return map;

  const holders = list.map(() => '?').join(',');
  const rows = db
    .prepare(
      'SELECT vt.video_id AS vid, t.name AS name' +
      ' FROM video_tag vt JOIN tag t ON t.id = vt.tag_id' +
      ' WHERE vt.video_id IN (' + holders + ')' +
      ' ORDER BY t.name'
    )
    .all(...list);

  for (const row of rows) {
    const arr = map.get(row.vid);
    if (arr) arr.push(row.name);
    else map.set(row.vid, [row.name]);
  }
  return map;
}

/**
 * 给搜索结果补上 tags（全部标签）与 matched_tags（本次命中的标签）。
 * 命中的判定：标签过滤项本身，或标签名被任一关键词模糊命中。
 */
function attachTags(items, keywords, tag) {
  const map = tagsByVideo(items.map((it) => it.id));
  const kws = (Array.isArray(keywords) ? keywords : splitKeywords(keywords)).map((k) =>
    String(k).toLowerCase()
  );
  for (const it of items) {
    const tags = map.get(it.id) || [];
    it.tags = tags;
    if (tag) it.matched_tags = tags.filter((t) => t === tag);
    else if (kws.length) it.matched_tags = tags.filter((t) => kws.some((k) => t.toLowerCase().includes(k)));
    else it.matched_tags = [];
  }
  return items;
}

/**
 * 搜索：关键词（标题 / 文件名 / 标签，空格分隔且互为「或」）+ 标签过滤（AND）。
 *
 * v1.2.3：关键词按空白拆分，多个关键词之间是「或」的关系 —— 任一关键词命中即返回；
 *         结果按「命中关键词个数」降序排列，命中越多越靠前。
 *
 * @param {number} userId
 * @param {{q?: string, tag?: string}|string} criteria 兼容旧签名（直接传关键词）
 * @param {number} [limit]
 * @returns {object[]} 结果项已带 tags / matched_tags
 */
function search(userId, criteria = {}, limit = 100) {
  const source = typeof criteria === 'string' ? { q: criteria } : criteria || {};
  const q = String(source.q || '').trim();
  const tag = String(source.tag || '').trim();
  const keywords = splitKeywords(q);
  if (!keywords.length && !tag) return [];

  const n = Math.min(200, Math.max(1, Number(limit) || 100));

  const where = [];
  const params = { uid: Number(userId), limit: n };

  if (keywords.length) {
    const or = keywordOrClause(keywords);
    where.push(or.sql);
    Object.assign(params, or.params);
  }
  if (tag) {
    where.push(tagExists('b'));
    params.tag = tag;
  }

  // 排序：完整短语命中标题 > 关键词命中个数 > 标题/文件名前缀 > 其它命中（标签命中落在这里）
  const orderParts = [];
  if (q) {
    params.q = q;
    params.prefix = q + '%';
    orderParts.push(
      'CASE' +
        '   WHEN IFNULL(v.title, v.file_name) = @q THEN 0' +
        '   WHEN IFNULL(v.title, v.file_name) LIKE @prefix THEN 1' +
        '   WHEN v.file_name LIKE @prefix THEN 2' +
        '   ELSE 3 END'
    );
  }
  if (keywords.length > 1) {
    // 命中关键词越多越靠前（多关键词「或」下的相关性）
    orderParts.push('(' + keywordHitScore(keywords) + ') DESC');
  }
  orderParts.push('v.added_at DESC', 'v.id DESC');

  const rows = db
    .prepare('SELECT ' + VIDEO_COLS + fromFor(userId) + ' WHERE ' + where.join(' AND ') + ' ORDER BY ' + orderParts.join(', ') + ' LIMIT @limit')
    .all(params);

  return attachTags(rows.map(serializeVideo), keywords, tag);
}

/**
 * 单个视频。
 *
 * v1.4.11：普通用户**一律**要求「媒体库启用 + 已授权」——未授权（默认）时详情
 * 也拿不到，行为等同 404；管理员维持原语义（onlyActive 控制是否要求启用）。
 *
 * @param {boolean} [onlyActive] true 时要求所属媒体库处于启用状态（仅对管理员生效）
 * @returns {object|null} 原始行（未序列化）
 */
function findRaw(userId, id, onlyActive = false) {
  const from = isAdminUser(userId) ? (onlyActive ? FROM_ACTIVE : FROM_ANY) : FROM_ACTIVE_USER;
  return db.prepare('SELECT ' + VIDEO_COLS + ' ' + from + ' WHERE v.id = @id').get({
    uid: Number(userId),
    id: Number(id),
  }) || null;
}

/** 单个视频（序列化） */
function find(userId, id, onlyActive = false) {
  return serializeVideo(findRaw(userId, id, onlyActive));
}

/** 该视频是否对当前用户可见（存在 + 媒体库启用 + 普通用户需已授权） */
function existsVisible(userId, id) {
  return !!findRaw(userId, id, true);
}

/** 媒体库是否启用 */
function isLibraryEnabled(libraryId) {
  const row = db.prepare('SELECT enabled FROM library WHERE id = ?').get(Number(libraryId));
  return !!row && !!row.enabled;
}

/* ------------------------------------------------------------------ *
 * 媒体库可见用户（v1.4.11）
 * ------------------------------------------------------------------ */

/** 库的可见用户 id 列表（空数组 = 仅管理员可见） */
function getLibraryUserIds(libraryId) {
  return db
    .prepare('SELECT user_id FROM library_access WHERE library_id = ? ORDER BY user_id ASC')
    .all(Number(libraryId))
    .map((r) => r.user_id);
}

/**
 * 整体替换某库的可见用户列表（先清后插，事务内完成）。
 * @param {number[]} userIds 必须是「启用中」的用户 id；管理员 id 会被忽略（管理员始终可见）
 * @returns {number} 实际写入的授权行数
 * @throws 用户不存在或已停用时抛 400
 */
function setLibraryUsers(libraryId, userIds) {
  const raw = Array.isArray(userIds) ? userIds.map(Number) : [];
  const unique = [...new Set(raw.filter((n) => Number.isFinite(n)))];

  for (const id of unique) {
    const u = db.prepare('SELECT id, enabled, role FROM user WHERE id = ?').get(id);
    if (!u) throw httpError(400, '用户不存在: #' + id);
    if (!u.enabled) throw httpError(400, '用户已停用，不能授权: #' + id);
  }
  const grantable = unique.filter((id) => {
    const u = db.prepare('SELECT role FROM user WHERE id = ?').get(id);
    return u && u.role !== 'admin';
  });

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM library_access WHERE library_id = ?').run(Number(libraryId));
    const ins = db.prepare('INSERT OR IGNORE INTO library_access (library_id, user_id) VALUES (?, ?)');
    for (const id of grantable) ins.run(Number(libraryId), id);
    return grantable.length;
  });
  return tx();
}

/** 普通用户是否被授权查看某媒体库（管理员由调用方放行，不看本表） */
function hasLibraryAccess(userId, libraryId) {
  return !!db
    .prepare('SELECT 1 FROM library_access WHERE library_id = ? AND user_id = ?')
    .get(Number(libraryId), Number(userId));
}

/**
 * 校验当前用户能否访问某视频行（需带 library_id 字段）。
 * 管理员：存在即可；普通用户：媒体库启用 + 已授权，否则一律 404（不泄露存在性）。
 * @param {{id:number, role:string}|null} user req.user（authGate 保证已登录）
 * @param {{library_id:number}|null} video 视频原始行
 */
function assertVideoVisible(user, video) {
  if (!video) throw httpError(404, '视频不存在');
  if (user && user.role === 'admin') return;
  const uidNum = user && user.id ? Number(user.id) : 0;
  if (!uidNum || !isLibraryEnabled(video.library_id) || !hasLibraryAccess(uidNum, video.library_id)) {
    throw httpError(404, '视频不存在');
  }
}

/* ------------------------------------------------------------------ *
 * 用户状态写入
 * ------------------------------------------------------------------ */

/** 设置收藏 */
function setFavorite(userId, videoId, favorite) {
  db.prepare(`
    INSERT INTO user_video_state (user_id, video_id, favorite, updated_at)
    VALUES (@uid, @vid, @fav, datetime('now','localtime'))
    ON CONFLICT(user_id, video_id) DO UPDATE SET
      favorite   = excluded.favorite,
      updated_at = datetime('now','localtime')
  `).run({ uid: Number(userId), vid: Number(videoId), fav: favorite ? 1 : 0 });
}

/** 保存观看进度 */
function saveProgress(userId, videoId, progress, duration) {
  db.prepare(`
    INSERT INTO user_video_state
      (user_id, video_id, play_progress, play_duration, last_played, updated_at)
    VALUES
      (@uid, @vid, @progress, @duration, datetime('now','localtime'), datetime('now','localtime'))
    ON CONFLICT(user_id, video_id) DO UPDATE SET
      play_progress = excluded.play_progress,
      play_duration = excluded.play_duration,
      last_played   = datetime('now','localtime'),
      updated_at    = datetime('now','localtime')
  `).run({
    uid: Number(userId),
    vid: Number(videoId),
    progress: Number(progress) || 0,
    duration: Number(duration) || 0,
  });
}

/** 清空观看进度（仅本用户） */
function clearProgress(userId, videoId) {
  db.prepare(`
    UPDATE user_video_state SET
      play_progress = 0,
      play_duration = 0,
      last_played   = NULL,
      updated_at    = datetime('now','localtime')
    WHERE user_id = ? AND video_id = ?
  `).run(Number(userId), Number(videoId));
}

module.exports = {
  VIDEO_COLS,
  JOIN_STATE,
  FROM_ACTIVE,
  FROM_ACTIVE_USER,
  FROM_ANY,
  SORT_MAP,
  listVideos,
  listRecent,
  listContinue,
  listHistory,
  search,
  splitKeywords,
  tagsByVideo,
  attachTags,
  find,
  findRaw,
  existsVisible,
  isLibraryEnabled,
  isAdminUser,
  getLibraryUserIds,
  setLibraryUsers,
  hasLibraryAccess,
  assertVideoVisible,
  setFavorite,
  saveProgress,
  clearProgress,
};
