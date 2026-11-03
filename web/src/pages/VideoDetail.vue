<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useMessage } from 'naive-ui';
import {
  videosApi,
  playlistsApi,
  formatDuration,
  formatSize,
  type Video,
  type Playlist,
} from '@/api';
import VideoGrid from '@/components/VideoGrid.vue';
import RenameVideoModal from '@/components/RenameVideoModal.vue';
import { useAuthStore } from '@/stores/auth';

const route = useRoute();
const router = useRouter();
const message = useMessage();
const auth = useAuthStore();

const video = ref<Video | null>(null);
const loading = ref(true);
const episodes = ref<Video[]>([]);
const playlists = ref<Playlist[]>([]);

const showPlaylistModal = ref(false);
const showRenameModal = ref(false);
const tagInput = ref<string[]>([]);
const savingTags = ref(false);

const videoId = computed(() => Number(route.params.id));

const resolution = computed(() => {
  const v = video.value;
  if (!v?.height) return '-';
  if (v.height >= 2160) return '4K (2160P)';
  if (v.height >= 1080) return '1080P';
  if (v.height >= 720) return '720P';
  if (v.height >= 480) return '480P';
  return `${v.width}x${v.height}`;
});

const dirOf = (p: string) => p.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
const stemOf = (name: string) => name.replace(/\.[^.]+$/, '');

/** 同目录同名剧集（文件改名后需要重算，故独立出来） */
async function loadEpisodes(v: Video) {
  const paged = await videosApi.list({ libraryId: v.library_id, size: 200 });
  const dir = dirOf(v.file_path);
  const stem = stemOf(v.file_name);
  const prefix = stem.replace(/[\s._-]*(s\d{1,2}e\d{1,3}|ep?\s?\d{1,3}|\d{1,3})$/i, '').trim();

  episodes.value = paged.items.filter((it) => {
    if (it.id === v.id) return false;
    if (dirOf(it.file_path) !== dir) return false;
    if (!prefix) return false;
    return stemOf(it.file_name).startsWith(prefix);
  });
}

async function load() {
  loading.value = true;
  try {
    const v = await videosApi.detail(videoId.value);
    video.value = v;
    tagInput.value = v.tags ? [...v.tags] : [];

    await loadEpisodes(v);
    playlists.value = await playlistsApi.list().catch(() => []);
  } catch (err: any) {
    message.error(err?.message || '加载失败');
  } finally {
    loading.value = false;
  }
}

/** 重命名完成后：就地更新，避免整页 loading 闪烁 */
function onRenamed(v: Video) {
  video.value = v;
  loadEpisodes(v).catch(() => { /* 剧集列表刷新失败不影响主信息 */ });
}

async function toggleFavorite() {
  if (!video.value) return;
  const next = video.value.favorite ? 0 : 1;
  try {
    await videosApi.update(video.value.id, { favorite: next });
    video.value.favorite = next;
    message.success(next ? '已加入收藏' : '已取消收藏');
  } catch (err: any) {
    message.error(err?.message || '操作失败');
  }
}

async function saveTags() {
  if (!video.value) return;
  savingTags.value = true;
  try {
    await videosApi.update(video.value.id, { tags: tagInput.value });
    message.success('标签已保存');
  } catch (err: any) {
    message.error(err?.message || '保存失败');
  } finally {
    savingTags.value = false;
  }
}

/** 点标签 → 按该标签搜索 */
function searchByTag(name: string) {
  router.push({ name: 'search', query: { tag: name } });
}

/** 返回上一个页面；直接打开 / 无历史时回首页 */
function goBack() {
  const back = window.history.state && window.history.state.back;
  if (back) router.back();
  else router.push('/');
}

async function addToPlaylist(pl: Playlist) {
  if (!video.value) return;
  try {
    await playlistsApi.addItem(pl.id, video.value.id);
    message.success(`已加入「${pl.name}」`);
    showPlaylistModal.value = false;
    playlists.value = await playlistsApi.list();
  } catch (err: any) {
    message.error(err?.message || '加入失败');
  }
}

onMounted(load);
</script>

<template>
  <div class="relative min-h-full">
    <div v-if="loading" class="flex justify-center py-24"><n-spin size="large" /></div>

    <template v-else-if="video">
      <!-- 模糊背景 -->
      <div class="absolute inset-0 overflow-hidden pointer-events-none -z-0">
        <img
          :src="video.poster_path"
          class="cn-detail-bg w-full object-cover opacity-25"
          style="filter: blur(48px); transform: scale(1.15)"
        />
        <div class="cn-detail-fade absolute inset-0"></div>
      </div>

      <div class="relative p-4 md:p-6 max-w-[1400px] mx-auto">
        <!-- 返回上一页（左上角） -->
        <div class="mb-3 md:mb-4">
          <button
            class="h-9 px-3 rounded-lg border border-line text-muted hover:text-white hover:border-white/30 flex items-center gap-1.5 text-[13px] transition-colors bg-black/20"
            @click="goBack"
          >
            <svg viewBox="0 0 24 24" class="w-4 h-4" fill="currentColor"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z" /></svg>
            返回
          </button>
        </div>

        <div class="flex gap-5 md:gap-8 flex-col lg:flex-row">
          <!-- 封面 -->
          <div class="w-full lg:w-[420px] shrink-0">
            <img
              :src="video.poster_path"
              class="w-full aspect-video object-cover rounded-xl bg-card"
              :alt="video.title || video.file_name"
            />
            <div class="flex flex-wrap gap-2 md:gap-3 mt-3 md:mt-4">
              <button
                class="flex-1 min-w-[120px] h-10 md:h-11 rounded-lg bg-accent hover:bg-accenthover text-white text-[13px] md:text-sm font-medium flex items-center justify-center gap-2 transition-colors"
                @click="router.push(`/watch/${video.id}`)"
              >
                <svg viewBox="0 0 24 24" class="w-4 h-4" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
                播放
              </button>
              <button
                class="h-10 md:h-11 px-4 rounded-lg border transition-colors flex items-center gap-2 text-[13px] md:text-sm"
                :class="video.favorite ? 'border-[#ff6b81] text-[#ff6b81]' : 'border-line text-muted hover:text-white hover:border-white/30'"
                @click="toggleFavorite"
              >
                <svg viewBox="0 0 24 24" class="w-4 h-4" fill="currentColor">
                  <path d="M12 21s-7.5-4.7-9.3-9A5.3 5.3 0 0 1 12 6.4 5.3 5.3 0 0 1 21.3 12c-1.8 4.3-9.3 9-9.3 9z" />
                </svg>
                {{ video.favorite ? '已收藏' : '收藏' }}
              </button>
              <button
                class="h-10 md:h-11 px-4 rounded-lg border border-line text-muted hover:text-white hover:border-white/30 transition-colors text-[13px] md:text-sm"
                @click="showPlaylistModal = true"
              >
                加入播放列表
              </button>
            </div>
          </div>

          <!-- 信息 -->
          <div class="flex-1 min-w-0">
            <div class="flex items-start gap-2 md:gap-3 flex-wrap mb-2">
              <h1 class="text-[19px] md:text-[26px] font-bold leading-tight">
                {{ video.title || video.file_name }}
              </h1>
              <!-- 重命名：仅管理员；改显示名并同步改磁盘文件名 -->
              <button
                v-if="auth.isAdmin"
                class="h-7 px-2.5 rounded-md border border-line text-muted hover:text-white hover:border-white/30 transition-colors text-[12px] flex items-center gap-1 shrink-0 mt-1"
                title="修改视频名，并同步重命名磁盘上的文件"
                @click="showRenameModal = true"
              >
                <svg viewBox="0 0 24 24" class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
                重命名
              </button>
            </div>

            <div class="flex items-center gap-3 text-[12.5px] md:text-[13px] text-muted mb-4 md:mb-6 flex-wrap">
              <span>{{ formatDuration(video.duration) }}</span>
              <span>·</span>
              <span>{{ resolution }}</span>
              <span>·</span>
              <span>{{ formatSize(video.size) }}</span>
              <span v-if="video.bitrate">·</span>
              <span v-if="video.bitrate">{{ Math.round(video.bitrate / 1000) }} kbps</span>
            </div>

            <dl class="grid grid-cols-1 md:grid-cols-[110px_1fr] gap-y-3 gap-x-4 text-[13px]">
              <dt class="text-muted">文件名</dt>
              <dd class="break-all">{{ video.file_name }}</dd>

              <dt class="text-muted">文件路径</dt>
              <dd class="break-all text-[#c3c9d6]">{{ video.file_path }}</dd>

              <dt class="text-muted">视频编码</dt>
              <dd>{{ video.video_codec || '-' }}</dd>

              <dt class="text-muted">音频编码</dt>
              <dd>{{ video.audio_codec || '-' }}</dd>

              <dt class="text-muted">分辨率</dt>
              <dd>{{ video.width }} × {{ video.height }}</dd>

              <dt class="text-muted">添加时间</dt>
              <dd>{{ video.added_at }}</dd>

              <dt class="text-muted">上次播放</dt>
              <dd>{{ video.last_played || '从未播放' }}</dd>
            </dl>

            <!-- 标签（全站共享元数据，仅管理员可改） -->
            <div v-if="auth.isAdmin" class="mt-6">
              <div class="text-[13px] text-muted mb-2">标签</div>
              <n-select
                v-model:value="tagInput"
                multiple
                filterable
                tag
                size="small"
                placeholder="输入后回车创建标签"
                style="max-width: 480px"
              />
              <n-button size="small" class="mt-2" :loading="savingTags" @click="saveTags">保存标签</n-button>
            </div>
            <div v-else class="mt-6">
              <div class="text-[13px] text-muted mb-2">标签（点击可按标签搜索）</div>
              <div class="text-[13px]">
                <template v-if="video.tags && video.tags.length">
                  <button
                    v-for="t in video.tags"
                    :key="t"
                    class="inline-block mr-2 mb-1 px-2 py-0.5 rounded bg-white/6 text-[#c3c9d6] hover:bg-accent/25 hover:text-accent transition-colors"
                    :title="`按标签搜索：${t}`"
                    @click="searchByTag(t)"
                  >{{ t }}</button>
                </template>
                <span v-else class="text-muted">暂无标签（标签由管理员维护）</span>
              </div>
            </div>

            <div class="mt-6">
              <n-tooltip trigger="hover">
                <template #trigger>
                  <n-button size="small" disabled>重新扫描单个文件</n-button>
                </template>
                v2 功能，暂未开放
              </n-tooltip>
            </div>
          </div>
        </div>

        <!-- 同名剧集 -->
        <section v-if="episodes.length" class="mt-8 md:mt-10">
          <h2 class="text-[15px] md:text-[17px] font-semibold mb-3">同名剧集 / 相关视频</h2>
          <VideoGrid :videos="episodes" :min-width="200" />
        </section>
      </div>
    </template>

    <!-- 重命名（仅管理员） -->
    <RenameVideoModal v-model:show="showRenameModal" :video="video" @updated="onRenamed" />

    <!-- 加入播放列表 -->
    <n-modal v-model:show="showPlaylistModal">
      <div class="w-[min(420px,92vw)] rounded-xl p-5" style="background: #1a1d24">
        <div class="text-[16px] font-semibold mb-4">加入播放列表</div>
        <div v-if="playlists.length" class="flex flex-col gap-2 max-h-[320px] overflow-y-auto cn-scroll">
          <button
            v-for="pl in playlists"
            :key="pl.id"
            class="h-10 px-4 rounded-lg bg-white/5 hover:bg-accent/20 text-left text-[14px] transition-colors flex items-center justify-between"
            @click="addToPlaylist(pl)"
          >
            <span class="truncate">{{ pl.name }}</span>
            <span class="text-[12px] text-muted shrink-0 ml-3">{{ pl.item_count || 0 }} 个</span>
          </button>
        </div>
        <div v-else class="text-[13px] text-muted py-6 text-center">
          还没有播放列表，去「播放列表」页新建一个吧。
        </div>
        <div class="flex justify-end mt-4">
          <n-button size="small" @click="showPlaylistModal = false">取消</n-button>
        </div>
      </div>
    </n-modal>
  </div>
</template>
