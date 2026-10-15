<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useMessage } from 'naive-ui';
import { videosApi, type Video } from '@/api';
import VideoCard from '@/components/VideoCard.vue';
import EmptyState from '@/components/EmptyState.vue';

const router = useRouter();
const message = useMessage();

const list = ref<Video[]>([]);
const loading = ref(true);

async function load() {
  loading.value = true;
  try {
    const res = await videosApi.favorites({ size: 200 });
    list.value = res.items;
  } catch (err: any) {
    message.error(err?.message || '加载失败');
  } finally {
    loading.value = false;
  }
}

async function unfavorite(v: Video) {
  try {
    await videosApi.update(v.id, { favorite: 0 });
    list.value = list.value.filter((it) => it.id !== v.id);
    message.success('已取消收藏');
  } catch (err: any) {
    message.error(err?.message || '操作失败');
  }
}

onMounted(load);
</script>

<template>
  <div class="p-3 md:p-6 max-w-[1600px] mx-auto">
    <div class="flex items-center justify-between mb-4 md:mb-6">
      <h1 class="text-[18px] md:text-[22px] font-semibold">我的收藏</h1>
      <span class="text-[13px] text-muted">{{ list.length }} 个影片</span>
    </div>

    <div v-if="loading" class="flex justify-center py-24"><n-spin size="large" /></div>

    <div
      v-else-if="list.length"
      class="grid gap-2.5 md:gap-4"
      style="grid-template-columns: repeat(auto-fill, minmax(min(200px, 45%), 1fr))"
    >
      <div v-for="v in list" :key="v.id" class="group">
        <VideoCard :video="v" />
        <button
          class="mt-1.5 w-full h-8 rounded-md border border-line text-[12px] text-muted hover:text-[#ff6b81] hover:border-[#ff6b81]/50 transition-colors"
          @click="unfavorite(v)"
        >
          取消收藏
        </button>
      </div>
    </div>

    <EmptyState
      v-else
      title="还没有收藏任何影片"
      description="在影片详情页点击「收藏」，它就会出现在这里。"
      action-text="去首页逛逛"
      @action="router.push('/')"
    />
  </div>
</template>
