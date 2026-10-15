'use strict';

/**
 * 统一错误处理中间件。
 * - 业务错误：err.status 存在则用其状态码
 * - 未捕获异常：500 + 写 data/error.log
 */

const logger = require('../utils/logger');

// 404（仅在无路由匹配时触发，挂在所有路由之后）
function notFound(req, res) {
  res.status(404).json({ error: '接口不存在: ' + req.method + ' ' + req.path });
}

// 错误兜底
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const status = Number(err && err.status) || 500;
  const message = (err && err.message) || 'Internal Server Error';

  if (status >= 500) {
    logger.error('[http]', req.method, req.originalUrl, '-', err);
  }

  if (res.headersSent) {
    return res.end();
  }
  res.status(status).json({ error: message });
}

/** 业务错误工厂：抛出后由 errorHandler 统一处理 */
function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/**
 * 包裹 async 路由处理器，将 rejection 转发给 errorHandler。
 * （Express 4 不会自动捕获 async 异常）
 * @param {(req:any,res:any,next:any)=>Promise<any>} fn
 */
function asyncHandler(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = { notFound, errorHandler, httpError, asyncHandler };
