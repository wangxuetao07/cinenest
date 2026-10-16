import axios, { type AxiosInstance } from 'axios';

/* ------------------------------------------------------------------ *
 * 类型定义
 * ------------------------------------------------------------------ */

export interface Library {
  id: number;
  name: string;
  path: string;
  scan_cron: string;
  enabled: number;
  created_at: string;
  video_count?: number;
}

export interface Video {
  id: number;
  library_id: number;
  file_path: string;
  file_name: string;
  title: string | null;
  ext: string;
  size: number;
  mtime: number;
  duration: number;
  width: number;
  height: number;
  video_codec: string | null;
  audio_codec: string | null;
  bitrate: number;
  thumb_path: string;
  poster_path: string;
  /** 卡片悬停预览片段 URL（v1.4）；null 表示尚未生成，悬停时会触发懒生成 */
  preview_path: string | null;
  favorite: number;
  play_progress: number;
  play_duration: number;
  last_played: string | null;
  added_at: string;
  updated_at: string;
  tags?: string[];
  /** 搜索命中：本次关键词 / 标签过滤命中的标签名 */
  matched_tags?: string[];
  sort?: number;
}

export interface Paged<T> {
  total: number;
  page: number;
  size: number;
  items: T[];
}

export interface ScanLog {
  id: number;
  library_id: number | null;
  library_name?: string | null;
  started_at: string | null;
  finished_at: string | null;
  added: number;
  updated: number;
  deleted: number;
  failed: number;
  /** 因「疑似存储离线」被删除闸门拦下的缺失记录数（>0 表示本次未执行删除） */
  blocked?: number;
  message: string | null;
}

export interface ScanResult {
  total: number;
  added: number;
  updated: number;
  deleted: number;
  failed: number;
  /** 被删除闸门拦下的条数 */
  blocked?: number;
}

export interface ScanState {
  running: boolean;
  libraryId: number | null;
  startedAt: string | null;
  scanned: number;
  total: number;
}

export interface Playlist {
  id: number;
  name: string;
  created_at: string;
  item_count?: number;
}

export interface SystemInfo {
  port: number;
  host: string;
  root: string;
  dataDir: string;
  dbFile: string;
  dbSize: number;
  thumbCount: number;
  ffmpeg: string;
  ffprobe: string;
  node: string;
  platform: string;
  hls?: {
    total: number;
    running: number;
    workDir: string;
    sessions: { videoId: number; running: boolean; error: string | null; dir: string }[];
  };
  /** 抽帧预览（精灵图）统计 */
  sprite?: {
    dir: string;
    count: number;
    bytes: number;
    ready: number;
    total: number;
    running: number;
  };
  /** 悬停预览片段统计（v1.4） */
  preview?: {
    dir: string;
    count: number;
    bytes: number;
    ready: number;
    total: number;
    running: number;
  };
  /** 派生缓存占用 */
  cache?: {
    thumbs: { count: number; bytes: number };
    sprites: { count: number; bytes: number };
    previews: { count: number; bytes: number };
  };
}

/** 抽帧预览状态 + 元信息（Artplayer thumbnails 直接使用后四项） */
export interface SpriteInfo {
  ready: boolean;
  generating: boolean;
  error: string | null;
  url: string;
  number: number;
  column: number;
  row: number;
  width: number;
  height: number;
}

/** 批量抽帧任务状态 */
export interface SpriteBatchState {
  running: boolean;
  cancelled: boolean;
  total: number;
  done: number;
  failed: number;
  currentId: number | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export type SettingsMap = Record<string, string>;

/** 账号角色 */
export type Role = 'admin' | 'user';

export interface AuthUser {
  id: number;
  username: string;
  display_name: string | null;
  role: Role;
  enabled: number;
  created_at: string;
  last_login: string | null;
}

/** 列表页筛选条件（UI 层） */
export interface VideoFilters {
  sort: string;
  view: 'grid' | 'list';
  resolution: string;
  duration: string;
  favorite: boolean;
}

export interface VideoQuery {
  libraryId?: number | string;
  q?: string;
  /** 按标签精确过滤（搜索页用） */
  tag?: string;
  sort?: string;
  page?: number;
  size?: number;
  favorite?: number | string | boolean;
  minDuration?: number;
  maxDuration?: number;
  minHeight?: number;
  maxHeight?: number;
}

/* ------------------------------------------------------------------ *
 * axios 实例
 * ------------------------------------------------------------------ */

const http: AxiosInstance = axios.create({
  baseURL: '/api',
  timeout: 120000,
  headers: { 'Content-Type': 'application/json' },
  // 会话走 HttpOnly Cookie，跨请求需要携带
  withCredentials: true,
});

http.interceptors.response.use(
  (res) => res,
  (err) => {
    const status = err?.response?.status;
    const url = String(err?.config?.url || '');

    // 会话失效：广播事件，由 app 层统一跳登录页（登录接口本身除外）
    if (status === 401 && !url.includes('/auth/login') && !url.includes('/auth/me')) {
      window.dispatchEvent(new CustomEvent('cn:unauthorized'));
    }

    const msg =
      err?.response?.data?.error ||
      err?.message ||
      '请求失败';
    return Promise.reject(new Error(msg));
  }
);

/** 去掉 undefined / '' 参数 */
function clean(params: Record<string, any> = {}) {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    out[k] = v;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 认证
 * ------------------------------------------------------------------ */

export const authApi = {
  login: (username: string, password: string) =>
    http.post<{ user: AuthUser }>('/auth/login', { username, password }).then((r) => r.data),
  logout: () => http.post<{ ok: true }>('/auth/logout').then((r) => r.data),
  me: () => http.get<{ user: AuthUser | null }>('/auth/me').then((r) => r.data),
  changePassword: (oldPassword: string, newPassword: string) =>
    http.post<{ ok: true }>('/auth/password', { oldPassword, newPassword }).then((r) => r.data),
};

/* ------------------------------------------------------------------ *
 * 用户管理（仅管理员）
 * ------------------------------------------------------------------ */

export const usersApi = {
  list: () => http.get<AuthUser[]>('/users').then((r) => r.data),
  create: (payload: { username: string; password: string; displayName?: string; role?: Role }) =>
    http.post<{ id: number }>('/users', payload).then((r) => r.data),
  update: (id: number, payload: { displayName?: string; role?: Role; enabled?: boolean | number }) =>
    http.patch<{ ok: true }>(`/users/${id}`, payload).then((r) => r.data),
  resetPassword: (id: number, password: string) =>
    http.post<{ ok: true }>(`/users/${id}/password`, { password }).then((r) => r.data),
  remove: (id: number) => http.delete<{ ok: true }>(`/users/${id}`).then((r) => r.data),
};

/* ------------------------------------------------------------------ *
 * 媒体库
 * ------------------------------------------------------------------ */

export const librariesApi = {
  list: () => http.get<Library[]>('/libraries').then((r) => r.data),
  create: (payload: { name: string; path: string; scanCron?: string }) =>
    http.post<{ id: number }>('/libraries', payload).then((r) => r.data),
  update: (id: number, payload: { name?: string; scanCron?: string; enabled?: boolean | number }) =>
    http.patch<{ ok: true }>(`/libraries/${id}`, payload).then((r) => r.data),
  remove: (id: number) => http.delete<{ ok: true; cleaned?: number }>(`/libraries/${id}`).then((r) => r.data),
  scan: (id: number) => http.post<ScanResult>(`/libraries/${id}/scan`, {}, { timeout: 0 }).then((r) => r.data),
  /** 确认清理：无视删除闸门，删除该库内文件已不存在的记录（仅管理员） */
  purgeMissing: (id: number) =>
    http.post<{ deleted: number; checked: number }>(`/libraries/${id}/purge-missing`).then((r) => r.data),
};

/* ------------------------------------------------------------------ *
 * 视频
 * ------------------------------------------------------------------ */

export const videosApi = {
  list: (query: VideoQuery = {}) =>
    http.get<Paged<Video>>('/videos', { params: clean(query as any) }).then((r) => r.data),
  detail: (id: number) => http.get<Video>(`/videos/${id}`).then((r) => r.data),
  /** 改显示名 / 收藏 / 标签；title 只改「显示名」，不动磁盘文件名 */
  update: (id: number, payload: { title?: string | null; favorite?: boolean | number; tags?: string[] }) =>
    http.patch<{ ok: true }>(`/videos/${id}`, payload).then((r) => r.data),
  /**
   * 重命名（仅管理员）：改显示名，并把磁盘上的文件一并改名。
   * 同目录同名字幕（含 `影片.zh-CN.srt` 这类）会跟着改，缩略图缓存键同步迁移。
   * @param payload.name 新名称（不含扩展名，带上相同扩展名也会被自动剥离）
   * @param payload.syncTitle 是否同时把显示名改成新名称（默认 true）
   */
  rename: (id: number, payload: { name: string; syncTitle?: boolean }) =>
    http
      .post<{
        ok: true;
        changed: boolean;
        file_renamed: boolean;
        subtitles: string[];
        video: Video;
      }>(`/videos/${id}/rename`, payload)
      .then((r) => r.data),
  remove: (id: number) => http.delete<{ ok: true }>(`/videos/${id}`).then((r) => r.data),
  recent: (limit = 20) => http.get<Video[]>('/videos/recent', { params: { limit } }).then((r) => r.data),
  continueWatching: (limit = 20) =>
    http.get<Video[]>('/videos/continue', { params: { limit } }).then((r) => r.data),
  favorites: (query: VideoQuery = {}) =>
    http.get<Paged<Video>>('/favorites', { params: clean(query as any) }).then((r) => r.data),
};

/* ------------------------------------------------------------------ *
 * 历史 / 进度
 * ------------------------------------------------------------------ */

export const historyApi = {
  report: (id: number, payload: { progress: number; duration: number }) =>
    http.post<{ ok: true }>(`/history/${id}`, payload).then((r) => r.data),
  list: (limit = 50) => http.get<Video[]>('/history', { params: { limit } }).then((r) => r.data),
  clear: (id: number) => http.delete<{ ok: true }>(`/history/${id}`).then((r) => r.data),
};

/* ------------------------------------------------------------------ *
 * 播放列表
 * ------------------------------------------------------------------ */

export const playlistsApi = {
  list: () => http.get<Playlist[]>('/playlists').then((r) => r.data),
  create: (name: string) => http.post<{ id: number }>('/playlists', { name }).then((r) => r.data),
  rename: (id: number, name: string) =>
    http.patch<{ ok: true }>(`/playlists/${id}`, { name }).then((r) => r.data),
  remove: (id: number) => http.delete<{ ok: true }>(`/playlists/${id}`).then((r) => r.data),
  items: (id: number) => http.get<Video[]>(`/playlists/${id}/items`).then((r) => r.data),
  addItem: (id: number, videoId: number) =>
    http.post<{ ok: true }>(`/playlists/${id}/items`, { videoId }).then((r) => r.data),
  setSort: (id: number, videoId: number, sort: number) =>
    http.patch<{ ok: true }>(`/playlists/${id}/items/${videoId}`, { sort }).then((r) => r.data),
  removeItem: (id: number, videoId: number) =>
    http.delete<{ ok: true }>(`/playlists/${id}/items/${videoId}`).then((r) => r.data),
};

/* ------------------------------------------------------------------ *
 * 搜索
 * ------------------------------------------------------------------ */

export const searchApi = {
  /**
   * 关键词（标题 / 文件名 / 标签）搜索，可叠加标签过滤。
   * 关键词以空格分隔，多个关键词之间是「或」的关系（任一命中即返回）。
   */
  query: (params: { q?: string; tag?: string }) =>
    http
      .get<{ items: Video[]; keywords: string[] }>('/search', { params: clean(params as any) })
      .then((r) => r.data),
};

/* ------------------------------------------------------------------ *
 * 任务
 * ------------------------------------------------------------------ */

export const tasksApi = {
  list: (limit = 50) => http.get<ScanLog[]>('/tasks', { params: { limit } }).then((r) => r.data),
  running: () => http.get<ScanState>('/tasks/running').then((r) => r.data),
};

/* ------------------------------------------------------------------ *
 * 设置
 * ------------------------------------------------------------------ */

export const settingsApi = {
  all: () => http.get<SettingsMap>('/settings').then((r) => r.data),
  patch: (payload: SettingsMap) => http.patch<{ ok: true }>('/settings', payload).then((r) => r.data),
  clearThumbs: () =>
    http.post<{ ok: true; count: number }>('/settings/clear-thumbs').then((r) => r.data),
  /** 回收无主缓存（缩略图 + 精灵图） */
  gcCache: () =>
    http
      .post<{
        ok: true;
        thumbs: { removed: number; bytes: number };
        sprites: { removed: number; bytes: number };
        previews?: { removed: number; bytes: number };
        bytes: number;
        staleRefs: number;
      }>('/settings/gc-cache')
      .then((r) => r.data),
  systemInfo: () => http.get<SystemInfo>('/settings/system-info').then((r) => r.data),
  backupUrl: '/api/settings/backup',
};

/* ------------------------------------------------------------------ *
 * 抽帧预览（精灵图）
 * ------------------------------------------------------------------ */

export const spriteApi = {
  /** 查询状态；尚未生成时后端会顺带在后台启动懒生成 */
  info: (id: number) => http.get<SpriteInfo>(`/sprite/${id}/info`).then((r) => r.data),
  batchState: () => http.get<SpriteBatchState>('/sprite/batch').then((r) => r.data),
  batchStart: () => http.post<SpriteBatchState>('/sprite/batch').then((r) => r.data),
  batchCancel: () => http.post<SpriteBatchState>('/sprite/batch/cancel').then((r) => r.data),
};

/* ------------------------------------------------------------------ *
 * 卡片悬停预览片段（v1.4）
 * ------------------------------------------------------------------ */

/** 悬停预览片段状态 */
export interface PreviewInfo {
  ready: boolean;
  generating: boolean;
  error: string | null;
  url: string;
  duration: number;
}

/** 批量生成任务状态 */
export interface PreviewBatchState {
  running: boolean;
  cancelled: boolean;
  total: number;
  done: number;
  failed: number;
  currentId: number | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export const previewApi = {
  /** 查询状态；尚未生成时后端会顺带在后台启动懒生成 */
  info: (id: number) => http.get<PreviewInfo>(`/preview/${id}/info`).then((r) => r.data),
  batchState: () => http.get<PreviewBatchState>('/preview/batch').then((r) => r.data),
  batchStart: () => http.post<PreviewBatchState>('/preview/batch').then((r) => r.data),
  batchCancel: () => http.post<PreviewBatchState>('/preview/batch/cancel').then((r) => r.data),
};

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

/** 秒 → 时长文本 */
export function formatDuration(sec?: number | null): string {
  const s = Math.floor(Number(sec) || 0);
  if (s <= 0) return '--:--';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(ss)}` : `${m}:${p(ss)}`;
}

/** 字节 → 可读大小 */
export function formatSize(bytes?: number | null): string {
  const b = Number(bytes) || 0;
  if (b <= 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = b;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export default http;
