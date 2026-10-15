'use strict';

/**
 * 认证 API。
 *
 *   POST /api/auth/login     登录（匿名可访问）
 *   POST /api/auth/logout    退出登录
 *   GET  /api/auth/me        当前登录用户
 *   POST /api/auth/password  修改自己的密码
 */

const express = require('express');

const db = require('../db');
const logger = require('../utils/logger');
const { httpError, asyncHandler } = require('../middleware/error');
const { requireAuth, setAuthCookie, clearAuthCookie } = require('../middleware/auth');
const {
  hashPassword,
  verifyPassword,
  createSession,
  deleteSession,
  sanitizeUser,
  findByUsername,
  findById,
  touchLastLogin,
} = require('../services/auth');

const router = express.Router();

/* ------------------------------------------------------------------ *
 * 登录限流：同一 IP+用户名 5 分钟内最多 10 次失败
 * ------------------------------------------------------------------ */

const MAX_ATTEMPTS = 10;
const WINDOW_MS = 5 * 60 * 1000;
const attempts = new Map(); // key → { count, first, blockedUntil }

function rateKey(req, username) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  return ip + '|' + String(username || '').trim().toLowerCase();
}

function checkRateLimit(key) {
  const rec = attempts.get(key);
  if (!rec) return;
  if (rec.blockedUntil && rec.blockedUntil > Date.now()) {
    const sec = Math.ceil((rec.blockedUntil - Date.now()) / 1000);
    throw httpError(429, '尝试过于频繁，请 ' + sec + ' 秒后再试');
  }
}

function markFailure(key) {
  const now = Date.now();
  let rec = attempts.get(key);
  if (!rec || now - rec.first > WINDOW_MS) {
    rec = { count: 0, first: now, blockedUntil: 0 };
  }
  rec.count += 1;
  if (rec.count >= MAX_ATTEMPTS) rec.blockedUntil = now + WINDOW_MS;
  attempts.set(key, rec);
}

function clearFailures(key) {
  attempts.delete(key);
}

// 定期回收，避免 Map 无限增长
const janitor = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of attempts) {
    const stale = now - v.first > WINDOW_MS && (!v.blockedUntil || v.blockedUntil <= now);
    if (stale) attempts.delete(k);
  }
}, WINDOW_MS);
if (janitor.unref) janitor.unref();

/* ------------------------------------------------------------------ *
 * 接口
 * ------------------------------------------------------------------ */

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || !username.trim() || typeof password !== 'string' || !password) {
    throw httpError(400, '请输入用户名和密码');
  }

  const key = rateKey(req, username);
  checkRateLimit(key);

  const user = findByUsername(username);
  if (!user || !verifyPassword(password, user.password_hash)) {
    markFailure(key);
    throw httpError(401, '用户名或密码错误');
  }
  if (!user.enabled) {
    throw httpError(403, '该账号已被禁用，请联系管理员');
  }

  clearFailures(key);
  touchLastLogin(user.id);

  const { token, expiresAt } = createSession(user.id, req.headers['user-agent']);
  setAuthCookie(res, token, expiresAt);

  logger.info('[auth] 登录成功:', user.username, '(' + user.role + ')');
  res.json({ user: sanitizeUser(findById(user.id)) });
});

router.post('/logout', (req, res) => {
  if (req.token) deleteSession(req.token);
  clearAuthCookie(res);
  res.json({ ok: true });
});

// 当前登录用户（匿名时返回 user: null，避免前端探测身份产生 401 噪音）
router.get('/me', (req, res) => {
  res.json({ user: req.user || null });
});

// 修改自己的密码（需提供原密码）
router.post('/password', requireAuth, (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (typeof newPassword !== 'string' || newPassword.length < 6) {
    throw httpError(400, '新密码至少 6 位');
  }
  if (newPassword.length > 128) {
    throw httpError(400, '新密码过长');
  }

  const row = findById(req.user.id);
  if (!row) throw httpError(404, '用户不存在');
  if (!verifyPassword(oldPassword || '', row.password_hash)) {
    throw httpError(400, '原密码不正确');
  }

  db.prepare('UPDATE user SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), row.id);
  logger.info('[auth] 用户修改密码:', row.username);
  res.json({ ok: true });
});

module.exports = router;
