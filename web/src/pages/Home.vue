<script setup lang="ts">
import { onMounted, ref, computed } from 'vue';
import { useRouter } from 'vue-router';
import { useMessage } from 'naive-ui';
import { videosApi, formatDuration, type Video, type Library } from '@/api';
import { useAppStore } from '@/stores/app';
import VideoGrid from '@/components/VideoGrid.vue';
import PosterRow from '@/components/PosterRow.vue';
import EmptyState from '@/components/EmptyState.vue';

const router = useRouter();
const message = useMessage();
const store = useAppStore();

const loading = ref(true);
const recent = ref<Video[]>([]);
const continueList = ref<Video[]>([]);
const sections = ref<{ library: Library; videos: Video[] }[]>([]);
const heroIndex = ref(0);

const heroItems = computed(() => recent.value.slice(0, 5));

/** 「最近添加」的「查看全部」→ 优先跳到第一个启用中的媒体库 */
const firstLibrary = computed(
  () => store.libraries.find((l) => !!l.enabled) || store.libraries[0] || null
);

async function load() {
  loading.value = true;
  try {
    const [recentRes, continueRes, libs] = await Promise.all([
      videosApi.recent(20),
      videosApi.continueWatching(20),
      store.loadLibraries(),
    ]);
    recent.value = recentRes;
    continueList.value = continueRes;

    // 只有启用中的媒体库才做分区展示（停用的库其视频已由后端过滤）
    const grouped = await Promise.all(
      libs
        .filter((l) => !!l.enabled)
        .map(async (library) => ({
          library,
          videos: await videosApi
            .list({ libraryId: library.id, size: 12 })
            .then((r) => r.items)
            .catch(() => []),
        }))
    );
    sections.value = grouped.filter((g) => g.videos.length > 0);

    // 自动轮播
    startHeroTimer();
  } catch (err: any) {
    message.error(err?.message || '加载失败');
  } finally {
    loading.value = false;
  }
}

let heroTimer: number | null = null;
function startHeroTimer() {
  if (heroTimer) window.clearInterval(heroTimer);
  if (heroItems.value.length <= 1) return;
  heroTimer = window.setInterval(() => {
    heroIndex.value = (heroIndex.value + 1) % heroItems.value.length;
  }, 6000);
}

function goWatch(id: number) {
  router.push(`/watch/${id}`);
}
function goDetail(id: number) {
  router.push(`/video/${id}`);
}

onMounted(load);
</script>

<template>
  <div class="p-3 md:p-6 max-w-[1600px] mx-auto">
    <!-- 加载态 -->
    <div v-if="loading" class="flex justify-center py-24">
      <n-spin size="large" />
    </div>

    <template v-else>
      <!-- 空状态：无任何视频 -->
      <EmptyState
        v-if="recent.length === 0"
        title="影巢里还没有影片"
        description="先在「设置 → 媒体库」添加一个本地目录，然后点击扫描，视频就会出现在这里。"
        action-text="去添加媒体库"
        @action="router.push('/settings')"
      />

      <template v-else>
        <!-- Hero 轮播 -->
        <section
          v-if="heroItems.length"
          class="relative rounded-xl overflow-hidden mb-6 md:mb-8 h-[230px] sm:h-[280px] md:h-[340px]"
        >
          <div
            v-for="(v, i) in heroItems"
            :key="v.id"
            class="absolute inset-0 transition-opacity duration-700"
            :class="i === heroIndex ? 'opacity-100 z-10' : 'opacity-0 z-0'"
          >
            <img :src="v.poster_path" class="absolute inset-0 w-full h-full object-cover" :alt="v.title || ''" />
            <div
              class="absolute inset-0"
              style="background: linear-gradient(90deg, rgba(15,17,21,.96) 0%, rgba(15,17,21,.75) 45%, rgba(15,17,21,.2) 100%)"
            ></div>

            <div class="relative h-full flex flex-col justify-end p-5 md:p-8 max-w-[620px]">
              <div class="text-[12px] md:text-[13px] text-accent mb-1.5 md:mb-2">最近添加</div>
              <h1 class="text-[19px] md:text-[30px] font-bold leading-tight mb-2 md:mb-3 cn-clamp-2">
                {{ v.title || v.file_name }}
              </h1>
              <div class="flex items-center gap-3 text-[12px] md:text-[13px] text-muted mb-4 md:mb-5">
                <span>{{ formatDuration(v.duration) }}</span>
                <span v-if="v.height">{{ v.height >= 2160 ? '4K' : v.height >= 1080 ? '1080P' : v.height + 'P' }}</span>
                <span v-if="v.video_codec">{{ v.video_codec.toUpperCase() }}</span>
              </div>
              <div class="flex items-center gap-2 md:gap-3">
                <button
                  class="h-9 md:h-10 px-4 md:px-5 rounded-lg bg-accent hover:bg-accenthover text-white text-[13px] md:text-sm font-medium flex items-center gap-2 transition-colors"
                  @click="goWatch(v.id)"
                >
                  <svg viewBox="0 0 24 24" class="w-4 h-4" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
                  立即播放
                </button>
                <button
                  class="h-9 md:h-10 px-4 md:px-5 rounded-lg bg-white/10 hover:bg-white/15 text-white text-[13px] md:text-sm transition-colors"
                  @click="goDetail(v.id)"
                >
                  查看详情
                </button>
              </div>
            </div>
          </div>

          <!-- 指示点 -->
          <div class="absolute bottom-4 right-4 md:bottom-5 md:right-6 z-20 flex items-center gap-2">
            <button
              v-for="(v, i) in heroItems"
              :key="v.id"
              class="h-1.5 rounded-full transition-all"
              :class="i === heroIndex ? 'w-6 bg-accent' : 'w-1.5 bg-white/40 hover:bg-white/70'"
              @click="heroIndex = i"
            ></button>
          </div>
        </section>

        <!-- 继续观看 -->
        <PosterRow
          v-if="continueList.length"
          title="继续观看"
          :videos="continueList"
          :card-width="240"
        />

        <!-- 最近添加 -->
        <section class="mb-6 md:mb-8">
          <div class="flex items-center justify-between mb-3">
            <h2 class="text-[15px] md:text-[17px] font-semibold">最近添加</h2>
            <router-link
              v-if="firstLibrary"
              :to="`/library/${firstLibrary.id}`"
              class="text-[13px] text-muted hover:text-accent transition-colors"
            >
              查看全部
            </router-link>
          </div>
          <VideoGrid :videos="recent" :loading="loading" />
        </section>

        <!-- 按媒体库分区 -->
        <PosterRow
          v-for="sec in sections"
          :key="sec.library.id"
          :title="sec.library.name"
          :videos="sec.videos"
          :more-path="`/library/${sec.library.id}`"
        />
      </template>
    </template>
  </div>
</template>
