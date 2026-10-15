'use strict';

/**
 * 数据库连接单例。
 * better-sqlite3 同步 API，进程内单连接即可。
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../config');

// 确保 data 目录存在
if (!fs.existsSync(config.dataDir)) {
  fs.mkdirSync(config.dataDir, { recursive: true });
}

const db = new Database(config.dbFile);

// 必要 PRAGMA
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

module.exports = db;
