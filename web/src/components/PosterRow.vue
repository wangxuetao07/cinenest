<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import VideoCard from './VideoCard.vue';
import type { Video } from '@/api';

const props = withDefaults(
  defineProps<{
    title: string;
    videos: Video[];
    morePath?: string;
    cardWidth?: number;
    showProgress?: boolean;
  }>(),
  { morePath: '', cardWidth: 220, showProgress: true }
);

const router = useRouter();
const scroller = ref<HTMLElement | null>(null);

/** 卡片宽度：桌面用设定值，手机上按 56vw 收缩，保证一行能看到下一张的边 */
const cardStyleWidth = computed(() => `min(${props.cardWidth}px, 56vw)`);

function scrollBy(dir: number) {
  const el = scroller.value;
  if (!el) return;
  el.scrollBy({ left: dir * (el.clientWidth * 0.8), behavior: 'smooth' });
}

function goMore() {
  if (props.morePath) router.push(props.morePath);
}
</script>

<template>
  <section v-if="props.videos.length" class="mb-6 md:mb-8">
    <div class="flex items-center justify-between mb-3">
      <h2 class="text-[15px] md:text-[17px] font-semibold text-[#e6e8ee] truncate">{{ props.title }}</h2>
      <div class="flex items-center gap-2 shrink-0">
        <button
          v-if="props.morePath"
          class="text-[13px] text-muted hover:text-accent transition-colors"
          @click="goMore"
        >
          查看全部
        </button>
        <!-- 左右翻页按钮：触屏直接滑动即可，手机上隐藏 -->
        <button
          class="hidden md:flex w-7 h-7 rounded-md bg-white/5 hover:bg-white/10 items-center justify-center text-muted hover:text-white transition-colors"
          @click="scrollBy(-1)"
        >
          <svg viewBox="0 0 24 24" class="w-4 h-4" fill="currentColor">
            <path d="M15.4 7.4 14 6l-6 6 6 6 1.4-1.4L10.8 12z" />
          </svg>
        </button>
        <button
          class="hidden md:flex w-7 h-7 rounded-md bg-white/5 hover:bg-white/10 items-center justify-center text-muted hover:text-white transition-colors"
          @click="scrollBy(1)"
        >
          <svg viewBox="0 0 24 24" class="w-4 h-4" fill="currentColor">
            <path d="M8.6 16.6 10 18l6-6-6-6-1.4 1.4L13.2 12z" />
          </svg>
        </button>
      </div>
    </div>

    <div ref="scroller" class="cn-row cn-scroll">
      <VideoCard
        v-for="v in props.videos"
        :key="v.id"
        :video="v"
        :width="cardStyleWidth"
        :show-progress="props.showProgress"
      />
    </div>
  </section>
</template>
