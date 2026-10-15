'use strict';

/**
 * 启动迁移：执行 schema.sql + 增量补列 + 存量数据搬迁，全部幂等。
 * 可被 server 启动流程 require 调用，也可单独运行：
 *   node server/db/migrate.js
 *
 * 顺序很重要（见 index.js）：
 *   migrate()              → 建表 / 补列
 *   ensureDefaultAdmin()   → 保证至少有一个账号
 *   migrateLegacyUserState() → 把 v1.1 的单用户状态挂到管理员名下
 */

const fs = require('fs');
const path = require('path');
const db = require('./index');

const SCHEMA_FILE = path.join(__dirname, 'schema.sql');

/** 一次性迁移标记（存 setting 表） */
const FLAG_USER_STATE = 'migration.user_state_v1';

/** 表是否存在某列 */
function hasColumn(table, column) {
  const rows = db.prepare('PRAGMA table_info(' + table + ')').all();
  return rows.some((r) => r.name === column);
}

function getSetting(key) {
  const row = db.prepare('SELECT value FROM setting WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

/**
 * v1.2 / v1.3 增量列：schema.sql 里的 CREATE TABLE IF NOT EXISTS 不会给存量表补列。
 * 依赖新列的索引必须在这里建（schema.sql 跑在补列之前，建索引会报 no such column）。
 * @returns {string[]} 本次新增的列
 */
function ensureColumns() {
  const added = [];
  if (!hasColumn('playlist', 'user_id')) {
    db.exec('ALTER TABLE playlist ADD COLUMN user_id INTEGER REFERENCES user(id) ON DELETE CASCADE');
    added.push('playlist.user_id');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_playlist_user ON playlist(user_id)');

  // v1.3：抽帧预览（精灵图）
  if (!hasColumn('video', 'sprite_path')) {
    db.exec('ALTER TABLE video ADD COLUMN sprite_path TEXT');
    added.push('video.sprite_path');
  }
  if (!hasColumn('video', 'sprite_meta')) {
    db.exec('ALTER TABLE video ADD COLUMN sprite_meta TEXT');
    added.push('video.sprite_meta');
  }

  // v1.4：卡片悬停预览片段（MP4）
  if (!hasColumn('video', 'preview_path')) {
    db.exec('ALTER TABLE video ADD COLUMN preview_path TEXT');
    added.push('video.preview_path');
  }

  // v1.3：扫描删除闸门（因疑似存储离线被拦下的缺失记录数）
  if (!hasColumn('scan_log', 'blocked')) {
    db.exec('ALTER TABLE scan_log ADD COLUMN blocked INTEGER DEFAULT 0');
    added.push('scan_log.blocked');
  }

  return added;
}

/**
 * 执行建表脚本（幂等，可重复调用）。
 * @returns {{tables: string[], addedColumns: string[]}}
 */
function migrate() {
  const sql = fs.readFileSync(SCHEMA_FILE, 'utf8');
  db.exec(sql);

  const addedColumns = ensureColumns();

  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name);

  return { tables, addedColumns };
}

/**
 * v1.2 存量数据搬迁：把 v1.1「全站共享」的收藏 / 观看进度 / 播放列表，
 * 全部归属给 ID 最小的管理员账号，然后清空 video 表上的旧字段。
 *
 * 必须在 ensureDefaultAdmin() 之后调用，否则新库拿不到归属账号。
 *
 * @returns {{owner:number|null, states:number, playlists:number}|null} 本次迁移结果（已迁移过返回 null）
 */
function migrateLegacyUserState() {
  if (getSetting(FLAG_USER_STATE) === 'done') return null;

  const owner =
    db.prepare("SELECT id FROM user WHERE role = 'admin' AND enabled = 1 ORDER BY id ASC LIMIT 1").get() ||
    db.prepare('SELECT id FROM user ORDER BY id ASC LIMIT 1').get();

  if (!owner) {
    // 还没有任何账号：等下一次启动（届时默认管理员已创建）再迁移
    const legacy = db
      .prepare('SELECT COUNT(1) AS c FROM video WHERE favorite <> 0 OR play_progress <> 0 OR last_played IS NOT NULL')
      .get().c;
    const orphans = db.prepare('SELECT COUNT(1) AS c FROM playlist WHERE user_id IS NULL').get().c;
    if (legacy === 0 && orphans === 0) {
      // 全新库，无需搬迁，直接标记完成
      setSetting(FLAG_USER_STATE, 'done');
      return { owner: null, states: 0, playlists: 0 };
    }
    return null;
  }

  const result = { owner: owner.id, states: 0, playlists: 0 };

  const tx = db.transaction(() => {
    const info = db
      .prepare(`
        INSERT OR IGNORE INTO user_video_state
          (user_id, video_id, favorite, play_progress, play_duration, last_played)
        SELECT @uid, id, favorite, play_progress, play_duration, last_played
        FROM video
        WHERE favorite = 1 OR play_progress > 0 OR last_played IS NOT NULL
      `)
      .run({ uid: owner.id });
    result.states = info.changes;

    result.playlists = db
      .prepare('UPDATE playlist SET user_id = ? WHERE user_id IS NULL')
      .run(owner.id).changes;

    // 旧的 video 级字段清零：状态只保留一份，避免两处并存被误读
    db.prepare(`
      UPDATE video SET
        favorite = 0, play_progress = 0, play_duration = 0, last_played = NULL
      WHERE favorite <> 0 OR play_progress <> 0 OR play_duration <> 0 OR last_played IS NOT NULL
    `).run();

    setSetting(FLAG_USER_STATE, 'done');
  });
  tx();

  return result;
}

module.exports = { migrate, migrateLegacyUserState, ensureColumns, hasColumn };

// 作为脚本直接运行时执行
if (require.main === module) {
  try {
    const { tables, addedColumns } = migrate();
    console.log('[migrate] 数据库迁移完成，共 ' + tables.length + ' 张表：' + tables.join(', '));
    if (addedColumns.length) console.log('[migrate] 新增列：' + addedColumns.join(', '));
    const legacy = migrateLegacyUserState();
    if (legacy) {
      console.log(
        '[migrate] 存量状态搬迁 → 用户 #' + legacy.owner +
        '：观看状态 ' + legacy.states + ' 条，播放列表 ' + legacy.playlists + ' 个'
      );
    }
  } catch (err) {
    console.error('[migrate] 迁移失败：', err.message);
    process.exit(1);
  }
}
