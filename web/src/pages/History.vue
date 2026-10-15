<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useMessage } from 'naive-ui';
import { historyApi, formatDuration, type Video } from '@/api';
import EmptyState from '@/components/EmptyState.vue';

const router = useRouter();
const message = useMessage();

const list = ref<Video[]>([]);
const loading = ref(true);

function percent(v: Video) {
  const d = Number(v.play_duration) || 0;
  const p = Number(v.play_progress) || 0;
  if (d <= 0 || p <= 0) return 0;
  return Math.min(100, Math.round((p / d) * 100));
}

async function load() {
  loading.value = true;
  try {
    list.value = await historyApi.list(100);
  } catch (err: any) {
    message.error(err?.message || '加载失败');
  } finally {
    loading.value = false;
  }
}

async function remove(v: Video) {
  try {
    await historyApi.clear(v.id);
    list.value = list.value.filter((it) => it.id !== v.id);
    message.success('已移除播放记录');
  } catch (err: any) {
    message.error(err?.message || '操作失败');
  }
}

onMounted(load);
</script>

<template>
  <div class="p-3 md:p-6 max-w-[1400px] mx-auto">
    <h1 class="text-[18px] md:text-[22px] font-semibold mb-4 md:mb-6">继续观看</h1>

    <div v-if="loading" class="flex justify-center py-24"><n-spin size="large" /></div>

    <div v-else-if="list.length" class="flex flex-col gap-3">
      <div
        v-for="v in list"
        :key="v.id"
        class="cn-card flex flex-wrap md:flex-nowrap items-center gap-3 md:gap-4 p-2.5 md:p-3 cursor-pointer"
        @click="router.push(`/video/${v.id}`)"
      >
        <img
          :src="v.thumb_path"
          class="w-[112px] md:w-[150px] aspect-video object-cover rounded-md bg-[#0b0d11] shrink-0"
        />

        <div class="min-w-0 flex-1">
          <div class="text-[14px] md:text-[14.5px] truncate mb-1.5 md:mb-2">{{ v.title || v.file_name }}</div>
          <div class="h-1.5 rounded-full bg-white/10 overflow-hidden mb-1.5 md:mb-2 max-w-[420px]">
            <div class="h-full bg-accent" :style="{ width: percent(v) + '%' }"></div>
          </div>
          <div class="text-[12px] text-muted">
            已看 {{ percent(v) }}% · {{ formatDuration(v.play_progress) }} / {{ formatDuration(v.play_duration || v.duration) }}
            <span class="ml-2">· 最后观看 {{ v.last_played }}</span>
          </div>
        </div>

        <div class="flex w-full md:w-auto items-center justify-end gap-2 shrink-0">
          <button
            class="h-9 px-3.5 md:px-4 rounded-lg bg-accent hover:bg-accenthover text-white text-[13px] transition-colors"
            @click.stop="router.push(`/watch/${v.id}`)"
          >
            继续播放
          </button>
          <button
            class="h-9 px-3.5 md:px-4 rounded-lg border border-line text-muted hover:text-white hover:border-white/30 text-[13px] transition-colors"
            @click.stop="remove(v)"
          >
            移除
          </button>
        </div>
      </div>
    </div>

    <EmptyState
      v-else
      title="还没有观看记录"
      description="开始播放任意影片后，这里会自动记录进度，方便下次继续。"
      action-text="回首页看看"
      @action="router.push('/')"
    />
  </div>
</template>
