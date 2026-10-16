'use strict';

/**
 * 影巢 CineNest — 一键部署包打包器
 *
 * 用法（在项目根目录执行）：
 *   node build-deploy.cjs               生成「标准包 + 离线包」两个 zip
 *   node build-deploy.cjs --standard    只生成标准包（不含 ffmpeg，首次启动自动下载）
 *   node build-deploy.cjs --offline     只生成离线包（含 ffmpeg，可完全离线部署）
 *
 * 产物（项目根目录）：
 *   CineNest-Deploy-<版本>-win-x64.zip           标准包（约 15MB）
 *   CineNest-Deploy-<版本>-offline-win-x64.zip   离线包（约 150MB）
 *
 * 包内结构（文件名统一 ASCII，避免解压工具的编码差异）：
 *   CineNest/
 *     start.cmd                  双击启动
 *     launcher.cjs               启动器（自检环境 / 装依赖 / 补 ffmpeg / 起服务 / 开浏览器）
 *     DEPLOY-README.md           部署说明（中文内容）
 *     server/  dist/  node_modules/  package.json  package-lock.json
 *     bin/ffmpeg/                仅离线包包含
 *     README.md  CHANGELOG.md  .env.example
 */

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = __dirname;
const STAGE_ROOT = path.join(ROOT, '.tmp-media', 'deploy');

// FFmpeg 获取器：bin/ffmpeg/ 不入版本库（两个 exe 合计约 337MB，单文件超 GitHub 的 100MB 上限），
// 缺了就在打离线包前自动获取。
const ffmpegFetch = require(path.join(__dirname, 'tools', 'fetch-ffmpeg.cjs'));
const PKG_DIR_NAME = 'CineNest';

const argv = process.argv.slice(2);
const ONLY_STANDARD = argv.includes('--standard');
const ONLY_OFFLINE = argv.includes('--offline');
const BUILD_STANDARD = ONLY_OFFLINE ? false : true;
const BUILD_OFFLINE = ONLY_STANDARD ? false : true;

/** 版本号：优先取 CHANGELOG 首个 ## vX.Y.Z，其次 package.json */
function detectVersion() {
  try {
    const md = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
    const m = md.match(/^##\s+(v\d+\.\d+\.\d+)/m);
    if (m) return m[1];
  } catch (_) { /* ignore */ }
  try {
    return 'v' + JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  } catch (_) {
    return 'v1.0.0';
  }
}

const VERSION = detectVersion();

/**
 * 部署包内置的原生模块 ABI（better-sqlite3 走 V8 ABI，Node 大版本不同即无法加载）。
 * 预置这些版本后，同一个包在 Node 20 / 22 / 23 / 24 / 25 上都能直接启动，无需联网重装或本地编译。
 * 编号说明：115=Node20.x  127=Node22.x  131=Node23.x  137=Node24.x  141=Node25.x
 */
const REQUIRED_ABIS = [115, 127, 131, 137, 141];

/*
 * 这里**不要**再往本地 node_modules 同步打包机的 ABI。
 * 曾经有过一个 syncLocalNative()，把打包机 ABI 的原生模块写进共享的
 * node_modules —— 结果是用另一个 Node 大版本跑 `npm run dev` 时必然崩
 * （ERR_DLOPEN_FAILED: NODE_MODULE_VERSION 127 ... requires 137）。
 * 适配这件事现在由两个运行时环节负责，打包阶段只读不写：
 *   1. 包内 launcher.cjs：启动服务前按 process.versions.modules 落位；
 *   2. 包内 server/utils/nativeAbi.js：加载 better-sqlite3 之前再兜一次。
 */

/* ------------------------------------------------------------------ *
 * 包内文件：一键启动器
 * ------------------------------------------------------------------ */

const LAUNCHER_SRC = [
  '#!/usr/bin/env node',
  '/*',
  ' * 影巢 CineNest · 一键启动器',
  ' * 职责：环境自检 → 依赖自愈 → FFmpeg 自动补全 → 启动服务 → 打开浏览器',
  ' * 用法：start.cmd            （Windows 双击即可）',
  ' *       node launcher.cjs --port 8090 --no-open --no-download --check',
  ' *       （端口也接受 --port=8090 / --port:8090 写法）',
  ' */',
  "'use strict';",
  '',
  "const fs = require('fs');",
  "const path = require('path');",
  "const cp = require('child_process');",
  '',
  'const ROOT = __dirname;',
  'const ARGV = process.argv.slice(2);',
  '',
  '/* 参数解析：同时接受 --port 8090 / --port=8090 / --port:8090 三种写法。',
  '   真实教训：用户习惯把端口写成 --port:8090，旧实现只认 "--port 8090"，',
  '   于是参数被静默忽略、端口退回 8080 —— 表现就是「改了端口却没生效」。 */',
  'function hasFlag(name) {',
  '  const key = "--" + name;',
  '  return ARGV.some(function (a) { return a === key || a.indexOf(key + "=") === 0 || a.indexOf(key + ":") === 0; });',
  '}',
  'function optValue(name, fallback) {',
  '  const key = "--" + name;',
  '  for (let i = 0; i < ARGV.length; i += 1) {',
  '    const a = ARGV[i];',
  '    if (a === key) {',
  '      const next = ARGV[i + 1];',
  '      if (next && next.indexOf("--") !== 0) return next;',
  '      continue;',
  '    }',
  '    if (a.indexOf(key + "=") === 0 || a.indexOf(key + ":") === 0) {',
  '      const v = a.slice(key.length + 1);',
  '      if (v) return v;',
  '    }',
  '  }',
  '  return fallback;',
  '}',
  '',
  '/* 无法识别的 --xxx 参数不再静默吞掉，直接提示（拼错参数最容易造成「配置不生效」的误判） */',
  'function warnUnknownArgs() {',
  '  const known = ["check", "no-open", "no-download", "port"];',
  '  for (let i = 0; i < ARGV.length; i += 1) {',
  '    const a = ARGV[i];',
  '    if (a.indexOf("--") !== 0) continue;',
  '    const body = a.slice(2);',
  '    const name = body.split(/[=:]/)[0];',
  '    if (known.indexOf(name) >= 0) {',
  '      if (body === name) i += 1;',
  '      continue;',
  '    }',
  '    warn("忽略无法识别的参数 " + a + "（可用：--port 8090 / --no-open / --no-download / --check）");',
  '  }',
  '}',
  '',
  'const CHECK_ONLY = hasFlag("check");',
  'const NO_OPEN = hasFlag("no-open");',
  'const NO_DOWNLOAD = hasFlag("no-download");',
  'const IS_WIN = process.platform === "win32";',
  '',
  '/* ---------------- .env（自包含解析） ---------------- */',
  '/* 启动器可能早于 npm install 运行（包内无依赖时），所以不能依赖 dotenv，',
  '   这里自己读一份；只用于决定端口并打印横幅，不污染 process.env。 */',
  'function readEnvFile() {',
  '  const out = {};',
  '  try {',
  '    const file = path.join(ROOT, ".env");',
  '    if (!fs.existsSync(file)) return out;',
  '    const text = fs.readFileSync(file, "utf8").replace(/^\\uFEFF/, "");',
  '    for (const raw of text.split(/\\r?\\n/)) {',
  '      const line = raw.trim();',
  '      if (!line || line.charAt(0) === "#") continue;',
  '      const eq = line.indexOf("=");',
  '      if (eq <= 0) continue;',
  '      const key = line.slice(0, eq).trim();',
  '      let val = line.slice(eq + 1).trim();',
  '      const q = val.charAt(0);',
  '      if (val.length > 1 && (q === \'"\' || q === "\'") && val.charAt(val.length - 1) === q) val = val.slice(1, -1);',
  '      out[key] = val;',
  '    }',
  '  } catch (_) { /* 读不了就当没有 .env */ }',
  '  return out;',
  '}',
  '',
  'const DOTENV = readEnvFile();',
  '',
  'function normalizePort(v) {',
  '  const n = Number(String(v).trim());',
  '  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;',
  '}',
  '',
  '/* 端口优先级：--port 参数 > 系统环境变量 PORT > .env 的 PORT > 默认 8080',
  '   注意：子进程的 PORT 由本启动器显式注入，而 dotenv 默认不覆盖已存在的环境变量，',
  '   所以这里必须先把 .env 读出来，否则 .env 里的端口会被下面的注入值盖掉。 */',
  'const PORT_INFO = (function () {',
  '  const cli = optValue("port", null);',
  '  if (cli !== null && cli !== "") return { raw: cli, from: "--port 参数" };',
  '  if (process.env.PORT) return { raw: process.env.PORT, from: "环境变量 PORT" };',
  '  if (DOTENV.PORT) return { raw: DOTENV.PORT, from: ".env 文件" };',
  '  return { raw: null, from: "默认值" };',
  '})();',
  'const PORT_NUM = PORT_INFO.raw === null ? 8080 : normalizePort(PORT_INFO.raw);',
  'const PORT_INVALID = PORT_NUM === null;',
  'const PORT = String(PORT_INVALID ? 8080 : PORT_NUM);',
  '',
  'const LINE = "============================================================";',
  '',
  'function log(m) { console.log(m); }',
  'function ok(m) { console.log("  [OK]   " + m); }',
  'function warn(m) { console.log("  [!]    " + m); }',
  'function bad(m) { console.log("  [X]    " + m); }',
  '',
  'function banner() {',
  '  log("");',
  '  log(LINE);',
  '  log("   影巢 CineNest  ·  一键启动");',
  '  log("   把你的硬盘变成私人影院");',
  '  log(LINE);',
  '  log("   安装目录 : " + ROOT);',
  '  log("   Node.js  : " + process.version + " (" + process.platform + "-" + process.arch + ", ABI " + process.versions.modules + ")");',
  '  log("   服务端口 : " + PORT + "（来自 " + PORT_INFO.from + "）");',
  '  if (PORT_INVALID) warn("端口配置 " + PORT_INFO.raw + " 不是 1~65535 的整数，已回退 8080");',
  '  warnUnknownArgs();',
  '  log("");',
  '}',
  '',
  '/* ---------------- 1. Node 版本 ---------------- */',
  'function checkNode() {',
  '  const v = process.versions.node.split(".").map(Number);',
  '  if (v[0] < 20 || (v[0] === 20 && v[1] < 10)) {',
  '    warn("当前 Node.js " + process.version + " 低于要求的 20.10.0，可能出现兼容问题。");',
  '    warn("建议到 https://nodejs.org/ 安装 Node.js 22 LTS（或 24 LTS）。");',
  '    return false;',
  '  }',
  '  ok("Node.js 版本 " + process.version + " 符合要求");',
  '  return true;',
  '}',
  '',
  '/* ---------------- 2. 运行依赖（含原生模块 ABI 自愈） ---------------- */',
  'const SQLITE_PKG = path.join(ROOT, "node_modules", "better-sqlite3");',
  'const SQLITE_BIN = path.join(SQLITE_PKG, "build", "Release", "better_sqlite3.node");',
  'const VENDOR_SQLITE = path.join(ROOT, "vendor", "sqlite3");',
  '',
  '// 当前 Node 对应的原生模块 ABI 标识，形如 node-v137-win32-x64',
  'function nativeKey() {',
  '  return "node-v" + process.versions.modules + "-" + process.platform + "-" + process.arch;',
  '}',
  '',
  '// 包内内置了哪些 ABI（用于给出可读提示）',
  'function vendorAbis() {',
  '  try {',
  '    return fs.readdirSync(VENDOR_SQLITE, { withFileTypes: true })',
  '      .filter(function (e) { return e.isDirectory(); })',
  '      .map(function (e) { return e.name.replace(/^node-v/, "").replace(/-win32-x64$/, ""); });',
  '  } catch (_) { return []; }',
  '}',
  '',
  '/* 真正「打开一次内存库」来判定原生模块可用性。',
  '   注意：require("better-sqlite3") 只是加载 JS 壳，native 绑定是惰性的（首次 new Database 才 dlopen），',
  '   所以「能 require」并不等于「能用」——必须实际打开一次，否则会漏判 ABI 不匹配。 */',
  'function sqliteUsable() {',
  '  const probe = "const D=require(\'better-sqlite3\');const d=new D(\':memory:\');d.close();";',
  '  const r = cp.spawnSync(process.execPath, ["-e", probe], {',
  '    cwd: ROOT, encoding: "utf8", timeout: 60000,',
  '  });',
  '  return r.status === 0;',
  '}',
  '',
  'function depsReady() {',
  '  if (!fs.existsSync(path.join(ROOT, "node_modules"))) return false;',
  '  if (!fs.existsSync(SQLITE_PKG)) return false;',
  '  return sqliteUsable();',
  '}',
  '',
  '/* 原生模块 ABI 自愈：用包内预置的、与当前 Node 匹配的 better_sqlite3.node 覆盖。',
  '   better-sqlite3 走 V8 ABI，Node 大版本不同即无法加载；内置多个版本后可免联网、免编译直接修复。 */',
  'function repairNativeAbi() {',
  '  const cand = path.join(VENDOR_SQLITE, nativeKey(), "better_sqlite3.node");',
  '  if (!fs.existsSync(cand)) return false;',
  '  try {',
  '    fs.mkdirSync(path.dirname(SQLITE_BIN), { recursive: true });',
  '    fs.copyFileSync(cand, SQLITE_BIN);',
  '  } catch (err) {',
  '    warn("替换原生模块失败：" + (err && err.message ? err.message : err));',
  '    return false;',
  '  }',
  '  if (sqliteUsable()) {',
  '    ok("已自动适配当前 Node.js（" + nativeKey() + "）");',
  '    return true;',
  '  }',
  '  return false;',
  '}',
  '',
  'function printAbiHelp() {',
  '  const list = vendorAbis();',
  '  log("");',
  '  bad("better-sqlite3 原生模块无法在当前 Node.js 下加载。");',
  '  log("       当前 Node : " + process.version + "  (ABI " + process.versions.modules + ", " + process.platform + "-" + process.arch + ")");',
  '  if (list.length) log("       包内内置 : Node " + list.join(" / ") + " 的预编译组件");',
  '  log("");',
  '  log("  解决办法（任选其一）：");',
  '  log("   1. 安装 Node.js 22 LTS（推荐）后重新运行 start.cmd：https://nodejs.org/");',
  '  log("      已有其它版本 Node 时，也可用 nvm-windows 切换：nvm use 22");',
  '  log("   2. 保持联网重新运行 start.cmd，让启动器自动重装依赖（需本机有编译环境，不保证成功）");',
  '  log("");',
  '}',
  '',
  'function installDeps() {',
  '  log("  [..]   安装运行依赖（首次启动，或 Node 大版本变化后需重装；需联网）...");',
  '  const npmArgs = ["install", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error"];',
  '  // 原生模块的预编译包默认从 GitHub 拉取（国内常失败），顺带指一个国内镜像',
  '  const env = Object.assign({}, process.env);',
  '  if (!env.npm_config_better_sqlite3_binary_host_mirror) {',
  '    env.npm_config_better_sqlite3_binary_host_mirror = "https://registry.npmmirror.com/-/binary/better-sqlite3/";',
  '  }',
  '  let r;',
  '  if (IS_WIN) {',
  '    r = cp.spawnSync("cmd.exe", ["/c", "npm.cmd"].concat(npmArgs), { cwd: ROOT, stdio: "inherit", env: env });',
  '  } else {',
  '    r = cp.spawnSync("npm", npmArgs, { cwd: ROOT, stdio: "inherit", env: env });',
  '  }',
  '  if (r.status !== 0 || !depsReady()) {',
  '    bad("依赖安装失败：请确认已安装 Node.js（自带 npm）并且网络可用后重试。");',
  '    bad("若本机无法联网，请改用「离线完整包」，或把已装好的 node_modules 目录复制到安装目录。");',
  '    return false;',
  '  }',
  '  ok("运行依赖就绪");',
  '  return true;',
  '}',
  '',
  'function ensureDeps() {',
  '  if (depsReady()) { ok("运行依赖就绪（better-sqlite3 可加载）"); return true; }',
  '  if (repairNativeAbi()) return true;',
  '  if (CHECK_ONLY) { bad("缺少运行依赖，请先启动一次以自动安装"); return false; }',
  '  if (installDeps()) return true;',
  '  printAbiHelp();',
  '  return false;',
  '}',
  '',
  '/* ---------------- 3. FFmpeg ---------------- */',
  'function localFfmpeg() {',
  '  const dir = path.join(ROOT, "bin", "ffmpeg");',
  '  const ff = path.join(dir, IS_WIN ? "ffmpeg.exe" : "ffmpeg");',
  '  const fp = path.join(dir, IS_WIN ? "ffprobe.exe" : "ffprobe");',
  '  return fs.existsSync(ff) && fs.existsSync(fp) ? ff : null;',
  '}',
  '',
  'function findInPath(name) {',
  '  const exts = (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";").filter(Boolean);',
  '  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);',
  '  for (const dir of dirs) {',
  '    for (const ext of exts) {',
  '      const a = path.join(dir, name + ext.toLowerCase());',
  '      if (fs.existsSync(a)) return a;',
  '      const b = path.join(dir, name + ext.toUpperCase());',
  '      if (fs.existsSync(b)) return b;',
  '    }',
  '  }',
  '  return null;',
  '}',
  '',
  'function download(url, dest, label) {',
  '  return new Promise((resolve, reject) => {',
  '    const mod = url.indexOf("https:") === 0 ? require("https") : require("http");',
  '    const req = mod.get(url, { headers: { "User-Agent": "CineNest-Launcher" } }, (res) => {',
  '      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {',
  '        res.resume();',
  '        let next = res.headers.location;',
  '        if (next.indexOf("http") !== 0) next = new URL(next, url).toString();',
  '        return resolve(download(next, dest, label));',
  '      }',
  '      if (res.statusCode !== 200) { res.resume(); return reject(new Error("HTTP " + res.statusCode)); }',
  '      const total = Number(res.headers["content-length"] || 0);',
  '      let got = 0;',
  '      let lastPct = -10;',
  '      const out = fs.createWriteStream(dest);',
  '      res.on("data", (chunk) => {',
  '        got += chunk.length;',
  '        if (total) {',
  '          const pct = Math.floor((got / total) * 100);',
  '          if (pct >= lastPct + 10) { lastPct = pct; log("  [..]   " + label + " " + pct + "%"); }',
  '        }',
  '      });',
  '      res.pipe(out);',
  '      out.on("finish", () => out.close(() => resolve(dest)));',
  '      out.on("error", reject);',
  '      res.on("error", reject);',
  '    });',
  '    req.on("error", reject);',
  '    req.setTimeout(120000, () => req.destroy(new Error("下载超时")));',
  '  });',
  '}',
  '',
  'function extractZip(zip, destDir) {',
  '  fs.mkdirSync(destDir, { recursive: true });',
  '  const tarExe = IS_WIN',
  '    ? path.join(process.env.SystemRoot || "C:\\\\Windows", "System32", "tar.exe")',
  '    : "tar";',
  '  let r = cp.spawnSync(tarExe, ["-xf", zip, "-C", destDir], { stdio: "inherit" });',
  '  if (r.status === 0) return true;',
  '  if (!IS_WIN) return false;',
  '  r = cp.spawnSync("powershell.exe", [',
  '    "-NoProfile", "-NonInteractive", "-Command",',
  '    "Expand-Archive -LiteralPath \\"" + zip + "\\" -DestinationPath \\"" + destDir + "\\" -Force",',
  '  ], { stdio: "inherit" });',
  '  return r.status === 0;',
  '}',
  '',
  'function findFileDeep(dir, name, depth) {',
  '  if ((depth || 0) > 6) return null;',
  '  let entries = [];',
  '  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return null; }',
  '  for (const e of entries) {',
  '    const full = path.join(dir, e.name);',
  '    if (e.isFile() && e.name.toLowerCase() === name.toLowerCase()) return full;',
  '  }',
  '  for (const e of entries) {',
  '    if (e.isDirectory()) {',
  '      const r = findFileDeep(path.join(dir, e.name), name, (depth || 0) + 1);',
  '      if (r) return r;',
  '    }',
  '  }',
  '  return null;',
  '}',
  '',
  '/** 下载 FFmpeg 并放置到 bin/ffmpeg/（多镜像尝试；可用环境变量 CINENEST_FFMPEG_MIRROR 追加自定义源，多个用 | 分隔） */',
  'async function fetchFfmpeg() {',
  '  const extra = (process.env.CINENEST_FFMPEG_MIRROR || "").split("|").filter(Boolean);',
  '  const mirrors = extra.concat([',
  '    "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",',
  '    "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip",',
  '  ]);',
  '  const cacheDir = path.join(ROOT, ".cache");',
  '  fs.mkdirSync(cacheDir, { recursive: true });',
  '  const zip = path.join(cacheDir, "ffmpeg.zip");',
  '  const tmp = path.join(cacheDir, "extract");',
  '',
  '  for (let i = 0; i < mirrors.length; i += 1) {',
  '    try {',
  '      fs.mkdirSync(cacheDir, { recursive: true });',
  '      log("  [..]   下载 FFmpeg（约 80~150MB，仅首次需要）...");',
  '      await download(mirrors[i], zip, "已下载");',
  '      const size = fs.statSync(zip).size;',
  '      if (size < 1024 * 1024) throw new Error("文件过小，可能不是有效压缩包");',
  '      log("  [..]   解压 FFmpeg ...");',
  '      if (!extractZip(zip, tmp)) throw new Error("解压失败");',
  '      const ffmpeg = findFileDeep(tmp, "ffmpeg.exe");',
  '      const ffprobe = findFileDeep(tmp, "ffprobe.exe");',
  '      if (!ffmpeg || !ffprobe) throw new Error("压缩包内未找到 ffmpeg.exe / ffprobe.exe");',
  '      const outDir = path.join(ROOT, "bin", "ffmpeg");',
  '      fs.mkdirSync(outDir, { recursive: true });',
  '      fs.copyFileSync(ffmpeg, path.join(outDir, "ffmpeg.exe"));',
  '      fs.copyFileSync(ffprobe, path.join(outDir, "ffprobe.exe"));',
  '      cleanup(cacheDir);',
  '      ok("FFmpeg 已就绪：" + outDir);',
  '      return true;',
  '    } catch (err) {',
  '      warn("镜像 " + (i + 1) + " 失败：" + err.message);',
  '      // 只清掉本次的半成品，保留 .cache 目录本身，否则下一个镜像会因目录不存在直接失败',
  '      try { fs.rmSync(zip, { force: true }); } catch (_) { /* ignore */ }',
  '      cleanup(tmp);',
  '    }',
  '  }',
  '  cleanup(cacheDir);',
  '  return false;',
  '}',
  '',
  'function cleanup(dir) {',
  '  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }',
  '}',
  '',
  'async function ensureFfmpeg() {',
  '  if (localFfmpeg()) { ok("FFmpeg 就绪（包内 bin/ffmpeg）"); return true; }',
  '  const sysF = findInPath("ffmpeg");',
  '  const sysP = findInPath("ffprobe");',
  '  if (sysF && sysP) { ok("FFmpeg 就绪（使用系统 PATH：" + sysF + "）"); return true; }',
  '  if (NO_DOWNLOAD) {',
  '    warn("未找到 FFmpeg，且已禁用自动下载（--no-download）。");',
  '    printFfmpegHelp();',
  '    return false;',
  '  }',
  '  if (IS_WIN) {',
  '    const got = await fetchFfmpeg();',
  '    if (got) return true;',
  '  }',
  '  warn("FFmpeg 自动获取失败。");',
  '  printFfmpegHelp();',
  '  return false;',
  '}',
  '',
  'function printFfmpegHelp() {',
  '  log("");',
  '  log("  请手动下载 Windows 静态版 FFmpeg，并把 ffmpeg.exe / ffprobe.exe 放到：");',
  '  log("    " + path.join(ROOT, "bin", "ffmpeg"));',
  '  log("  下载地址：");',
  '  log("    https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip");',
  '  log("    https://github.com/BtbN/FFmpeg-Builds/releases");',
  '  log("  也可以直接使用「离线完整包」（内置 FFmpeg，无需下载）。");',
  '  log("");',
  '}',
  '',
  '/* ---------------- 4. 启动服务 ---------------- */',
  'function openBrowser(url) {',
  '  try {',
  '    if (IS_WIN) cp.spawn("cmd.exe", ["/c", "start", "\\"\\"", url], { detached: true, stdio: "ignore" }).unref();',
  '    else if (process.platform === "darwin") cp.spawn("open", [url], { detached: true, stdio: "ignore" }).unref();',
  '    else cp.spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();',
  '  } catch (_) { /* ignore */ }',
  '}',
  '',
  'function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }',
  '',
  'async function waitHealth(url, tries, child) {',
  '  for (let i = 0; i < tries; i += 1) {',
  '    if (child && child.exitCode !== null) return false;   // 子进程已退出，不必再干等满 30 秒',
  '    try {',
  '      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });',
  '      if (res.ok) return true;',
  '    } catch (_) { /* 还没起来 */ }',
  '    await sleep(500);',
  '  }',
  '  return false;',
  '}',
  '',
  'async function startServer() {',
  '  // 显式注入端口：确保子进程、横幅、健康检查用的是同一个值（.env 已在上方读入 PORT）',
  '  const env = Object.assign({}, process.env, { PORT: PORT });',
  '  log("  [..]   正在启动 CineNest 服务 ...");',
  '  const child = cp.spawn(process.execPath, ["server/index.js"], {',
  '    cwd: ROOT, stdio: "inherit", env: env,',
  '  });',
  '',
  '  const url = "http://localhost:" + PORT;',
  '  const alive = await waitHealth("http://127.0.0.1:" + PORT + "/api/health", 60, child);',
  '',
  '  if (alive) {',
  '    log("");',
  '    log(LINE);',
  '    log("   启动成功！请在浏览器访问： " + url);',
  '    log("   首次启动会自动创建默认管理员账号（用户名/密码见上方日志）");',
  '    log("   关闭本窗口即可停止服务（或按 Ctrl+C）");',
  '    log(LINE);',
  '    log("");',
  '    if (!NO_OPEN) openBrowser(url);',
  '  } else {',
  '    warn("服务未在预期时间内就绪，请查看上方日志。");',
  '    if (child.exitCode !== null) warn("服务进程已退出（退出码 " + child.exitCode + "），多半是端口被占用：日志里的 EADDRINUSE 会写明冲突端口。");',
  '    warn("换端口：改 .env 里的 PORT（持久），或本次用 start.cmd --port 8090（也可写成 --port=8090）。");',
  '  }',
  '',
  '  child.on("exit", (code) => { process.exit(code == null ? 0 : code); });',
  '  process.on("SIGINT", () => { try { child.kill("SIGINT"); } catch (_) { /* ignore */ } });',
  '  process.on("SIGTERM", () => { try { child.kill("SIGTERM"); } catch (_) { /* ignore */ } });',
  '}',
  '',
  '/* ---------------- main ---------------- */',
  '(async function main() {',
  '  banner();',
  '  const nodeOk = checkNode();',
  '  const depsOk = ensureDeps();',
  '  const ffOk = await ensureFfmpeg();',
  '',
  '  if (CHECK_ONLY) {',
  '    log("");',
  '    log("  环境自检结果： Node " + (nodeOk ? "OK" : "偏低") + " | 依赖 " + (depsOk ? "OK" : "缺失") + " | FFmpeg " + (ffOk ? "OK" : "缺失"));',
  '    log("");',
  '    process.exit(depsOk && ffOk ? 0 : 1);',
  '  }',
  '',
  '  if (!depsOk || !ffOk) {',
  '    bad("环境不满足启动条件，已中止。按上方提示处理后重新运行。");',
  '    process.exit(1);',
  '  }',
  '',
  '  await startServer();',
  '})().catch((err) => {',
  '  bad("启动器异常：" + (err && err.message ? err.message : err));',
  '  process.exit(1);',
  '});',
  '',
].join('\n');

/* ------------------------------------------------------------------ *
 * 包内文件：start.cmd（纯 ASCII，避免 cmd 编码问题）
 * ------------------------------------------------------------------ *
 * 【重要】不使用 if ( ... ) 括号块，一律用 goto 跳转。
 *
 * 原因（v1.4.5 踩坑记录）：cmd 在解析 if ( ... ) 块时会先对整个块做括号配对，
 * 块内任何一句 echo 里若出现未转义的 ) —— 例如
 *     echo  Please install Node.js 22 LTS (or 24 LTS) from https://nodejs.org/
 *                                          ↑ 这个 ) 被当成 if 块的结束
 * 就会让块提前闭合，剩下的 `from https://nodejs.org/` 变成非法 token，报
 *     from was unexpected at this time.
 * 而且 cmd 一旦在解析期失败，会直接中止整个批处理 —— 连横幅都不会打印。
 * 括号块 + 文案里带括号 = 定时炸弹，所以这里彻底不用块（见 lintStartCmd）。
 * ------------------------------------------------------------------ */

const START_CMD_SRC = [
  '@echo off',
  'setlocal',
  'chcp 65001 >nul 2>nul',
  'cd /d "%~dp0"',
  '',
  'where node >nul 2>nul',
  'if errorlevel 1 goto :no_node',
  '',
  'node "launcher.cjs" %*',
  'if errorlevel 1 goto :launcher_failed',
  'exit /b 0',
  '',
  ':no_node',
  'echo.',
  'echo  [ERROR] Node.js not found.',
  'echo          Please install Node.js 22 LTS or 24 LTS from https://nodejs.org/',
  'echo          then run this file again.',
  'echo.',
  'pause',
  'exit /b 1',
  '',
  ':launcher_failed',
  'echo.',
  'echo  [INFO] Launcher exited with code %ERRORLEVEL%.',
  'echo         Press any key to close this window.',
  'pause >nul',
  'exit /b 1',
  '',
].join('\r\n');

/* ------------------------------------------------------------------ *
 * 包内文件：部署说明.md
 * ------------------------------------------------------------------ */

const DEPLOY_DOC_SRC = [
  '# 影巢 CineNest · 一键部署说明',
  '',
  '> 双击 `start.cmd` 即可完成部署与启动，浏览器会自动打开。',
  '> （包内所有文件名均为英文，避免不同解压工具的中文编码差异，请认准 `start.cmd`）',
  '',
  '## 一、运行环境要求',
  '',
  '| 项目 | 要求 |',
  '|---|---|',
  '| 操作系统 | Windows 10 / 11（64 位） |',
  '| Node.js | **20.10 或更高**（推荐 22 LTS / 24 LTS）。包内已内置 Node 20/22/23/24/25 的原生组件，换 Node 大版本也能直接跑 |',
  '| FFmpeg | 启动器自动检测；缺失且联网时自动下载（离线包已内置） |',
  '| 网络 | 首次启动装依赖/补 FFmpeg 时需要；离线包 + 已装 Node 可全程无网 |',
  '| 磁盘 | 建议预留 1GB 以上（不含你的视频文件） |',
  '',
  '## 二、安装与启动（3 步）',
  '',
  '1. **解压** 本压缩包到任意目录，例如 `D:\\CineNest`（路径不要含特殊字符，中文路径可用）。',
  '2. **安装 Node.js**：如本机已有 20.10+ 可跳过。下载 <https://nodejs.org/> 的 LTS 版，一路下一步即可。',
  '3. **双击 `start.cmd`**：',
  '   - 首次启动会自动检查环境、安装运行依赖（约 1 分钟）、必要时下载 FFmpeg（约 1~3 分钟）；',
  '   - 就绪后自动打开浏览器 <http://localhost:8080>，终端窗口会打印默认管理员账号与密码；',
  '   - **关闭那个黑色窗口即停止服务**。',
  '',
  '> 首次启动后，在「设置 / 媒体库」里添加你的视频目录，点击扫描即可开始使用。',
  '',
  '## 三、日常使用',
  '',
  '- 启动：双击 `start.cmd`；',
  '- 停止：关闭服务窗口，或在该窗口按 `Ctrl + C`；',
  '- 换端口：改 `.env` 里的 `PORT=8090`（持久，重启生效），或 `start.cmd --port 8090`（仅本次）；',
  '- 不自动开浏览器：`start.cmd --no-open`；',
  '- 只做环境自检：`start.cmd --check`；',
  '- 局域网访问：手机/平板连同一 Wi-Fi，访问 `http://电脑IP:8080`（Windows 防火墙需放行）。',
  '',
  '## 四、目录说明',
  '',
  '| 目录 / 文件 | 说明 |',
  '|---|---|',
  '| `start.cmd` | **启动入口，双击这个** |',
  '| `launcher.cjs` | 启动器：环境自检 / 依赖自愈 / FFmpeg 补全 / 起服务 / 开浏览器 |',
  '| `DEPLOY-README.md` | 本说明 |',
  '| `server/` | 后端服务代码 |',
  '| `dist/` | 已构建好的前端页面 |',
  '| `node_modules/` | 运行依赖（已内置，无需 `npm install`） |',
  '| `bin/ffmpeg/` | FFmpeg（离线包内置；标准包首次启动自动下载） |',
  '| `vendor/` | 各 Node 大版本对应的原生模块，启动器会按当前 Node 自动选用（请勿删除） |',
  '| `.env` | 可选配置：`PORT`（端口）/ `HOST`（监听地址），参考同目录 `.env.example` |',
  '| `data/` | **运行时自动生成**：数据库、缩略图、预览片段等。备份就备份这里 |',
  '| `.cache/` | 启动器临时下载目录，用完自动清理 |',
  '',
  '## 五、常见问题',
  '',
  '**1. 提示 Node.js not found**',
  '未安装 Node.js 或未加入 PATH。安装 <https://nodejs.org/> LTS 版后重开窗口再启动。',
  '',
  '**2. 启动报错「缺少 ffmpeg.exe / ffprobe.exe」**',
  '把两个 exe 放到 `bin\\ffmpeg\\` 下，或联网重跑启动器让它自动下载（加 `--no-download` 可禁用）。',
  '',
  '**3. 端口被占用（EADDRINUSE）／改了 `.env` 的 PORT 却不生效**',
  '端口按「`--port` 参数 > 系统环境变量 PORT > `.env` > 默认 8080」取值，启动横幅会标注来源，例如 `服务端口 : 8090（来自 .env 文件）`。',
  '换端口：把 `.env` 里的 `PORT` 改掉（持久，重启生效），或本次临时指定 `start.cmd --port 8090`，之后用 `http://localhost:8090` 访问。',
  '若横幅显示「来自 环境变量 PORT」，说明系统里已经设过 `PORT`，它优先于 `.env`，请清掉该环境变量或直接用 `--port`。',
  '',
  '**4. 中文文件名/路径乱码或扫描不到**',
  '确保视频目录名正常；程序内部已强制 UTF-8。若仍异常，在「任务」页查看扫描日志定位具体文件。',
  '',
  '**5. 换了 Node.js 大版本后启动失败**',
  '启动器会自动检测并切换包内对应的原生模块（`vendor/` 已内置 Node 20/22/23/24/25），**通常无需联网、无需重装依赖**。',
  '若你的 Node 版本不在上述范围内（例如 26+ 或 18-），请安装 <https://nodejs.org/> 的 **22 LTS**（推荐）后重试；',
  '启动器也会尝试联网自动重装依赖作为兜底（需本机有编译环境，不保证成功）。',
  '',
  '**6. 报错 ERR_DLOPEN_FAILED / NODE_MODULE_VERSION 不匹配**',
  '这是原生模块（better-sqlite3）与当前 Node 大版本不匹配，按上一条处理。',
  '启动日志里 `Node.js : vX.Y.Z (... , ABI NNN)` 那一行会显示当前 ABI，便于排查。',
  '',
  '**7. 想换机器/重装**',
  '只拷贝 `data/` 目录即可保留媒体库、标签、收藏与观看进度。',
  '',
  '## 六、卸载',
  '',
  '直接删除整个安装目录（若你不想保留数据，先删 `data/`）。程序不写注册表、不装服务。',
  '',
].join('\n');

/* ------------------------------------------------------------------ *
 * 包内文件：.env.example
 * ------------------------------------------------------------------ */

const ENV_EXAMPLE_SRC = [
  '# 影巢 CineNest 配置示例',
  '# 复制本文件为 .env 后按需修改（不改也能跑，均为可选）',
  '',
  '# 服务端口（默认 8080）',
  '# 优先级：--port 参数 > 系统环境变量 PORT > 本文件 > 默认 8080',
  'PORT=8080',
  '',
  '# 监听地址：0.0.0.0 = 局域网可访问；127.0.0.1 = 仅本机',
  'HOST=0.0.0.0',
  '',
].join('\n');

/* ------------------------------------------------------------------ *
 * 打包
 * ------------------------------------------------------------------ */

/**
 * 递归删除，**返回是否真的删干净**。
 *
 * 静默吞掉失败是真实教训：staging 没删掉时 copyInto 会往旧产物上追加，
 * 压出的包里混着上一版的陈旧 chunk（陈旧 hash 的 js 一起被发布）。
 * 调用方必须检查返回值，删不掉就中止打包。
 */
function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  return !fs.existsSync(p);
}

function copyInto(srcAbs, destAbs) {
  if (!fs.existsSync(srcAbs)) return false;
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  fs.cpSync(srcAbs, destAbs, { recursive: true, force: true });
  return true;
}

function human(bytes) {
  if (bytes > 1024 * 1024 * 1024) return (bytes / 1073741824).toFixed(2) + ' GB';
  if (bytes > 1024 * 1024) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1024).toFixed(0) + ' KB';
}

/**
 * 修正 zip 中文文件名的 UTF-8 标志位（general purpose bit 11）。
 * bsdtar 写 zip 时不置该位，中文 Windows 用「资源管理器」解压会按 GBK 解码导致文件名乱码。
 * 这里直接改写中央目录与本地文件头的 flags（不影响压缩数据与 CRC）。
 * @returns {number} 修正的条目数
 */
function fixZipUtf8Flags(zipPath) {
  const buf = fs.readFileSync(zipPath);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 70000; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return 0;

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  let fixed = 0;

  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const cmtLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8');

    if (/[^\x00-\x7F]/.test(name)) {
      buf.writeUInt16LE(buf.readUInt16LE(off + 8) | 0x0800, off + 8);
      if (localOff + 8 < buf.length && buf.readUInt32LE(localOff) === 0x04034b50) {
        buf.writeUInt16LE(buf.readUInt16LE(localOff + 6) | 0x0800, localOff + 6);
      }
      fixed += 1;
    }
    off += 46 + nameLen + extraLen + cmtLen;
  }

  if (fixed) fs.writeFileSync(zipPath, buf);
  return fixed;
}

function zipDir(srcParent, folderName, outZip) {
  rmrf(outZip);
  const tarExe = 'C:\\Windows\\System32\\tar.exe';
  const useTar = fs.existsSync(tarExe);
  let r;
  if (useTar) {
    r = cp.spawnSync(tarExe, ['-a', '-c', '-f', outZip, '-C', srcParent, folderName], { stdio: 'inherit' });
  } else {
    r = cp.spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      'Compress-Archive -Path "' + path.join(srcParent, folderName) + '" -DestinationPath "' + outZip + '" -Force',
    ], { stdio: 'inherit' });
  }
  if (r.status !== 0 || !fs.existsSync(outZip)) {
    throw new Error('打包失败（' + (useTar ? 'tar' : 'Compress-Archive') + ' 退出码 ' + r.status + '）');
  }

  const fixed = fixZipUtf8Flags(outZip);
  if (fixed) console.log('      已修正 ' + fixed + ' 个中文文件名的 UTF-8 标志位');

  return fs.statSync(outZip).size;
}

/* ------------------------------------------------------------------ *
 * start.cmd 静态卫兵（打包前强制校验，防止 v1.4.5 那类回归）
 * ------------------------------------------------------------------ */
function lintStartCmd(text) {
  const problems = [];

  if (/[^\x00-\x7F]/.test(text)) {
    problems.push('含非 ASCII 字符：cmd 在不同代码页下可能乱码或被逐字节误解析');
  }
  if (/\n/.test(text.replace(/\r\n/g, ''))) {
    problems.push('存在 LF 换行：.cmd 必须使用 CRLF 换行');
  }
  if (/[()]/.test(text)) {
    problems.push('出现小括号：括号会被 cmd 用于 if/for 块配对，块内 echo 的右括号会导致提前闭合，请改用 goto 结构');
  }

  const lines = text.split('\r\n');
  lines.forEach((line, i) => {
    const m = /^\s*echo\s*(.*)$/i.exec(line);
    if (m && /[&|<>]/.test(m[1])) {
      problems.push('第 ' + (i + 1) + ' 行 echo 含 & | < > 特殊字符，需转义或改写');
    }
  });

  const defined = new Set();
  lines.forEach((line) => {
    const m = /^\s*:([\w.-]+)/.exec(line);
    if (m) defined.add(m[1].toLowerCase());
  });
  lines.forEach((line, i) => {
    const m = /^\s*goto\s+:?([\w.-]+)/i.exec(line);
    if (m && !defined.has(m[1].toLowerCase())) {
      problems.push('第 ' + (i + 1) + ' 行 goto ' + m[1] + ' 找不到对应标签');
    }
  });

  return problems;
}

/**
 * 打包前校验必需素材是否齐备。
 * copyInto() 对缺失的源是静默跳过的，若不先查一遍，缺 dist/ 之类会打出
 * 一个「后端能跑、打开却是空白页」的包，且打包过程看不出任何异常。
 */
function checkSources() {
  const missing = [];
  const need = [
    ['server/index.js', '后端入口'],
    ['server/config.js', '后端配置'],
    ['package.json', '依赖清单'],
    ['package-lock.json', '依赖锁定文件'],
    ['node_modules/better-sqlite3/package.json', '运行依赖 better-sqlite3'],
    ['node_modules/better-sqlite3/build/Release/better_sqlite3.node', 'better-sqlite3 原生模块'],
    ['dist/index.html', '前端构建产物'],
  ];
  for (const [rel, desc] of need) {
    if (!fs.existsSync(path.join(ROOT, rel))) missing.push(rel + '（' + desc + '）');
  }

  if (missing.length) {
    throw new Error(
      '缺少打包必需的文件：' + missing.map((s) => '\n    - ' + s).join('')
      + (missing.some((s) => s.startsWith('dist/'))
        ? '\n  → 前端未构建，请先在项目根目录执行 npm run build（或 npm.cmd run build）'
        : '')
      + (missing.some((s) => s.startsWith('node_modules/'))
        ? '\n  → 运行依赖不完整，请先执行 npm install'
        : '')
    );
  }

  // 前端产物至少要有 JS/CSS，避免只有一个空壳 index.html
  const assets = path.join(ROOT, 'dist', 'assets');
  const n = fs.existsSync(assets) ? fs.readdirSync(assets).length : 0;
  if (n === 0) {
    throw new Error('dist/assets 为空，前端构建产物不完整，请重新执行 npm run build');
  }
  console.log('  素材校验通过（前端产物 ' + n + ' 个资源文件）');
}

/** 组装一个部署包目录 */
function assemble(withFfmpeg) {
  const cmdIssues = lintStartCmd(START_CMD_SRC);
  if (cmdIssues.length) {
    throw new Error('start.cmd 静态校验未通过：' + cmdIssues.map((s) => '\n    - ' + s).join(''));
  }

  const stage = path.join(STAGE_ROOT, withFfmpeg ? 'offline' : 'standard');
  const pkg = path.join(stage, PKG_DIR_NAME);
  if (!rmrf(stage)) {
    throw new Error(
      '暂存目录清理失败：' + stage +
      '\n    （里面残留着上一次打包的旧产物，直接压缩会把陈旧文件混进包里）' +
      '\n    → 请手动删除整个 ' + STAGE_ROOT + ' 目录后重新执行打包'
    );
  }
  fs.mkdirSync(pkg, { recursive: true });

  // 代码与产物
  copyInto(path.join(ROOT, 'server'), path.join(pkg, 'server'));
  copyInto(path.join(ROOT, 'dist'), path.join(pkg, 'dist'));
  copyInto(path.join(ROOT, 'package.json'), path.join(pkg, 'package.json'));
  copyInto(path.join(ROOT, 'package-lock.json'), path.join(pkg, 'package-lock.json'));
  copyInto(path.join(ROOT, 'README.md'), path.join(pkg, 'README.md'));
  copyInto(path.join(ROOT, 'CHANGELOG.md'), path.join(pkg, 'CHANGELOG.md'));

  // 运行依赖（已内置，开箱即用；Node 大版本不同时启动器会自动切换原生模块）
  copyInto(path.join(ROOT, 'node_modules'), path.join(pkg, 'node_modules'));

  // 多 ABI 原生模块：让同一个部署包在 Node 20/22/23/24/25 下都能直接跑（免联网、免编译）
  const vendorDir = path.join(ROOT, 'vendor', 'sqlite3');
  if (!fs.existsSync(vendorDir)) {
    throw new Error('缺少 vendor/sqlite3（多版本原生模块），无法打包');
  }
  for (const abi of REQUIRED_ABIS) {
    const f = path.join(vendorDir, 'node-v' + abi + '-win32-x64', 'better_sqlite3.node');
    if (!fs.existsSync(f)) throw new Error('vendor/sqlite3 缺少 ABI ' + abi + ' 的二进制，请重新准备');
    const sz = fs.statSync(f).size;
    if (sz < 512 * 1024) throw new Error('ABI ' + abi + ' 的二进制体积异常：' + human(sz));
  }
  copyInto(vendorDir, path.join(pkg, 'vendor', 'sqlite3'));

  // FFmpeg（仅离线包；标准包由启动器按需自动获取）
  if (withFfmpeg) {
    const src = path.join(ROOT, 'bin', 'ffmpeg');
    if (!ffmpegFetch.ffmpegReady(src)) {
      // 兜底：正常流程下 main() 已在打包前调用 ensureFfmpegForPack() 补齐
      throw new Error('离线包需要 bin/ffmpeg/（ffmpeg.exe + ffprobe.exe），请先补齐或检查自动下载是否成功');
    }
    copyInto(src, path.join(pkg, 'bin', 'ffmpeg'));
    // 校验文件完整（体积应 > 20MB）
    const sz = fs.statSync(path.join(pkg, 'bin', 'ffmpeg', 'ffmpeg.exe')).size;
    if (sz < 20 * 1024 * 1024) throw new Error('bin/ffmpeg/ffmpeg.exe 体积异常：' + human(sz));
  }

  // 启动入口与文档
  // 注意：包内文件名统一用 ASCII —— 中文文件名在不同解压工具/代码页下会出现乱码或被跳过
  //（Windows 资源管理器按 ANSI 代码页解码、bsdtar 置 UTF-8 位后又无法转换到非中文代码页）。
  // 中文说明放在文档内容中，入口固定为 start.cmd。
  fs.writeFileSync(path.join(pkg, 'launcher.cjs'), LAUNCHER_SRC, 'utf8');
  fs.writeFileSync(path.join(pkg, 'start.cmd'), START_CMD_SRC, 'latin1');
  fs.writeFileSync(path.join(pkg, 'DEPLOY-README.md'), DEPLOY_DOC_SRC, 'utf8');
  fs.writeFileSync(path.join(pkg, '.env.example'), ENV_EXAMPLE_SRC, 'utf8');

  return pkg;
}

function dirSize(dir) {
  let total = 0;
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else { try { total += fs.statSync(full).size; } catch (_) { /* ignore */ } }
    }
  };
  walk(dir);
  return total;
}

/** 离线包需要 FFmpeg：缺失时自动获取（bin/ffmpeg/ 不入版本库，新克隆的仓库靠这里补齐） */
async function ensureFfmpegForPack() {
  const dir = path.join(ROOT, 'bin', 'ffmpeg');
  if (ffmpegFetch.ffmpegReady(dir)) {
    console.log('  [OK]   FFmpeg 就绪（bin/ffmpeg）');
    return true;
  }

  console.log('  [..]   bin/ffmpeg 缺失（该目录不入版本库），正在自动获取 ...');
  const got = await ffmpegFetch.fetchFfmpeg({
    destDir: dir,
    cacheDir: path.join(ROOT, '.cache'),
    log: (s) => console.log(s),
  });
  if (got) return true;

  console.log('');
  console.log('  [!!]   自动获取 FFmpeg 失败。可手动下载 Windows 静态版，把');
  console.log('         ffmpeg.exe 与 ffprobe.exe 放到：' + dir);
  console.log('         下载地址：https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip');
  console.log('         内网镜像可用环境变量 CINENEST_FFMPEG_MIRROR（多个用 | 分隔）');
  console.log('         或者只打标准包：node build-deploy.cjs --standard');
  return false;
}

(async function main() {
  console.log('');
  console.log('============================================================');
  console.log('  影巢 CineNest · 一键部署包打包器   ' + VERSION);
  console.log('============================================================');
  console.log('  项目根目录 : ' + ROOT);
  console.log('  生成内容   : ' + (BUILD_STANDARD ? '标准包 ' : '') + (BUILD_OFFLINE ? '离线包' : ''));
  console.log('');
  console.log('  打包机 Node : ' + process.version + '（ABI ' + process.versions.modules + '，包内不改写原生模块）');
  checkSources();
  console.log('');

  const results = [];

  if (BUILD_STANDARD) {
    console.log('[1/2] 组装标准包（不含 FFmpeg，首次启动自动下载）...');
    const pkg = assemble(false);
    const raw = dirSize(pkg);
    console.log('      目录体积 ' + human(raw));
    const out = path.join(ROOT, 'CineNest-Deploy-' + VERSION + '-win-x64.zip');
    console.log('      正在压缩 ...');
    const size = zipDir(path.dirname(pkg), PKG_DIR_NAME, out);
    console.log('      -> ' + out + '  (' + human(size) + ')');
    results.push({ name: path.basename(out), size, path: out });
    console.log('');
  }

  if (BUILD_OFFLINE) {
    console.log('[2/2] 组装离线包（内置 FFmpeg，可无网部署）...');
    if (!(await ensureFfmpegForPack())) {
      process.exitCode = 1;
      console.log('');
      return;
    }
    const pkg = assemble(true);
    const raw = dirSize(pkg);
    console.log('      目录体积 ' + human(raw));
    const out = path.join(ROOT, 'CineNest-Deploy-' + VERSION + '-offline-win-x64.zip');
    console.log('      正在压缩（含 320MB+ FFmpeg，需要一点时间）...');
    const size = zipDir(path.dirname(pkg), PKG_DIR_NAME, out);
    console.log('      -> ' + out + '  (' + human(size) + ')');
    results.push({ name: path.basename(out), size, path: out });
    console.log('');
  }

  console.log('============================================================');
  console.log('  打包完成：');
  for (const r of results) console.log('    ' + r.name + '   ' + human(r.size));
  console.log('============================================================');
  console.log('');
})().catch((err) => {
  console.error('');
  console.error('  打包失败：' + (err && err.message ? err.message : err));
  console.error('');
  process.exit(1);
});
