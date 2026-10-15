'use strict';

/**
 * 账号 / 会话服务。
 *
 * 设计要点：
 * - 密码用 node:crypto 的 scrypt 加盐哈希，格式 `scrypt$<salt>$<hash>`，不引入外部依赖。
 * - 登录凭证是 32 字节随机 token，落库前做 sha256，数据库被读走也无法直接冒用。
 * - 会话通过 HttpOnly Cookie 下发，这样 <video src="/api/stream/1">、<img src="/api/thumb/1">
 *   这类浏览器原生发起的请求无需额外处理即可带上身份。
 */

const crypto = require('crypto');
const db = require('../db');
const logger = require('../utils/logger');

const COOKIE_NAME = 'cn_token';
const SESSION_DAYS = 30;
const SCRYPT_KEYLEN = 64;

// 首次启动时自动创建的管理员
const DEFAULT_ADMIN = { username: 'admin', password: 'admin123', displayName: '管理员' };

/* ------------------------------------------------------------------ *
 * 密码
 * ------------------------------------------------------------------ */

/**
 * 生成密码哈希。
 * @param {string} password 明文
 * @param {string} [salt] 复用盐（校验时不需要，仅供外部指定）
 */
function hashPassword(password, salt) {
  const useSalt = salt || crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(password), useSalt, SCRYPT_KEYLEN).toString('hex');
  return 'scrypt$' + useSalt + '$' + derived;
}

/**
 * 校验密码（定长比较，防时序侧信道）。
 */
function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || !stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;

  const salt = parts[1];
  const expected = Buffer.from(parts[2], 'hex');
  let actual;
  try {
    actual = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN);
  } catch (_) {
    return false;
  }
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

/* ------------------------------------------------------------------ *
 * 会话
 * ------------------------------------------------------------------ */

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/**
 * 创建会话。
 * @returns {{token: string, expiresAt: number}}
 */
function createSession(userId, userAgent) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  db.prepare(
    'INSERT INTO session (token_hash, user_id, expires_at, user_agent) VALUES (?, ?, ?, ?)'
  ).run(hashToken(token), userId, expiresAt, String(userAgent || '').slice(0, 200));
  return { token, expiresAt };
}

/**
 * 由 token 取当前用户（含登录态校验）。
 * @returns {object|null} 已脱敏的用户对象
 */
function getSessionUser(token) {
  if (!token) return null;
  const row = db
    .prepare(
      'SELECT s.expires_at, u.* FROM session s JOIN user u ON u.id = s.user_id WHERE s.token_hash = ?'
    )
    .get(hashToken(token));
  if (!row) return null;

  if (Number(row.expires_at) <= Date.now()) {
    deleteSession(token);
    return null;
  }
  if (!row.enabled) return null;
  return sanitizeUser(row);
}

function deleteSession(token) {
  if (!token) return;
  db.prepare('DELETE FROM session WHERE token_hash = ?').run(hashToken(token));
}

function deleteUserSessions(userId) {
  db.prepare('DELETE FROM session WHERE user_id = ?').run(Number(userId));
}

/** 清理过期会话 */
function cleanupSessions() {
  const info = db.prepare('DELETE FROM session WHERE expires_at <= ?').run(Date.now());
  return info.changes;
}

/* ------------------------------------------------------------------ *
 * 用户
 * ------------------------------------------------------------------ */

/** 输出给前端的用户对象（剔除 password_hash） */
function sanitizeUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    display_name: row.display_name || row.username,
    role: row.role === 'admin' ? 'admin' : 'user',
    enabled: row.enabled ? 1 : 0,
    created_at: row.created_at,
    last_login: row.last_login || null,
  };
}

function findByUsername(username) {
  if (!username) return null;
  return db.prepare('SELECT * FROM user WHERE username = ?').get(String(username).trim());
}

function findById(id) {
  return db.prepare('SELECT * FROM user WHERE id = ?').get(Number(id));
}

function touchLastLogin(id) {
  db.prepare("UPDATE user SET last_login = datetime('now','localtime') WHERE id = ?").run(Number(id));
}

/** 启用状态的管理员数量（用于"最后一个管理员"保护） */
function countEnabledAdmins(excludeId) {
  const row = db
    .prepare("SELECT COUNT(1) AS c FROM user WHERE role = 'admin' AND enabled = 1 AND id <> ?")
    .get(Number(excludeId) || 0);
  return row.c;
}

/**
 * 首次启动引导：没有任何用户时创建默认管理员。
 * 同时清理 v1.0 遗留的单一密码设置项。
 * @returns {{username:string,password:string}|null} 新建时返回账号信息
 */
function ensureDefaultAdmin() {
  // 清掉 v1.0 的 auth.* 设置，避免和新体系混淆
  db.prepare("DELETE FROM setting WHERE key IN ('auth.enabled','auth.password')").run();

  const { c } = db.prepare('SELECT COUNT(1) AS c FROM user').get();
  if (c > 0) return null;

  db.prepare(
    'INSERT INTO user (username, password_hash, display_name, role, enabled) VALUES (?, ?, ?, ?, 1)'
  ).run(
    DEFAULT_ADMIN.username,
    hashPassword(DEFAULT_ADMIN.password),
    DEFAULT_ADMIN.displayName,
    'admin'
  );

  return { username: DEFAULT_ADMIN.username, password: DEFAULT_ADMIN.password };
}

/** 会话定期清理（每小时，不阻塞进程退出） */
function startSessionJanitor() {
  cleanupSessions();
  const timer = setInterval(() => {
    try {
      const n = cleanupSessions();
      if (n) logger.info('[auth] 已清理过期会话 ' + n + ' 条');
    } catch (err) {
      logger.warn('[auth] 清理会话失败:', err.message);
    }
  }, 60 * 60 * 1000);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = {
  COOKIE_NAME,
  SESSION_DAYS,
  DEFAULT_ADMIN,
  hashPassword,
  verifyPassword,
  createSession,
  getSessionUser,
  deleteSession,
  deleteUserSessions,
  cleanupSessions,
  sanitizeUser,
  findByUsername,
  findById,
  touchLastLogin,
  countEnabledAdmins,
  ensureDefaultAdmin,
  startSessionJanitor,
};
