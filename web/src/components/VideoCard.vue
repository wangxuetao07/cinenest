<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from 'vue';
import { useRouter } from 'vue-router';
import { formatDuration, previewApi, type Video } from '@/api';

const props = withDefaults(
  defineProps<{
    video: Video;
    showProgress?: boolean;
    showMeta?: boolean;
    width?: string;
    /** 需要展示的标签（不传则不展示，搜索页用） */
    tags?: string[];
    /** 本次搜索命中的标签，会用主题色高亮 */
    highlightTags?: string[];
  }>(),
  { showProgress: true, showMeta: true, width: '', tags: undefined, highlightTags: undefined }
);

const router = useRouter();

/* ------------------------------------------------------------------ *
 * 悬停预览（v1.4，类 B 站）
 *
 * - 仅桌面（hover:hover + pointer:fine）启用，触屏设备完全不走这条路
 * - 悬停 350ms 后才起播（防误滑），离开立即停
 * - 全局单例：同一时刻最多一张卡片在播（鼠标滑过一排卡片不会同时响）
 * - canplay 前保持静态缩略图（淡入），不会闪黑
 * - 无片段时悬停只触发后端懒生成，下次悬停即可播放
 * ------------------------------------------------------------------ */

const hoverable =
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(hover: hover) and (pointer: fine)').matches;

/** 当前正在播放的卡片的停止函数（模块级单例） */
let activeStop: (() => void) | null = null;

const previewActive = ref(false); // <video> 是否挂载
const previewPlaying = ref(false); // 是否已开始播放（控制淡入）
const previewSrc = ref('');
const videoEl = ref<HTMLVideoElement | null>(null);

let enterTimer: number | null = null;
let removeTimer: number | null = null;

function clearEnterTimer() {
  if (enterTimer !== null) {
    window.clearTimeout(enterTimer);
    enterTimer = null;
  }
}

/** 延迟卸载 video 元素，快速来回悬停时不用重新拉流 */
function scheduleUnmount() {
  if (removeTimer !== null) window.clearTimeout(removeTimer);
  removeTimer = window.setTimeout(() => {
    removeTimer = null;
    if (!previewPlaying.value) {
      previewActive.value = false;
      previewSrc.value = '';
    }
  }, 800);
}

function stopSelf() {
  const v = videoEl.value;
  if (v) {
    try { v.pause(); } catch (_) { /* ignore */ }
    // 不重置 currentTime：短暂移开后回来能接着看（B 站同款体验）
  }
  previewPlaying.value = false;
  scheduleUnmount();
}

function startPreview() {
  const url = props.video.preview_path;
  if (!url) {
    // 还没生成：触发懒生成就好，本次保持静态缩略图（生成完下次悬停可播）
    previewApi
      .info(props.video.id)
      .then((info) => {
        if (info.ready) props.video.preview_path = info.url;
      })
      .catch(() => { /* 静默 */ });
    return;
  }
  if (previewActive.value && previewSrc.value === url) {
    // 短暂移开后回来（video 还挂着但被暂停了）：接着上次的进度继续播
    const v = videoEl.value;
    if (v && v.paused) {
      v.muted = true;
      const p = v.play();
      if (p && typeof p.catch === 'function') p.catch(() => { /* 策略拦截就静默 */ });
    }
    return;
  }

  activeStop?.(); // 全局单例：先停掉别的卡片
  previewSrc.value = url;
  previewPlaying.value = false;
  previewActive.value = true;
  activeStop = stopSelf;

  nextTick(() => {
    const v = videoEl.value;
    if (!v) return;
    delete v.dataset.retried; // 新一轮播放，重试额度重置
    v.muted = true; // autoplay 策略硬性要求，双保险
    const p = v.play();
    if (p && typeof p.catch === 'function') p.catch(() => { /* 被策略拦下就静默 */ });
  });
}

function onCardEnter() {
  if (!hoverable) return;
  clearEnterTimer();
  enterTimer = window.setTimeout(() => {
    enterTimer = null;
    startPreview();
  }, 350);
}

function onCardLeave() {
  clearEnterTimer();
  stopSelf();
}

/** 片段拉取/播放出错：第一次自动重试（瞬时中断免疫），连续失败才放弃回封面 */
function onVideoError() {
  const v = videoEl.value;
  if (v && !v.dataset.retried) {
    v.dataset.retried = '1';
    try {
      v.load();
      const p = v.play();
      if (p && typeof p.catch === 'function') p.catch(() => { /* 静默 */ });
      return;
    } catch (_) { /* 落到放弃 */ }
  }
  previewActive.value = false;
  previewSrc.value = '';
  previewPlaying.value = false;
  props.video.preview_path = null;
  if (activeStop === stopSelf) activeStop = null;
  previewApi.info(props.video.id).catch(() => { /* 静默 */ });
}

/** loop 兜底：个别环境循环回绕不可靠，ended 时手动续播 */
function onVideoEnded() {
  const v = videoEl.value;
  if (!v) return;
  try {
    v.currentTime = 0;
    const p = v.play();
    if (p && typeof p.catch === 'function') p.catch(() => { /* 静默 */ });
  } catch (_) { /* ignore */ }
}

onBeforeUnmount(() => {
  clearEnterTimer();
  if (removeTimer !== null) window.clearTimeout(removeTimer);
  if (activeStop === stopSelf) activeStop = null;
});

const title = computed(() => props.video.title || props.video.file_name);

/** 卡片上展示的标签（最多 3 个） */
const shownTags = computed(() => (props.tags || []).slice(0, 3));

function isHit(tag: string) {
  return (props.highlightTags || []).includes(tag);
}

/** 点标签 → 按该标签搜索 */
function searchTag(tag: string, e: Event) {
  e.stopPropagation();
  router.push({ name: 'search', query: { tag } });
}

const resolution = computed(() => {
  const w = props.video.width || 0;
  const h = props.video.height || 0;
  if (!h) return '';
  if (h >= 2160) return '4K';
  if (h >= 1080) return '1080P';
  if (h >= 720) return '720P';
  if (h >= 480) return '480P';
  return `${w}x${h}`;
});

const percent = computed(() => {
  const d = Number(props.video.play_duration) || 0;
  const p = Number(props.video.play_progress) || 0;
  if (d <= 0 || p <= 0) return 0;
  return Math.min(100, Math.round((p / d) * 100));
});

function openDetail() {
  router.push(`/video/${props.video.id}`);
}

function playNow(e: Event) {
  e.stopPropagation();
  router.push(`/watch/${props.video.id}`);
}
</script>

<template>
  <div
    class="cn-card group cursor-pointer relative"
    :style="props.width ? { width: props.width } : undefined"
    @click="openDetail"
    @mouseenter="onCardEnter"
    @mouseleave="onCardLeave"
  >
    <!-- 封面 -->
    <div class="relative aspect-video bg-[#0b0d11] overflow-hidden">
      <img
        :src="props.video.thumb_path"
        :alt="title"
        loading="lazy"
        class="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
        @error="($event.target as HTMLImageElement).style.opacity = '0'"
      />

      <!-- 悬停预览片段（v1.4）：起播后淡入盖住静态图 -->
      <video
        v-if="previewActive"
        ref="videoEl"
        :src="previewSrc"
        class="absolute inset-0 w-full h-full object-cover transition-opacity duration-300"
        :class="previewPlaying ? 'opacity-100' : 'opacity-0'"
        autoplay
        loop
        muted
        playsinline
        preload="auto"
        @playing="previewPlaying = true"
        @ended="onVideoEnded"
        @error="onVideoError"
      ></video>

      <!-- 悬浮播放按钮：预览起播后让位给画面 -->
      <div
        class="absolute inset-0 bg-black/35 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
        :class="previewPlaying ? '!opacity-0' : ''"
      >
        <button
          class="w-12 h-12 rounded-full bg-accent/90 hover:bg-accent flex items-center justify-center transition-transform hover:scale-110"
          title="立即播放"
          @click="playNow"
        >
          <svg viewBox="0 0 24 24" class="w-6 h-6 text-white ml-0.5" fill="currentColor">
            <path d="M8 5v14l11-7z" />
          </svg>
        </button>
      </div>

      <!-- 时长 -->
      <div
        v-if="props.video.duration > 0"
        class="absolute bottom-1.5 right-1.5 px-1.5 py-0.5 rounded bg-black/75 text-[11px] text-white tabular-nums"
      >
        {{ formatDuration(props.video.duration) }}
      </div>

      <!-- 分辨率 -->
      <div
        v-if="resolution"
        class="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded bg-black/65 text-[11px] text-[#c9d1e3]"
      >
        {{ resolution }}
      </div>

      <!-- 收藏标记 -->
      <div
        v-if="props.video.favorite"
        class="absolute top-1.5 right-1.5 w-6 h-6 rounded-md bg-black/60 flex items-center justify-center"
      >
        <svg viewBox="0 0 24 24" class="w-3.5 h-3.5 text-[#ff6b81]" fill="currentColor">
          <path d="M12 21s-7.5-4.7-9.3-9A5.3 5.3 0 0 1 12 6.4 5.3 5.3 0 0 1 21.3 12c-1.8 4.3-9.3 9-9.3 9z" />
        </svg>
      </div>

      <!-- 进度条 -->
      <div
        v-if="props.showProgress && percent > 0"
        class="absolute bottom-0 left-0 right-0 h-1 bg-black/50"
      >
        <div class="h-full bg-accent" :style="{ width: percent + '%' }"></div>
      </div>
    </div>

    <!-- 信息 -->
    <div class="p-2.5">
      <div class="text-[13px] leading-snug cn-clamp-2 h-[34px]" :title="title">{{ title }}</div>

      <!-- 标签（点击按标签搜索） -->
      <div v-if="shownTags.length" class="mt-1.5 flex items-center gap-1 flex-wrap">
        <button
          v-for="t in shownTags"
          :key="t"
          class="px-1.5 py-[1px] rounded text-[10.5px] leading-[16px] transition-colors"
          :class="
            isHit(t)
              ? 'bg-accent/20 text-accent hover:bg-accent/30'
              : 'bg-white/6 text-[#8b93a7] hover:bg-white/12 hover:text-white'
          "
          :title="`按标签搜索：${t}`"
          @click="searchTag(t, $event)"
        >
          {{ t }}
        </button>
      </div>

      <div v-if="props.showMeta" class="mt-1 flex items-center justify-between text-[11px] text-muted">
        <span class="truncate">{{ percent > 0 && props.showProgress ? `已看 ${percent}%` : formatDuration(props.video.duration) }}</span>
        <span v-if="props.video.play_progress > 0" class="text-accent shrink-0">
          {{ formatDuration(props.video.play_progress) }}
        </span>
      </div>
    </div>
  </div>
</template>
