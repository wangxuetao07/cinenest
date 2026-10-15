<script setup lang="ts">
import type { VideoFilters } from '@/api';

const props = defineProps<{ modelValue: VideoFilters }>();
const emit = defineEmits<{ (e: 'update:modelValue', v: VideoFilters): void }>();

const sortOptions = [
  { label: '最近添加', value: 'added_at DESC' },
  { label: '最早上传', value: 'added_at ASC' },
  { label: '标题 A→Z', value: 'title ASC' },
  { label: '时长最长', value: 'duration DESC' },
  { label: '体积最大', value: 'size DESC' },
];

const resolutionOptions = [
  { label: '全部清晰度', value: '' },
  { label: '4K 及以上', value: '2160' },
  { label: '1080P 及以上', value: '1080' },
  { label: '720P 及以上', value: '720' },
  { label: '480P 及以上', value: '480' },
];

const durationOptions = [
  { label: '全部时长', value: '' },
  { label: '短片 (≤10 分钟)', value: 'short' },
  { label: '中等 (10-60 分钟)', value: 'medium' },
  { label: '长片 (>60 分钟)', value: 'long' },
];

function patch(part: Partial<VideoFilters>) {
  emit('update:modelValue', { ...props.modelValue, ...part });
}
</script>

<template>
  <div class="flex items-center gap-2 md:gap-3 flex-wrap">
    <div class="w-[calc(50%-0.25rem)] md:w-[150px]">
      <n-select
        :value="props.modelValue.sort"
        :options="sortOptions"
        size="small"
        @update:value="(v: string) => patch({ sort: v })"
      />
    </div>

    <div class="w-[calc(50%-0.25rem)] md:w-[150px]">
      <n-select
        :value="props.modelValue.resolution"
        :options="resolutionOptions"
        size="small"
        @update:value="(v: string) => patch({ resolution: v })"
      />
    </div>

    <div class="w-full md:w-[190px]">
      <n-select
        :value="props.modelValue.duration"
        :options="durationOptions"
        size="small"
        @update:value="(v: string) => patch({ duration: v })"
      />
    </div>

    <n-checkbox
      class="shrink-0"
      :checked="props.modelValue.favorite"
      size="small"
      @update:checked="(v: boolean) => patch({ favorite: v })"
    >
      <span class="text-[13px]">仅收藏</span>
    </n-checkbox>

    <div class="ml-auto shrink-0 flex items-center rounded-lg bg-white/5 p-0.5">
      <button
        class="w-9 h-8 md:w-8 md:h-7 rounded-md flex items-center justify-center transition-colors"
        :class="props.modelValue.view === 'grid' ? 'bg-accent text-white' : 'text-muted hover:text-white'"
        title="网格视图"
        @click="patch({ view: 'grid' })"
      >
        <svg viewBox="0 0 24 24" class="w-4 h-4" fill="currentColor">
          <path d="M4 4h7v7H4zm9 0h7v7h-7zM4 13h7v7H4zm9 0h7v7h-7z" />
        </svg>
      </button>
      <button
        class="w-9 h-8 md:w-8 md:h-7 rounded-md flex items-center justify-center transition-colors"
        :class="props.modelValue.view === 'list' ? 'bg-accent text-white' : 'text-muted hover:text-white'"
        title="列表视图"
        @click="patch({ view: 'list' })"
      >
        <svg viewBox="0 0 24 24" class="w-4 h-4" fill="currentColor">
          <path d="M4 5h16v2H4zm0 6h16v2H4zm0 6h16v2H4z" />
        </svg>
      </button>
    </div>
  </div>
</template>
