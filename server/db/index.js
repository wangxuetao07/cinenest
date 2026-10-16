'use strict';

/**
 * 数据库连接单例。
 * better-sqlite3 同步 API，进程内单连接即可。
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('../utils/logger');
const { setupNativeAbi, abiHint } = require('../utils/nativeAbi');

// better-sqlite3 是原生模块，ABI 必须与当前 Node 大版本一致。
// 这里先按 process.versions.modules 从 vendor/sqlite3 落位对应二进制，
// 再加载模块——顺序不能调换，否则 bindings 会先解析到不匹配的那份。
setupNativeAbi(logger);
const Database = require('better-sqlite3');

// 确保 data 目录存在
if (!fs.existsSync(config.dataDir)) {
  fs.mkdirSync(config.dataDir, { recursive: true });
}

let db;
try {
  db = new Database(config.dbFile);
} catch (err) {
  // 原生模块的 dlopen 是在第一次 new Database() 时发生的，
  // 所以 ABI 不匹配的报错只能在这里捕获，转成带排查步骤的提示。
  const msg = abiHint(err);
  if (msg !== (err && err.message)) throw new Error(msg);
  throw err;
}

// 必要 PRAGMA
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

module.exports = db;
