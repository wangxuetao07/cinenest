PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS library (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  path        TEXT NOT NULL UNIQUE,
  scan_cron   TEXT DEFAULT '0 3 * * *',
  enabled     INTEGER DEFAULT 1,
  created_at  TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS video (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  library_id    INTEGER NOT NULL REFERENCES library(id) ON DELETE CASCADE,
  file_path     TEXT NOT NULL UNIQUE,
  file_name     TEXT NOT NULL,
  title         TEXT,
  ext           TEXT,
  size          INTEGER,
  mtime         INTEGER,
  duration      REAL,
  width         INTEGER,
  height        INTEGER,
  video_codec   TEXT,
  audio_codec   TEXT,
  bitrate       INTEGER,
  thumb_path    TEXT,
  poster_path   TEXT,
  -- v1.3：进度条抽帧预览（精灵图）。sprite_path 为绝对路径，
  -- sprite_meta 为 JSON：{number,column,row,width,height}，供前端直接赋值使用。
  sprite_path   TEXT,
  sprite_meta   TEXT,
  -- v1.4：卡片悬停播放的预览片段（H.264 MP4，全片均匀 5 段拼接）。
  -- preview_path 为绝对路径，API 输出时序列化为 /api/preview/:id?v=<mtime>。
  preview_path  TEXT,
  favorite      INTEGER DEFAULT 0,
  play_progress REAL DEFAULT 0,
  play_duration REAL DEFAULT 0,
  last_played   TEXT,
  added_at      TEXT DEFAULT (datetime('now','localtime')),
  updated_at    TEXT DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_video_library ON video(library_id);
CREATE INDEX IF NOT EXISTS idx_video_added   ON video(added_at DESC);
CREATE INDEX IF NOT EXISTS idx_video_title   ON video(title);

CREATE TABLE IF NOT EXISTS tag (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS video_tag (
  video_id INTEGER NOT NULL REFERENCES video(id) ON DELETE CASCADE,
  tag_id   INTEGER NOT NULL REFERENCES tag(id)   ON DELETE CASCADE,
  PRIMARY KEY (video_id, tag_id)
);

-- playlist.user_id 为 v1.2 新增列：见 migrate.js 的 ensureColumns（存量库需 ALTER TABLE）
-- 对应索引 idx_playlist_user 也由 migrate.js 在其后创建（新库/老库统一处理）
CREATE TABLE IF NOT EXISTS playlist (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER REFERENCES user(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS playlist_item (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  playlist_id INTEGER NOT NULL REFERENCES playlist(id) ON DELETE CASCADE,
  video_id    INTEGER NOT NULL REFERENCES video(id)    ON DELETE CASCADE,
  sort        INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS scan_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  library_id  INTEGER REFERENCES library(id) ON DELETE CASCADE,
  started_at  TEXT,
  finished_at TEXT,
  added       INTEGER DEFAULT 0,
  updated     INTEGER DEFAULT 0,
  deleted     INTEGER DEFAULT 0,
  failed      INTEGER DEFAULT 0,
  -- v1.3：因「疑似存储离线」被删除闸门拦下的缺失记录数（>0 表示本次未执行删除）
  blocked     INTEGER DEFAULT 0,
  message     TEXT
);

CREATE TABLE IF NOT EXISTS setting (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- ---------- 账号与登录（v1.1 新增） ----------

CREATE TABLE IF NOT EXISTS user (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name  TEXT,
  role          TEXT NOT NULL DEFAULT 'user',   -- admin | user
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT DEFAULT (datetime('now','localtime')),
  last_login    TEXT
);

CREATE TABLE IF NOT EXISTS session (
  token_hash  TEXT PRIMARY KEY,                 -- sha256(原始 token)，不落库明文
  user_id     INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  created_at  TEXT DEFAULT (datetime('now','localtime')),
  expires_at  INTEGER NOT NULL,                 -- epoch 毫秒
  user_agent  TEXT
);

CREATE INDEX IF NOT EXISTS idx_session_user    ON session(user_id);
CREATE INDEX IF NOT EXISTS idx_session_expires ON session(expires_at);

-- ---------- 用户维度视频状态（v1.2 新增） ----------
-- 收藏 / 观看进度 / 最后播放时间改为「每个账号一份」。
-- video 表上同名的旧字段（favorite / play_progress / play_duration / last_played）
-- 自 v1.2 起不再被读写，仅作为迁移来源保留。

CREATE TABLE IF NOT EXISTS user_video_state (
  user_id       INTEGER NOT NULL REFERENCES user(id)  ON DELETE CASCADE,
  video_id      INTEGER NOT NULL REFERENCES video(id) ON DELETE CASCADE,
  favorite      INTEGER NOT NULL DEFAULT 0,
  play_progress REAL    NOT NULL DEFAULT 0,
  play_duration REAL    NOT NULL DEFAULT 0,
  last_played   TEXT,
  updated_at    TEXT DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (user_id, video_id)
);

CREATE INDEX IF NOT EXISTS idx_uvs_user_fav    ON user_video_state(user_id, favorite);
CREATE INDEX IF NOT EXISTS idx_uvs_user_played ON user_video_state(user_id, last_played);
CREATE INDEX IF NOT EXISTS idx_uvs_video       ON user_video_state(video_id);
