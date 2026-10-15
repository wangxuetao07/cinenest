<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useMessage } from 'naive-ui';
import Artplayer from 'artplayer';
import Hls from 'hls.js';
import { historyApi, type Video, type SpriteInfo } from '@/api';

const props = withDefaults(
  defineProps<{
    video: Video;
    nextId?: number | null;
    autoplay?: boolean;
    volume?: number;
    rememberProgress?: boolean;
  }>(),
  { nextId: null, autoplay: true, volume: 1, rememberProgress: true }
);

const emit = defineEmits<{
  (e: 'ended'): void;
  (e: 'next'): void;
  (e: 'progress', payload: { progress: number; duration: number }): void;
}>();

const message = useMessage();

const container = ref<HTMLElement | null>(null);
let art: Artplayer | null = null;
let reportTimer: number | null = null;
let seekDone = false;

/* 窄屏（手机）：控制栏空间紧张，自定义按钮改用紧凑文案 */
const isNarrow = ref(false);
let narrowMq: MediaQueryList | null = null;
function syncNarrow(e: MediaQueryList | MediaQueryListEvent) {
  isNarrow.value = e.matches;
}

/**
 * 播放地址策略：
 * - 源文件本身就是 HLS（.m3u8/.m3u）→ 走 HLS 播放列表接口
 * - 其它 → 先直出原文件（mp4/webm 最省资源）
 * - 直出被浏览器拒绝（mkv/avi/hevc 等）→ 自动降级到实时转码 HLS
 */
const isHlsSource = computed(() => {
  const ext = String(props.video.ext || '').toLowerCase();
  return ext === '.m3u8' || ext === '.m3u';
});

const directUrl = computed(() => `/api/stream/${props.video.id}`);
const hlsUrl = computed(() => `/api/stream/${props.video.id}/hls.m3u8`);

const mode = ref<'direct' | 'hls'>(isHlsSource.value ? 'hls' : 'direct');
const transcoded = ref(false);

const playUrl = computed(() => (mode.value === 'hls' ? hlsUrl.value : directUrl.value));

function report(force = false) {
  if (!art) return;
  const duration = Number(art.duration) || Number(props.video.duration) || 0;
  const progress = Number(art.currentTime) || 0;
  if (!duration) return;
  if (!force && progress < 1) return;
  historyApi
    .report(props.video.id, { progress, duration })
    .then(() => emit('progress', { progress, duration }))
    .catch(() => void 0);
}

/* ------------------------------------------------------------------ *
 * 字幕：开关 + 同名侧挂字幕（.srt / .ass / .vtt）
 * ------------------------------------------------------------------ */

const SUB_PREF_KEY = 'cinenest.subtitle';
const SUB_LABEL = '默认字幕';
const SUB_ON_COLOR = '#4f8cff';

/** 字幕开关偏好（浏览器级，默认开启，跟随账号所在浏览器记忆） */
function readSubPref(): boolean {
  try {
    return localStorage.getItem(SUB_PREF_KEY) !== 'off';
  } catch (_) {
    return true;
  }
}

function writeSubPref(on: boolean) {
  try {
    localStorage.setItem(SUB_PREF_KEY, on ? 'on' : 'off');
  } catch (_) {
    /* 无痕模式等场景忽略 */
  }
}

const subtitlesOn = ref(readSubPref());
/** 当前视频是否存在同名字幕 */
const hasSubtitle = ref(false);

let subtitleUrl: string | null = null; // 转成 WebVTT 后的 blob 地址（同一视频内复用）
let subtitleTrackEl: HTMLTrackElement | null = null;
let subtitleRequested = false; // 同一视频只请求一次

/** 取回同名字幕（后端负责 SRT/ASS → VTT），404 即无字幕 */
async function fetchSubtitle() {
  if (subtitleRequested) return;
  subtitleRequested = true;
  const vid = props.video.id;
  try {
    const res = await fetch(`/api/subtitle/${vid}`);
    if (!res.ok) return;
    const text = await res.text();
    if (vid !== props.video.id) return; // 请求期间已切片
    if (!text.trim()) return;
    subtitleUrl = URL.createObjectURL(new Blob([text], { type: 'text/vtt' }));
    hasSubtitle.value = true;
  } catch (_) {
    /* 无字幕 / 网络异常：静默降级为「无字幕」 */
  }
}

/** 把字幕轨道挂到当前 <video> 上（重建播放器后需要重新挂载） */
function mountSubtitleTrack() {
  if (!art || !subtitleUrl) return;
  const video = art.video;
  if (!video) return;

  if (subtitleTrackEl?.parentNode) subtitleTrackEl.parentNode.removeChild(subtitleTrackEl);

  const el = document.createElement('track');
  el.kind = 'subtitles';
  el.label = SUB_LABEL;
  el.srclang = 'zh';
  el.src = subtitleUrl;
  video.appendChild(el);
  subtitleTrackEl = el;

  // 轨道加载完成后再同步一次开关状态
  el.addEventListener('load', applySubtitleMode);
  applySubtitleMode();
}

/** 应用开关状态：开启 → showing，关闭 → disabled */
function applySubtitleMode() {
  const track = subtitleTrackEl?.track;
  if (!track) return;
  try {
    track.mode = subtitlesOn.value ? 'showing' : 'disabled';
  } catch (_) {
    /* 个别浏览器在轨道未就绪时赋值会抛错，忽略即可 */
  }
}

/** 探测并挂载同名字幕 */
async function attachSubtitle() {
  await fetchSubtitle();
  if (!art) return; // 请求期间播放器已销毁
  if (hasSubtitle.value) mountSubtitleTrack();
  refreshSubtitleControl();
}

/** 换片时释放上一个视频的字幕资源 */
function releaseSubtitle() {
  if (subtitleUrl) {
    URL.revokeObjectURL(subtitleUrl);
    subtitleUrl = null;
  }
  subtitleTrackEl = null;
  subtitleRequested = false;
  hasSubtitle.value = false;
}

function subtitleControlHtml() {
  const pad = isNarrow.value ? '0 4px' : '0 6px';
  const size = isNarrow.value ? '13px' : '12px';
  if (!hasSubtitle.value) {
    return `<span style="font-size:${size};padding:${pad};opacity:.45">字幕</span>`;
  }
  const style = subtitlesOn.value ? `color:${SUB_ON_COLOR};font-weight:600;` : 'opacity:.75;';
  return `<span style="font-size:${size};padding:${pad};${style}">字幕 ${subtitlesOn.value ? '开' : '关'}</span>`;
}

function subtitleTooltip() {
  if (!hasSubtitle.value) return '未找到同名字幕文件（同名 .srt / .ass / .vtt）';
  return subtitlesOn.value ? '点击关闭字幕' : '点击开启字幕';
}

/** 刷新控制栏按钮的文案 / 提示 / 状态色 */
function refreshSubtitleControl() {
  if (!art) return;
  art.controls.update({
    name: 'subtitle-btn',
    position: 'right',
    index: 25,
    html: subtitleControlHtml(),
    tooltip: subtitleTooltip(),
    click: onSubtitleClick,
  });
  fitControls(); // update 会重建按钮元素，重新做一次宽度适配
}

/** 开关字幕，并记住偏好 */
function setSubtitles(on: boolean) {
  if (!hasSubtitle.value || on === subtitlesOn.value) return;
  subtitlesOn.value = on;
  writeSubPref(on);
  applySubtitleMode();
  refreshSubtitleControl();
  if (art) art.notice.show = on ? '字幕已开启' : '字幕已关闭';
}

function onSubtitleClick() {
  if (!hasSubtitle.value) {
    message.info('这个视频没有同名字幕文件（同名 .srt / .ass / .vtt）');
    return;
  }
  setSubtitles(!subtitlesOn.value);
}

/* ------------------------------------------------------------------ *
 * 进度条抽帧预览（精灵图，v1.3）
 *
 * 后端抽帧是重活（4K 素材单张要 20-30 秒），所以 /info 接口不等待，
 * 只告诉我们「已就绪」或「正在后台生成」，前端据此短轮询。
 * 没有精灵图就静默降级 —— 进度条不显示气泡，不影响任何播放行为。
 * ------------------------------------------------------------------ */

/** 轮询令牌：换片 / 卸载后自增，让旧的轮询自动退出 */
let spriteToken = 0;

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function applyThumbnails(info: SpriteInfo) {
  if (!art || !info.url || !info.number) return;
  try {
    art.thumbnails = {
      url: info.url,
      number: info.number,
      column: info.column,
      width: info.width,
      height: info.height,
    };
  } catch (_) {
    /* Artplayer 版本差异：失败就当没有预览 */
  }
}

async function attachThumbnails() {
  const token = (spriteToken += 1);
  const vid = props.video.id;
  const MAX_TRIES = 40; // 最多约 60 秒（4K 首帧抽帧最坏情况）

  for (let i = 0; i < MAX_TRIES; i += 1) {
    let info: SpriteInfo | null = null;
    try {
      const res = await fetch(`/api/sprite/${vid}/info`);
      info = res.ok ? ((await res.json()) as SpriteInfo) : null;
    } catch (_) {
      info = null;
    }
    if (token !== spriteToken || vid !== props.video.id || !art) return;
    if (!info) return;

    if (info.ready) {
      applyThumbnails(info);
      return;
    }
    // 生成失败 / 不可生成（源文件可疑）：放弃，保持无预览
    if (!info.generating) return;

    await sleep(1500);
    if (token !== spriteToken || vid !== props.video.id || !art) return;
  }
}

/* ------------------------------------------------------------------ *
 * 控制栏宽度自适应：
 * 手机窄屏（或细长片的时间文本很长）时，控制栏总宽可能超过容器宽度，
 * 而 Artplayer 的按钮 flex-shrink:0，超出部分会被容器裁掉 ——
 * 全屏按钮排在最右侧，最先消失。这里按「重要性从低到高」动态隐藏按钮，
 * 保证全屏按钮始终可见；空间充裕时再逐个恢复。
 * ------------------------------------------------------------------ */
/** 空间不足时的牺牲顺序（越靠前越先隐藏） */
const CONTROL_SACRIFICE = ['pip', 'setting', 'next-btn', 'subtitle-btn'] as const;

function fitControls() {
  if (!art) return;
  // 控制栏隐藏时（播放中自动隐藏）Artplayer 会切成迷你进度条态，
  // 布局基准不同，跳过；等控制栏重新显示（control 事件）时再适配。
  if (!(art.controls as unknown as { show?: boolean }).show) return;
  const tpl = art.template as unknown as { $controlsRight?: HTMLElement };
  const right = tpl.$controlsRight;
  if (!right) return;
  const controlsRow = right.parentElement; // .art-controls
  if (!controlsRow) return;

  const controls = art.controls as unknown as Record<string, HTMLElement | undefined>;

  // 先全部恢复，再从最不重要的开始按需隐藏
  for (const name of CONTROL_SACRIFICE) {
    const el = controls[name];
    if (el) el.style.display = '';
  }

  // 溢出判断：右组「外边距盒」右缘 vs 控制行「内容盒」右缘。
  // 右组带 -10px 负外边距（与 art-bottom 的 padding 用同一个 --art-padding），
  // 「刚好放下」时两者相等，因此无论 padding 处于什么过渡状态都成立，
  // 不会像直接比较播放器边缘那样在过渡期间误判。
  const overflow = () => {
    const group = right.getBoundingClientRect();
    const row = controlsRow.getBoundingClientRect();
    const groupMargin = parseFloat(getComputedStyle(right).marginRight) || 0;
    const rowPad = parseFloat(getComputedStyle(controlsRow).paddingRight) || 0;
    return group.right + groupMargin > row.right - rowPad + 1;
  };
  for (const name of CONTROL_SACRIFICE) {
    if (!overflow()) break;
    const el = controls[name];
    if (el) el.style.display = 'none';
  }
}

/* ------------------------------------------------------------------ *
 * 手机端进度条拖动预览（v1.3）
 *
 * Artplayer 内置的抽帧预览只在「点击进度条」的那一瞬间显示
 * （内部依据 setBar 的 hover 分支 / played+event 分支），手指按住拖动时
 * 反而什么都不显示。这里接管进度条的触摸事件，借用它自己的 hover 分支，
 * 让手机上「边拖边看」和桌面悬停体验一致。
 * ------------------------------------------------------------------ */

let progressEl: HTMLElement | null = null;

function touchPointOf(ev: TouchEvent): Touch | null {
  return (ev.touches && ev.touches[0]) || (ev.changedTouches && ev.changedTouches[0]) || null;
}

/**
 * Artplayer 内部取坐标的写法是 `isMobile ? event.touches[0].clientX : event.clientX`
 * （见 getPosFromEvent），因此这里构造一个两种访问方式都具备的事件对象：
 * 手机端走 touches，桌面触摸屏走 clientX；composedPath 转发给原生事件，
 * 它用来判断手指是否落在进度条高亮段上。
 */
function asPointerLike(ev: TouchEvent): Event {
  const t = touchPointOf(ev);
  const x = t ? t.clientX : 0;
  const y = t ? t.clientY : 0;
  const point = { clientX: x, clientY: y } as Touch;
  const clone: Record<string, unknown> = {
    clientX: x,
    clientY: y,
    touches: [point],
    changedTouches: [point],
    target: progressEl,
    preventDefault() { /* 空实现 */ },
    stopPropagation() { /* 空实现 */ },
  };
  const src = ev as unknown as { composedPath?: () => EventTarget[] };
  if (typeof src.composedPath === 'function') {
    clone.composedPath = () => src.composedPath!();
  }
  return clone as unknown as Event;
}

function emitSetBar(type: string, percentage: number, ev: Event) {
  const a = art as unknown as { emit?: (name: string, ...rest: unknown[]) => void };
  if (a && typeof a.emit === 'function') a.emit('setBar', type, percentage, ev);
}

function onProgressTouch(ev: TouchEvent) {
  if (!art || !progressEl) return;
  const t = touchPointOf(ev);
  if (!t) return;
  const rect = progressEl.getBoundingClientRect();
  if (!rect.width) return;
  const pct = Math.min(1, Math.max(0, (t.clientX - rect.left) / rect.width));
  if (pct <= 0) return;
  emitSetBar('hover', pct, asPointerLike(ev));
}

function onProgressTouchEnd(ev: TouchEvent) {
  if (!art) return;
  // 归零：清掉拖动时留下的 hover 进度条（缩略图等控制栏自动隐藏时一起消失）
  emitSetBar('hover', 0, asPointerLike(ev));
}

function unbindProgressTouch() {
  if (!progressEl) return;
  progressEl.removeEventListener('touchstart', onProgressTouch);
  progressEl.removeEventListener('touchmove', onProgressTouch);
  progressEl.removeEventListener('touchend', onProgressTouchEnd);
  progressEl.removeEventListener('touchcancel', onProgressTouchEnd);
  progressEl = null;
}

function bindProgressTouch() {
  const tpl = art?.template as unknown as { $progress?: HTMLElement };
  const el = tpl && tpl.$progress;
  if (!el) return;
  unbindProgressTouch();
  progressEl = el;
  el.addEventListener('touchstart', onProgressTouch, { passive: true });
  el.addEventListener('touchmove', onProgressTouch, { passive: true });
  el.addEventListener('touchend', onProgressTouchEnd, { passive: true });
  el.addEventListener('touchcancel', onProgressTouchEnd, { passive: true });
}

/* ------------------------------------------------------------------ *
 * 播放器生命周期
 * ------------------------------------------------------------------ */

function clearReportTimer() {
  if (reportTimer) {
    window.clearInterval(reportTimer);
    reportTimer = null;
  }
}

function destroyArt() {
  if (!art) return;
  unbindProgressTouch();
  try {
    art.destroy(false);
  } catch (_) {
    /* ignore */
  }
  art = null;
}

/** 重建播放器（切换播放地址 / 换片时用） */
function restart() {
  clearReportTimer();
  destroyArt();
  initPlayer();
}

let switching = false;

/** 直出格式浏览器放不了 → 降级到实时转码 HLS（只降一次，避免死循环） */
function onFatalPlaybackError() {
  if (switching || mode.value === 'hls') return;
  switching = true;
  mode.value = 'hls';
  transcoded.value = true;
  message.info('当前格式浏览器无法直接播放，已切换为实时转码（首帧需要几秒）');
  restart();
}

function initPlayer() {
  if (!container.value) return;
  seekDone = false;
  subtitleTrackEl = null; // 旧 DOM 已被清空

  art = new Artplayer({
    container: container.value,
    url: playUrl.value,
    poster: props.video.poster_path,
    volume: props.volume,
    autoplay: props.autoplay,
    autoSize: false,
    setting: true,
    playbackRate: true,
    aspectRatio: true,
    fullscreen: true,
    fullscreenWeb: true,
    pip: true,
    hotkey: true,
    screenshot: true,
    miniProgressBar: true,
    mutex: true,
    backdrop: true,
    playsInline: true,
    theme: '#4f8cff',
    lang: 'zh-cn',
    moreVideoAttr: {
      crossOrigin: 'anonymous',
      playsInline: true,
    },
    customType: {
      m3u8(video: HTMLVideoElement, url: string) {
        // 同一元素被复用时先销毁旧的 Hls 实例，避免内存泄漏
        const prev = (video as any).__hls;
        if (prev && typeof prev.destroy === 'function') {
          try { prev.destroy(); } catch (_) { /* ignore */ }
        }
        if (Hls.isSupported()) {
          const hls = new Hls({ enableWorker: true, lowLatencyMode: false });
          hls.loadSource(url);
          hls.attachMedia(video);
          hls.on(Hls.Events.ERROR, (_evt: unknown, data: any) => {
            if (data && data.fatal) onFatalPlaybackError();
          });
          (video as any).__hls = hls;
        } else {
          // Safari 等自带 HLS：直接交给原生
          video.src = url;
        }
      },
    },
  });

  // 记忆进度跳转：ready 与 loadedmetadata 双保险，只跳一次
  const trySeek = () => {
    if (!art || seekDone) return;
    const saved = Number(props.video.play_progress) || 0;
    if (!props.rememberProgress || saved <= 5) return;
    const total = Number(art.duration) || 0;
    // 距结尾不足 5 秒视为已看完，不再跳转
    if (total && saved >= total - 5) return;
    try {
      art.currentTime = saved;
      seekDone = true;
    } catch (_) {
      /* ignore */
    }
  };

  art.on('ready', () => {
    trySeek();
    attachSubtitle();
    attachThumbnails();
    bindProgressTouch();
    fitControls();
  });
  art.on('video:loadedmetadata', trySeek);
  art.on('video:error', onFatalPlaybackError);
  // 窗口缩放 / 全屏切换 / 元信息加载（时间文本变宽）都会触发 resize，重新适配控制栏
  art.on('resize', fitControls);
  // 控制栏重新显示时布局基准变化（迷你进度条态 padding 不同），重新适配
  art.on('control', (state: boolean) => {
    if (state) fitControls();
  });

  art.on('video:ended', () => {
    report(true);
    emit('ended');
  });

  // 自定义「下一个」按钮
  if (props.nextId) {
    art.controls.add({
      name: 'next-btn',
      position: 'right',
      index: 20,
      html: isNarrow.value
        ? '<span style="font-size:13px;padding:0 4px" title="播放下一个">⏭</span>'
        : '<span style="font-size:12px;padding:0 6px">下一个 ⏭</span>',
      tooltip: '播放下一个',
      click: () => emit('next'),
    });
  }

  // 字幕开关按钮（有无字幕在探测完成后刷新）
  art.controls.add({
    name: 'subtitle-btn',
    position: 'right',
    index: 25,
    html: subtitleControlHtml(),
    tooltip: subtitleTooltip(),
    click: onSubtitleClick,
  });

  // 周期上报
  reportTimer = window.setInterval(() => report(false), 5000);
}

onMounted(() => {
  narrowMq = window.matchMedia('(max-width: 767px)');
  syncNarrow(narrowMq);
  narrowMq.addEventListener('change', syncNarrow);
  initPlayer();
});

onBeforeUnmount(() => {
  narrowMq?.removeEventListener('change', syncNarrow);
  spriteToken += 1; // 让抽帧预览轮询退出
  clearReportTimer();
  // 离开时立即上报一次
  report(true);
  releaseSubtitle();
  destroyArt();
});

// 切换视频时重建播放器
watch(
  () => props.video.id,
  () => {
    report(true);
    releaseSubtitle();
    mode.value = isHlsSource.value ? 'hls' : 'direct';
    transcoded.value = false;
    switching = false;
    restart();
  }
);

defineExpose({
  get instance() {
    return art;
  },
});
</script>

<template>
  <div class="w-full">
    <div ref="container" class="cn-player-shell w-full aspect-video bg-black overflow-hidden"></div>
    <div v-if="transcoded" class="mt-2 text-[12px] text-muted flex items-center gap-1.5">
      <span class="w-1.5 h-1.5 rounded-full bg-accent inline-block"></span>
      实时转码（HLS）播放中 · 首帧需要几秒，拖拽定位会等服务端补齐对应分片
    </div>
  </div>
</template>
