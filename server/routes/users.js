'use strict';

/**
 * 用户管理 API —— 全部接口仅管理员可用。
 *
 *   GET    /api/users              列表
 *   POST   /api/users              新增
 *   PATCH  /api/users/:id          改显示名 / 角色 / 启用状态
 *   DELETE /api/users/:id          删除
 *   POST   /api/users/:id/password 重置密码
 *
 * 安全约束：
 * - 不能禁用 / 删除 / 降级自己（避免把自己锁在门外）
 * - 不能移除最后一个启用状态的管理员
 */

const express = require('express');

const db = require('../db');
const logger = require('../utils/logger');
const { httpError } = require('../middleware/error');
const { requireAdmin } = require('../middleware/auth');
const {
  hashPassword,
  sanitizeUser,
  findById,
  findByUsername,
  countEnabledAdmins,
  deleteUserSessions,
} = require('../services/auth');

const router = express.Router();

router.use(requireAdmin);

const USERNAME_RE = /^[A-Za-z0-9_\u4e00-\u9fa5.-]{2,32}$/;
const ROLES = ['admin', 'user'];

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 6) {
    throw httpError(400, '密码至少 6 位');
  }
  if (password.length > 128) throw httpError(400, '密码过长');
}

/** 判断某个用户是否是"最后一个启用管理员"，是则拒绝操作 */
function guardLastAdmin(user, actionText) {
  if (user.role !== 'admin' || !user.enabled) return;
  if (countEnabledAdmins(user.id) === 0) {
    throw httpError(400, '系统至少需要保留一个启用状态的管理员，无法' + actionText);
  }
}

// ---------- 列表 ----------

router.get('/', (req, res) => {
  const rows = db
    .prepare(
      'SELECT id, username, display_name, role, enabled, created_at, last_login FROM user ORDER BY id ASC'
    )
    .all();
  res.json(rows.map(sanitizeUser));
});

// ---------- 新增 ----------

router.post('/', (req, res) => {
  const { username, password, displayName, role } = req.body || {};

  if (typeof username !== 'string' || !USERNAME_RE.test(username.trim())) {
    throw httpError(400, '用户名需为 2-32 位的字母、数字、下划线、点、减号或中文');
  }
  validatePassword(password);

  const name = username.trim();
  if (findByUsername(name)) throw httpError(400, '用户名已存在: ' + name);

  const finalRole = ROLES.includes(role) ? role : 'user';
  const display = typeof displayName === 'string' && displayName.trim() ? displayName.trim() : name;

  const info = db
    .prepare(
      'INSERT INTO user (username, password_hash, display_name, role, enabled) VALUES (?, ?, ?, ?, 1)'
    )
    .run(name, hashPassword(password), display, finalRole);

  logger.info('[users] 新增用户:', name, '(' + finalRole + ')');
  res.json({ id: info.lastInsertRowid });
});

// ---------- 修改 ----------

router.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  const user = findById(id);
  if (!user) throw httpError(404, '用户不存在');

  const { displayName, role, enabled } = req.body || {};
  const isSelf = id === req.user.id;

  if (isSelf && (role !== undefined || enabled !== undefined)) {
    throw httpError(400, '不能修改自己的角色或启用状态');
  }

  const next = {
    display_name:
      typeof displayName === 'string' && displayName.trim() ? displayName.trim() : user.display_name,
    role: ROLES.includes(role) ? role : user.role,
    enabled: enabled === undefined || enabled === null ? user.enabled : enabled ? 1 : 0,
  };

  if ((next.role !== 'admin' || !next.enabled) && user.role === 'admin' && user.enabled) {
    guardLastAdmin(user, next.role !== 'admin' ? '修改其角色' : '禁用它');
  }

  db.prepare('UPDATE user SET display_name = ?, role = ?, enabled = ? WHERE id = ?').run(
    next.display_name,
    next.role,
    next.enabled,
    id
  );

  // 被禁用 → 立即踢下线
  if (!next.enabled && user.enabled) {
    deleteUserSessions(id);
    logger.info('[users] 已禁用用户并清除其会话:', user.username);
  } else {
    logger.info('[users] 更新用户:', user.username);
  }

  res.json({ ok: true });
});

// ---------- 重置密码 ----------

router.post('/:id/password', (req, res) => {
  const id = Number(req.params.id);
  const user = findById(id);
  if (!user) throw httpError(404, '用户不存在');

  const { password } = req.body || {};
  validatePassword(password);

  db.prepare('UPDATE user SET password_hash = ? WHERE id = ?').run(hashPassword(password), id);

  // 重置密码后强制该用户重新登录
  if (id !== req.user.id) deleteUserSessions(id);

  logger.info('[users] 重置密码:', user.username);
  res.json({ ok: true });
});

// ---------- 删除 ----------

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const user = findById(id);
  if (!user) throw httpError(404, '用户不存在');

  if (id === req.user.id) throw httpError(400, '不能删除当前登录的账号');
  guardLastAdmin(user, '删除');

  db.prepare('DELETE FROM user WHERE id = ?').run(id); // 会话随外键级联删除

  logger.info('[users] 删除用户:', user.username);
  res.json({ ok: true });
});

module.exports = router;
