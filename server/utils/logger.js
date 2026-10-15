'use strict';

/**
 * 日志工具：启动日志 / 扫描日志 / 错误日志 分开输出。
 * 错误日志写入 data/error.log，单文件超过 10MB 时轮转为 error.log.1。
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');

const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB

function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
  );
}

/** 文件日志轮转写入 */
function writeFileLog(file, line) {
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_LOG_SIZE) {
      const rotated = file + '.1';
      try { fs.rmSync(rotated, { force: true }); } catch (_) { /* ignore */ }
      fs.renameSync(file, rotated);
    }
    fs.appendFileSync(file, line + '\n', 'utf8');
  } catch (_) {
    // 日志失败绝不影响主流程
  }
}

const logger = {
  /** 启动/运行日志 */
  info(...args) {
    const line = '[' + ts() + '] [INFO] ' + args.map(fmt).join(' ');
    console.log(line);
  },

  /** 警告 */
  warn(...args) {
    const line = '[' + ts() + '] [WARN] ' + args.map(fmt).join(' ');
    console.warn(line);
  },

  /** 扫描日志 */
  scan(...args) {
    const line = '[' + ts() + '] [SCAN] ' + args.map(fmt).join(' ');
    console.log(line);
  },

  /** 错误日志：打印 + 落盘 */
  error(...args) {
    const body = args.map(fmt).join(' ');
    const line = '[' + ts() + '] [ERROR] ' + body;
    console.error(line);
    writeFileLog(config.errorLog, line);
  },
};

function fmt(v) {
  if (v instanceof Error) return v.stack || v.message;
  if (typeof v === 'object' && v !== null) {
    try { return JSON.stringify(v); } catch (_) { return String(v); }
  }
  return String(v);
}

module.exports = logger;
