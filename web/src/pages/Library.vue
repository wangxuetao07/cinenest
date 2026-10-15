<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useMessage } from 'naive-ui';
import { librariesApi, videosApi, formatDuration, formatSize, type Video, type Library, type VideoFilters } from '@/api';
import { useAppStore } from '@/stores/app';
import { useAuthStore } from '@/stores/auth';
import FilterBar from '@/components/FilterBar.vue';
import VideoGrid from '@/components/VideoGrid.vue';
import EmptyState from '@/components/EmptyState.vue';

const route = useRoute();
const router = useRouter();
const message = useMessage();
const store = useAppStore();
const auth = useAuthStore();

const libraryId = computed(() => Number(route.params.id));
const library = ref<Library | null>(null);

/** 普通用户不展示被停用的媒体库 */
const visibleLibraries = computed(() =>
  auth.isAdmin ? store.libraries : store.libraries.filter((l) => !!l.enabled)
);

const videos = ref<Video[]>([]);
const total = ref(0);
const page = ref(1);
const size = 40;
const loading = ref(false);
const scanning = ref(false);

const filters = ref<VideoFilters>({
  sort: 'added_at DESC',
  view: 'grid',
  resolution: '',
  duration: '',
  favorite: false,
});

/** 把 UI 筛选映射为 API 参数 */
function buildQuery() {
  const q: Record<string, any> = {
    libraryId: libraryId.value,
    sort: filters.value.sort,
    page: page.value,
    size,
  };
  if (filters.value.resolution) q.minHeight = Number(filters.value.resolution);
  if (filters.value.favorite) q.favorite = 1;
  if (filters.value.duration === 'short') q.maxDuration = 600;
  if (filters.value.duration === 'medium') {
    q.minDuration = 600;
    q.maxDuration = 3600;
  }
  if (filters.value.duration === 'long') q.minDuration = 3600;
  return q;
}

async function loadVideos() {
  loading.value = true;
  try {
    const res = await videosApi.list(buildQuery());
    videos.value = res.items;
    total.value = res.total;
  } catch (err: any) {
    message.error(err?.message || '加载失败');
  } finally {
    loading.value = false;
  }
}

async function loadLibrary() {
  const libs = await store.loadLibraries(true);
  library.value = libs.find((l) => l.id === libraryId.value) || null;
}

async function doScan() {
  if (!library.value) return;
  scanning.value = true;
  try {
    const r = await librariesApi.scan(library.value.id);
    message.success(`扫描完成：新增 ${r.added}，更新 ${r.updated}，删除 ${r.deleted}，失败 ${r.failed}`);
    await Promise.all([loadVideos(), loadLibrary()]);
  } catch (err: any) {
    message.error(err?.message || '扫描失败');
  } finally {
    scanning.value = false;
  }
}

watch(libraryId, async () => {
  page.value = 1;
  await loadLibrary();
  await loadVideos();
});

watch(
  () => ({ ...filters.value }),
  () => {
    page.value = 1;
    loadVideos();
  },
  { deep: true }
);

watch(page, loadVideos);

onMounted(async () => {
  await loadLibrary();
  await loadVideos();
});
</script>

<template>
  <div class="p-3 md:p-6 max-w-[1600px] mx-auto">
    <!-- 头部 -->
    <div class="flex items-center gap-3 md:gap-4 mb-4 md:mb-5">
      <div class="min-w-0">
        <h1 class="text-[18px] md:text-[22px] font-semibold truncate">
          {{ library?.name || '媒体库' }}
        </h1>
        <div class="text-[12px] text-muted mt-0.5 truncate" :title="library?.path">
          {{ library?.path || '' }} · 共 {{ total }} 个视频
        </div>
      </div>

      <div class="ml-auto flex items-center gap-3 shrink-0">
        <n-button size="small" :loading="scanning" @click="doScan">立即扫描</n-button>
      </div>
    </div>

    <!-- 已停用提示 -->
    <div
      v-if="library && !library.enabled"
      class="mb-4 px-3 md:px-4 py-3 rounded-lg border border-[#c08a2a]/40 bg-[#c08a2a]/10 text-[13px] text-[#e2b76a]"
    >
      该媒体库已被管理员停用，库内视频不会出现在首页、搜索、收藏与历史中。
      <span v-if="auth.isAdmin">可在「设置 → 媒体库」中重新启用。</span>
    </div>

    <!-- 媒体库切换 -->
    <div class="flex items-center gap-2 mb-4 md:mb-5 flex-wrap">
      <button
        v-for="lib in visibleLibraries"
        :key="lib.id"
        class="h-8 px-3 rounded-lg text-[13px] transition-colors border"
        :class="
          lib.id === libraryId
            ? 'bg-accent/15 text-accent border-accent/40'
            : 'text-muted hover:text-white border-line hover:border-white/20'
        "
        @click="router.push(`/library/${lib.id}`)"
      >
        {{ lib.name }}
      </button>
    </div>

    <!-- 筛选栏 -->
    <div class="mb-4 pb-4 border-b border-line">
      <FilterBar v-model="filters" />
    </div>

    <!-- 网格视图 -->
    <VideoGrid
      v-if="filters.view === 'grid'"
      :videos="videos"
      :loading="loading"
      empty-title="这个媒体库里还没有匹配的视频"
      empty-description="尝试更换筛选条件，或点击「立即扫描」重新索引。"
    />

    <!-- 列表视图 -->
    <div v-else>
      <div v-if="loading && !videos.length" class="flex justify-center py-20"><n-spin size="large" /></div>
      <div v-else-if="videos.length" class="flex flex-col gap-2">
        <div
          v-for="v in videos"
          :key="v.id"
          class="cn-card flex items-center gap-2.5 md:gap-4 p-2 cursor-pointer"
          @click="router.push(`/video/${v.id}`)"
        >
          <img
            :src="v.thumb_path"
            class="w-[104px] md:w-[126px] aspect-video object-cover rounded-md bg-[#0b0d11] shrink-0"
          />
          <div class="min-w-0 flex-1">
            <div class="text-[13.5px] md:text-[14px] truncate">{{ v.title || v.file_name }}</div>
            <div class="text-[12px] text-muted mt-1 truncate" :title="v.file_path">{{ v.file_name }}</div>
          </div>
          <div class="hidden md:flex items-center gap-6 text-[12px] text-muted shrink-0 pr-2">
            <span>{{ formatDuration(v.duration) }}</span>
            <span>{{ v.height ? (v.height >= 1080 ? '1080P' : v.height + 'P') : '-' }}</span>
            <span>{{ formatSize(v.size) }}</span>
          </div>
          <button
            class="shrink-0 h-8 px-2.5 md:px-3 rounded-lg bg-accent/90 hover:bg-accent text-white text-[12.5px] md:text-[13px] transition-colors"
            @click.stop="router.push(`/watch/${v.id}`)"
          >
            播放
          </button>
        </div>
      </div>
      <EmptyState
        v-else
        title="没有匹配的视频"
        description="尝试更换筛选条件。"
      />
    </div>

    <!-- 分页 -->
    <div v-if="total > size" class="flex justify-center mt-6 md:mt-8 overflow-x-auto">
      <n-pagination
        v-model:page="page"
        :item-count="total"
        :page-size="size"
        :page-slot="7"
      />
    </div>
  </div>
</template>
