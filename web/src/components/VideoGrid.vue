<script setup lang="ts">
import { computed } from 'vue';
import VideoCard from './VideoCard.vue';
import EmptyState from './EmptyState.vue';
import type { Video } from '@/api';

const props = withDefaults(
  defineProps<{
    videos: Video[];
    loading?: boolean;
    emptyTitle?: string;
    emptyDescription?: string;
    minWidth?: number;
    /** 是否在卡片上展示标签（配合搜索结果使用） */
    showTags?: boolean;
  }>(),
  {
    loading: false,
    emptyTitle: '这里还没有视频',
    emptyDescription: '前往「设置 → 媒体库」添加一个目录，然后执行扫描。',
    minWidth: 200,
    showTags: false,
  }
);

/**
 * 网格列宽：min(设定宽度, 45%)。
 * 宽屏时用设定宽度（维持原有观感），窄屏（手机）时按 45% 走 —— 保证一行两列不溢出。
 */
const gridStyle = computed(() => ({
  gridTemplateColumns: `repeat(auto-fill, minmax(min(${props.minWidth}px, 45%), 1fr))`,
}));
</script>

<template>
  <div>
    <div v-if="props.loading && props.videos.length === 0" class="grid gap-2.5 md:gap-4" :style="gridStyle">
      <div v-for="i in 12" :key="i" class="cn-card animate-pulse">
        <div class="aspect-video bg-[#20242d]"></div>
        <div class="p-2.5 space-y-2">
          <div class="h-3 bg-[#20242d] rounded w-4/5"></div>
          <div class="h-3 bg-[#20242d] rounded w-2/5"></div>
        </div>
      </div>
    </div>

    <div v-else-if="props.videos.length" class="grid gap-2.5 md:gap-4" :style="gridStyle">
      <VideoCard
        v-for="v in props.videos"
        :key="v.id"
        :video="v"
        :tags="props.showTags ? v.tags : undefined"
        :highlight-tags="props.showTags ? v.matched_tags : undefined"
      />
    </div>

    <EmptyState v-else :title="props.emptyTitle" :description="props.emptyDescription" />
  </div>
</template>
