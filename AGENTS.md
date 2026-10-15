# AGENTS.md — 影巢 CineNest 开发代理执行规范

> 本文件是给 AI 编码代理（Agent）的**执行契约**。业务需求以 `开发任务书.md` 为准，本文件只补充：不可违反的硬约束、执行顺序、自测关卡、以及容易踩坑的地方。
>
> 项目：影巢 CineNest v1.0 · 本地私人视频网站 · Windows 10/11 · `http://localhost:8080`

---

## 0. 开始工作前必读

1. 完整阅读 `开发任务书.md`，它是唯一的业务需求来源。
2. 按第 8 节「开发任务清单」的阶段 1 → 阶段 11 **顺序执行，禁止跳阶段**。
3. 每个阶段结束后必须自测并输出四项：**完成项 / 自测结果 / 遗留问题 / 下一阶段计划**，通过后才进入下一阶段。
4. 遇到与本文件冲突的描述，以本文件的硬约束条款为准。

---

## 1. 不可变更项（Hard Invariants）

以下内容一经确定，**任何阶段都不得擅自修改**。确需改动时，先向用户说明原因并获确认。

### 1.1 目录结构
- 严格遵循任务书第 2 节，**路径大小写敏感**，不得增删顶层目录或重命名文件。
- 新增文件必须放进既有目录语义内（service 放 `server/services/`，route 放 `server/routes/`）。
- `data/`、`dist/`、`.env` 属于运行时/环境产物，**必须**在 `.gitignore` 中。

### 1.2 数据库
- 引擎固定 `better-sqlite3`，**单文件** SQLite，启用 `WAL` + `foreign_keys`。
- 表结构与**字段名完全不可变更**，见任务书 4.1 的 SQL。
- 迁移脚本 `server/db/migrate.js` 幂等（可重复执行不报错、不重复建表）。
- 时间统一用 `datetime('now','localtime')`，时区 `Asia/Shanghai`。

### 1.3 API 契约
- 统一前缀 `/api`，响应全部 JSON。
- 错误体固定 `{ "error": "描述" }`。
- 状态码固定：`200` 成功 / `400` 参数错误 / `404` 不存在 / `500` 内部错误。
- 路径、方法、请求体、响应体字段以任务书第 5 节为准，不得自行改名。
- 缩略图/海报对外**统一暴露为** `/api/thumb/:id`、`/api/poster/:id`，数据库里的 `thumb_path`/`poster_path` 不得直接返回给前端。

### 1.4 前端
- 路由表固定，见任务书 6.2，不得新增/改名页面路由。
- 主题色固定：背景 `#0f1115`、卡片 `#1a1d24`、强调色 `#4f8cff`。
- 字体优先中文字体：`"Microsoft YaHei", "PingFang SC", system-ui`。

---

## 2. 关键技术约束（Technical Rules）

### 2.1 Windows 路径处理（最高优先级）
- 数据库存**绝对路径**，保留反斜杠（`D:\Movies\a.mp4`）。
- `fast-glob` 的 pattern 必须把 `\` 换成 `/`（`path.posix.join`）。
- 调用 ffmpeg/ffprobe **必须用 `spawn` + 参数数组**，**严禁字符串拼接命令**。
- 判断文件存在统一用 `fs.existsSync`。

### 2.2 中文与编码
- 所有读写默认 UTF-8。
- 所有 HTTP 响应头带 `charset=utf-8`（含 JSON、VTT）。
- 中文路径、中文文件名必须能扫描和播放（第 9 节验收第 12 条）。

### 2.3 性能
- SQLite 开 WAL。
- ffprobe 并发用 `p-limit(3)` 限制，**不得超过 3**。
- 缩略图缓存命中（`md5(file_path)+'.jpg'` 已存在）直接返回，不重复生成。
- 列表接口默认分页 `size=40`。

### 2.4 安全（本地场景）
- 所有文件操作**限制在已注册 library 路径内**，禁止路径穿越（校验 `path.resolve` 后仍位于库根内）。
- v1 不做登录；如需鉴权，用 `setting` 表 `auth.enabled` / `auth.password`。

### 2.5 容错原则
- 单个文件扫描失败**不中断整体流程**，计入 `failed` 后继续。
- 缩略图生成失败返回 `null`，**不抛异常**。
- 流媒体文件不存在返回 404，**不抛异常**。
- 未捕获异常由错误中间件兜底，返回 500，并写入 `data/error.log`（超 10MB 轮转）。

---

## 3. 阶段执行与自测关卡（Quality Gates）

按顺序执行，每个 Gate 未通过不得进入下一阶段。

| 阶段 | 交付内容 | 通过标准（Gate） |
|---|---|---|
| 1 项目骨架 | `package.json`、目录树、`config.js`、`db/*` | `node server/index.js` 无报错；`data/cinenest.db` 生成且表已建 |
| 2 媒体库 API | `/api/libraries` CRUD | 增删改查可用；非法路径/重复路径返回 400 |
| 3 扫描器 | `probe`/`thumbnail`/`scanner` + `/scan` | 真实目录扫描后 `video` 表有记录，`data/thumbs/` 有 jpg |
| 4 播放 | `stream` + `/api/stream/:id` + `/api/thumb/:id` | 浏览器直开 `/api/stream/1` 能播 mp4；Range 返回 206 |
| 5 前端骨架 | Vite 初始化、Layout、路由、空页面 | 页面能切换；`/api` 代理生效 |
| 6 首页与播放页 | `VideoCard`/`VideoGrid`/`PosterRow`、Home、Watch | 首页可见视频；点击能播；刷新后进度保留 |
| 7 列表与详情 | `/api/videos` 分页排序、Library、VideoDetail | 排序/分页/筛选正确 |
| 8 历史/收藏/搜索 | 三个 API + 三个页面 | 进度、收藏、搜索均生效 |
| 9 列表/任务/设置 | 三个 API + 三个页面 | 播放列表可增删；任务页见日志 |
| 10 自动化与打包 | `watcher`/`scheduler`、`npm run build`、Express 托管 `dist/` | **只启动后端即可访问完整网站** |
| 11 部署 | `README.md`、pm2 配置 | 重启后服务自动运行 |

### 3.1 流媒体 Range 验收细则（阶段 4 必查）
- 无 `Range` 头 → `200`，带 `Content-Length`、`Content-Type`、`Accept-Ranges: bytes`。
- 有 `Range` → `206`，带 `Content-Range: bytes start-end/total`。
- 越界 → `416`。
- MIME 映射见任务书 5.3，不得自行扩展。

---

## 4. 易错点清单（Pitfalls）

- ❌ 用字符串拼接调用 ffprobe → 中文路径/空格路径会失败。**必须数组传参**。
- ❌ 把 `thumb_path` 原样返回前端 → 前端拿不到可访问 URL。**必须转 `/api/thumb/:id`**。
- ❌ `fast-glob` 直接用 Windows 反斜杠 pattern → 遍历不到文件。
- ❌ ffprobe 并发不限制 → 大量文件时 CPU/IO 打满。
- ❌ 扫描时忽略 `@eaDir`、`$RECYCLE.BIN`、`System Volume Information`、`.git` → 扫进垃圾文件。
- ❌ 迁移脚本非幂等 → 二次启动报错。
- ❌ 缩略图 seek 时间写死 → 短视频取帧失败。用 `max(1, min(duration*0.1, 30))`。
- ❌ 播放页不上报进度或上报间隔过长 → 验收第 4 条（续播）不通过。**每 5 秒 POST 一次**。
- ❌ `play_progress > 5` 秒才自动跳转，阈值不得改。
- ❌ 忘记路由回落 → `npm run build` 后刷新子页面 404。

---

## 5. 代码风格约定

- **后端**：CommonJS（`require`/`module.exports`），与任务书示例（`schema.sql`、`config.js`）保持一致。
- **前端**：TypeScript + Vue 3 `<script setup>` + Composition API。
- 前后端分层清晰：service 只处理业务/IO，route 只做参数校验与响应组装。
- 错误统一走 `server/middleware/error.js`，不在 route 里裸 `try/catch` 后直接返回。
- 日志分三类：启动日志、扫描日志、错误日志，分别输出，不混在一起。

---

## 6. 每阶段结束必须输出

```text
【阶段 N：<名称>】
■ 完成项：<逐条列出>
■ 自测结果：<命令 + 实际输出/现象>
■ 遗留问题：<无则写"无">
■ 下一阶段计划：<要点>
```

---

## 7. 交付物（全部完成后）

1. 完整可运行的项目目录。
2. `README.md`：ffmpeg 下载与放置、安装依赖、启动命令、开机自启、常见问题（中文乱码 / 端口占用 / ffmpeg 缺失）。
3. `CHANGELOG.md`：已实现功能 + 未实现（v2）项。
4. 自测报告：按任务书第 9 节 12 条逐条给出截图或日志说明。

---

## 8. 明确不做（v1 非目标）

- 多用户权限体系（v1 单用户，密码可选）
- TMDB 刮削（留 v2）
- 弹幕、评论、分享
- HLS 切片（`hls.m3u8` / `hls/:seg.ts` v1 返回 `501`）
- 拖拽排序播放列表（v1 用上下移动按钮）
- 单个文件重新扫描（v2）

---

## 9. 环境前提

- Node.js ≥ 20.10 LTS，npm ≥ 10。
- `bin/ffmpeg/ffmpeg.exe`、`bin/ffmpeg/ffprobe.exe` 必须存在；**启动时校验，缺失则打印明确错误并退出**。
- `better-sqlite3` 若预编译包安装失败，提示用户安装 Visual Studio Build Tools。
- 依赖锁定 `package-lock.json`。

---

_最后更新：随项目进展维护本文件。任何硬约束变更必须记录在案。_
