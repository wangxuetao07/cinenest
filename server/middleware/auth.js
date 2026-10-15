'use strict';

/**
 * 鉴权中间件。
 *
 * - attachUser：解析 Cookie / Authorization，把 req.user 挂上去（不拦截）
 * - authGate：除 PUBLIC_PATHS 外一律要求登录
 * - requireAuth：未登录 → 401
 * - requireAdmin：非管理员 → 403
 *
 * 未引入 cookie-parser，手工解析请求头即可（Express 的 res.cookie 是内置的，
 * 但 req.cookies 需要额外依赖，这里不需要）。
 */

const { COOKIE_NAME, getSessionUser } = require('../services/auth');

/** 允许匿名访问的 /api 子路径（相对 /api 挂载点） */
const PUBLIC_PATHS = ['/auth/login', '/auth/me'];

/** 解析 Cookie 请求头 */
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const segment of String(header).split(';')) {
    const idx = segment.indexOf('=');
    if (idx < 0) continue;
    const key = segment.slice(0, idx).trim();
    if (!key) continue;
    let value = segment.slice(idx + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch (_) {
      /* 保留原值 */
    }
    out[key] = value;
  }
  return out;
}

/** 取凭证：优先 Cookie，其次 Authorization: Bearer */
function extractToken(req) {
  const cookies = req.cookies || parseCookies(req.headers.cookie);
  if (cookies[COOKIE_NAME]) return cookies[COOKIE_NAME];
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return null;
}

/** 全局前置：解析身份，不拦截 */
function attachUser(req, res, next) {
  req.cookies = parseCookies(req.headers.cookie);
  req.token = extractToken(req);
  req.user = req.token ? getSessionUser(req.token) : null;
  next();
}

/** 是否匿名可访问 */
function isPublicApiPath(req) {
  return PUBLIC_PATHS.includes(req.path);
}

/** 登录门：挂在 /api 上，命中 PUBLIC_PATHS 放行 */
function authGate(req, res, next) {
  if (isPublicApiPath(req)) return next();
  if (req.user) return next();
  res.status(401).json({ error: '未登录或登录已过期', code: 'UNAUTHORIZED' });
}

/** 已登录即可 */
function requireAuth(req, res, next) {
  if (req.user) return next();
  res.status(401).json({ error: '未登录或登录已过期', code: 'UNAUTHORIZED' });
}

/** 仅管理员 */
function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: '未登录或登录已过期', code: 'UNAUTHORIZED' });
  }
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: '该功能仅管理员可用', code: 'FORBIDDEN' });
  }
  next();
}

/**
 * 下发会话 Cookie。
 * HttpOnly：JS 读不到，降低 XSS 风险；SameSite=Lax：够用的 CSRF 防护。
 * 局域网多为 http，故不加 Secure。
 */
function setAuthCookie(res, token, expiresAt) {
  const maxAge = Math.max(0, Math.floor((Number(expiresAt) - Date.now()) / 1000));
  res.setHeader(
    'Set-Cookie',
    COOKIE_NAME + '=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAge
  );
}

/** 清除会话 Cookie */
function clearAuthCookie(res) {
  res.setHeader('Set-Cookie', COOKIE_NAME + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

module.exports = {
  COOKIE_NAME,
  PUBLIC_PATHS,
  parseCookies,
  extractToken,
  attachUser,
  authGate,
  requireAuth,
  requireAdmin,
  setAuthCookie,
  clearAuthCookie,
};
