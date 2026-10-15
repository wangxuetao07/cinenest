'use strict';

/**
 * 影巢 CineNest 服务入口。
 */

const path = require('path');
const fs = require('fs');
const express = require('express');

const config = require('./config');
const logger = require('./utils/logger');
const { migrate, migrateLegacyUserState } = require('./db/migrate');
const { notFound, errorHandler } = require('./middleware/error');
const { attachUser, authGate, requireAdmin } = require('./middleware/auth');
const { ensureDefaultAdmin, startSessionJanitor } = require('./services/auth');
const hls = require('./services/hls');

const authRoute = require('./routes/auth');
const usersRoute = require('./routes/users');
const librariesRoute = require('./routes/libraries');
const videosRoute = require('./routes/videos');
const streamRoutes = require('./routes/stream');
const historyRoute = require('./routes/history');
const playlistsRoute = require('./routes/playlists');
const searchRoute = require('./routes/search');
const settingsRoute = require('./routes/settings');
const spriteRoute = require('./routes/sprite');
const previewRoute = require('./routes/preview');

const watcher = require('./services/watcher');
const scheduler = require('./services/scheduler');

// ---------- 1. 环境自检（缺 ffmpeg 直接退出） ----------
config.assertEnvironment();

// ---------- 2. 数据库迁移 ----------
const { tables, addedColumns } = migrate();
logger.info('数据库就绪：' + tables.length + ' 张表 → ' + tables.join(', '));
if (addedColumns.length) {
  logger.info('增量列已补齐：' + addedColumns.join(', '));
}

// 首次启动引导：无任何账号时创建默认管理员
const bootstrapAdmin = ensureDefaultAdmin();
if (bootstrapAdmin) {
  logger.warn('========================================');
  logger.warn('  已创建默认管理员账号');
  logger.warn('    用户名: ' + bootstrapAdmin.username);
  logger.warn('    密  码: ' + bootstrapAdmin.password);
  logger.warn('  请登录后立即在「用户管理 / 右上角头像」中修改密码');
  logger.warn('========================================');
}

// 存量数据搬迁：v1.1 的全站共享收藏/进度/播放列表 → 管理员账号（仅执行一次）
const legacyState = migrateLegacyUserState();
if (legacyState) {
  logger.info(
    '[迁移] 单用户状态已归属到用户 #' + legacyState.owner +
    '：观看状态 ' + legacyState.states + ' 条，播放列表 ' + legacyState.playlists + ' 个'
  );
}

startSessionJanitor();

// ---------- 3. Express ----------
const app = express();
app.disable('x-powered-by');

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false, limit: '2mb' }));

// 简易请求日志
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    if (req.path.startsWith('/api')) {
      logger.info('[http]', req.method, req.originalUrl, res.statusCode, (Date.now() - start) + 'ms');
    }
  });
  next();
});

// 健康检查（匿名可访问，鉴权门之前）
app.get('/api/health', (req, res) => {
  res.json({ ok: true, name: 'CineNest', version: '1.2.0' });
});

// ---------- 4. 鉴权 ----------
// attachUser：解析身份（不拦截）；authGate：除 /api/auth/login 外一律要求登录
app.use('/api', attachUser);
app.use('/api', authGate);

// 登录 / 退出 / 当前用户 / 改密码
app.use('/api/auth', authRoute);

// 用户管理（仅管理员）
app.use('/api/users', usersRoute);

// ---------- 5. 业务路由 ----------
app.use('/api/libraries', librariesRoute.router);
app.use('/api/tasks', requireAdmin, librariesRoute.tasks);
app.use('/api/videos', videosRoute.router);
app.use('/api/favorites', videosRoute.favorites);
app.use('/api/history', historyRoute);
app.use('/api/playlists', playlistsRoute);
app.use('/api/search', searchRoute);
app.use('/api/settings', settingsRoute);
app.use('/api/stream', streamRoutes.stream);
app.use('/api/thumb', streamRoutes.thumb);
app.use('/api/poster', streamRoutes.poster);
app.use('/api/subtitle', streamRoutes.subtitle);
app.use('/api/sprite', spriteRoute);
app.use('/api/preview', previewRoute);

// ---------- 6. 静态资源（dist） ----------
const distDir = config.distDir;
const indexHtml = path.join(distDir, 'index.html');
const hasDist = fs.existsSync(indexHtml);

if (hasDist) {
  app.use(express.static(distDir, { index: false, maxAge: '1h' }));
} else {
  logger.warn('未找到前端构建产物 dist/index.html，请先执行 npm run build');
}

// 非 /api 请求回落 index.html（SPA）
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  if (!hasDist) {
    return res
      .status(200)
      .type('html')
      .send(
        '<!doctype html><meta charset="utf-8"><title>影巢 CineNest</title>' +
        '<body style="font-family:system-ui;background:#0f1115;color:#e6e8ee;padding:40px">' +
        '<h1>影巢 CineNest 后端已启动</h1>' +
        '<p>尚未构建前端。请执行 <code>npm run build</code> 后刷新。</p>' +
        '<p>API 健康检查：<a style="color:#4f8cff" href="/api/health">/api/health</a></p>'
      );
  }
  res.sendFile(indexHtml);
});

// ---------- 7. 错误处理 ----------
app.use('/api', notFound);
app.use(errorHandler);

// ---------- 8. 自动化 ----------
try {
  watcher.startAll();
} catch (err) {
  logger.error('[watcher] 启动失败:', err.message);
}
try {
  scheduler.startAll();
} catch (err) {
  logger.error('[scheduler] 启动失败:', err.message);
}
// HLS 转码会话：清理上次进程残留的临时分片目录 + 空闲回收
try {
  hls.init();
} catch (err) {
  logger.error('[hls] 初始化失败:', err.message);
}

// ---------- 9. 监听 ----------
const server = app.listen(config.port, config.host, () => {
  logger.info('========================================');
  logger.info('  影巢 CineNest v1.2 已启动');
  logger.info('  本机:   http://localhost:' + config.port);
  logger.info('  局域网: http://<本机IP>:' + config.port);
  logger.info('  数据目录: ' + config.dataDir);
  logger.info('  ffmpeg:  ' + config.ffmpeg);
  logger.info('  登录:   已开启（管理员 / 普通用户）');
  logger.info('  收藏/进度/播放列表: 按账号隔离');
  logger.info('  m3u8:   本地 HLS 直出 + 按需转码');
  logger.info('========================================');
});

// ---------- 10. 进程级异常兜底 ----------
process.on('uncaughtException', (err) => {
  logger.error('[uncaughtException]', err);
});
process.on('unhandledRejection', (reason) => {
  logger.error('[unhandledRejection]', reason);
});

async function shutdown(signal) {
  logger.info('收到 ' + signal + '，正在关闭...');
  server.close();
  try { hls.stopAll(); } catch (_) { /* ignore */ }
  try { await watcher.stopAll(); } catch (_) { /* ignore */ }
  try { scheduler.stopAll(); } catch (_) { /* ignore */ }
  setTimeout(() => process.exit(0), 200);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = app;
