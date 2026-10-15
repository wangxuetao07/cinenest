<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useMessage } from 'naive-ui';
import { videosApi, formatDuration, formatSize, type Video } from '@/api';
import { useAppStore } from '@/stores/app';
import { useAuthStore } from '@/stores/auth';
import Player from '@/components/Player.vue';

const route = useRoute();
const router = useRouter();
const message = useMessage();
const store = useAppStore();
const auth = useAuthStore();

const video = ref<Video | null>(null);
const siblings = ref<Video[]>([]);
const loading = ref(true);

/* ---------------- 标签 ---------------- */

const editingTags = ref(false);
const tagInput = ref<string[]>([]);
const savingTags = ref(false);

/** 点标签 → 按该标签搜索 */
function searchByTag(name: string) {
  router.push({ name: 'search', query: { tag: name } });
}

function startEditTags() {
  tagInput.value = video.value?.tags ? [...video.value.tags] : [];
  editingTags.value = true;
}

function cancelEditTags() {
  editingTags.value = false;
}

/** 保存标签（仅管理员，服务端同样限制） */
async function saveTags() {
  if (!video.value) return;
  const v = video.value;
  savingTags.value = true;
  try {
    const names = Array.from(
      new Set(tagInput.value.map((t) => String(t || '').trim()).filter(Boolean))
    );
    await videosApi.update(v.id, { tags: names });
    v.tags = names;
    editingTags.value = false;
    message.success('标签已保存');
  } catch (err: any) {
    message.error(err?.message || '保存失败');
  } finally {
    savingTags.value = false;
  }
}

const videoId = computed(() => Number(route.params.id));

const currentIndex = computed(() =>
  siblings.value.findIndex((v) => v.id === videoId.value)
);
const nextVideo = computed(() => {
  const i = currentIndex.value;
  if (i < 0 || i + 1 >= siblings.value.length) return null;
  return siblings.value[i + 1];
});

const dirOf = (p: string) => p.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
const stemOf = (name: string) => name.replace(/\.[^.]+$/, '');

async function load() {
  loading.value = true;
  editingTags.value = false;
  try {
    const v = await videosApi.detail(videoId.value);
    video.value = v;

    // 当前目录同类视频
    const paged = await videosApi.list({ libraryId: v.library_id, size: 200 });
    const dir = dirOf(v.file_path);
    const stem = stemOf(v.file_name);
    const prefix = stem.replace(/[\s._-]*(s\d{1,2}e\d{1,3}|ep?\s?\d{1,3}|\d{1,3})$/i, '').trim();

    const sameDir = paged.items.filter((it) => dirOf(it.file_path) === dir);
    const related = prefix
      ? sameDir.filter((it) => stemOf(it.file_name).startsWith(prefix) || it.id === v.id)
      : sameDir;

    const list = (related.length > 1 ? related : sameDir).slice();
    // 按文件名自然排序
    list.sort((a, b) => a.file_name.localeCompare(b.file_name, 'zh-CN', { numeric: true }));
    siblings.value = list;
  } catch (err: any) {
    message.error(err?.message || '加载失败');
  } finally {
    loading.value = false;
  }
}

function goNext() {
  if (nextVideo.value) router.push(`/watch/${nextVideo.value.id}`);
  else message.info('已经是同目录最后一个视频');
}

function onEnded() {
  if (nextVideo.value) {
    message.info(`即将播放：${nextVideo.value.title || nextVideo.value.file_name}`);
    setTimeout(() => goNext(), 800);
  }
}

watch(videoId, load);
onMounted(load);
</script>

<template>
  <div v-if="loading" class="flex justify-center py-24"><n-spin size="large" /></div>

  <div v-else-if="video" class="p-3 md:p-6 max-w-[1700px] mx-auto">
    <div class="flex gap-4 md:gap-5 flex-col xl:flex-row">
      <!-- 播放区 70% -->
      <div class="xl:w-[70%] min-w-0">
        <Player
          :key="video.id"
          :video="video"
          :next-id="nextVideo ? nextVideo.id : null"
          :autoplay="store.autoplay"
          :volume="store.defaultVolume"
          :remember-progress="store.rememberProgress"
          @ended="onEnded"
          @next="goNext"
        />

        <!-- 标题与元数据 -->
        <div class="mt-4 md:mt-5">
          <h1 class="text-[17px] md:text-[22px] font-semibold leading-snug mb-2">
            {{ video.title || video.file_name }}
          </h1>
          <div class="flex items-center gap-3 text-[12.5px] md:text-[13px] text-muted flex-wrap mb-3 md:mb-4">
            <span>{{ formatDuration(video.duration) }}</span>
            <span>·</span>
            <span>{{ video.width }}×{{ video.height }}</span>
            <span>·</span>
            <span>{{ formatSize(video.size) }}</span>
            <span v-if="video.video_codec">·</span>
            <span v-if="video.video_codec">{{ video.video_codec.toUpperCase() }}</span>
            <span v-if="video.audio_codec">/ {{ video.audio_codec.toUpperCase() }}</span>
          </div>

          <div class="flex flex-wrap items-center gap-2 mb-4">
            <n-button size="small" @click="router.push(`/video/${video.id}`)">详情</n-button>
            <n-button size="small" :disabled="!nextVideo" @click="goNext">播放下一个</n-button>
            <n-button
              v-if="video.favorite"
              size="small"
              type="primary"
              ghost
              @click="videosApi.update(video.id, { favorite: 0 }).then(() => (video!.favorite = 0))"
            >
              取消收藏
            </n-button>
            <n-button
              v-else
              size="small"
              @click="videosApi.update(video.id, { favorite: 1 }).then(() => (video!.favorite = 1))"
            >
              收藏
            </n-button>
          </div>

          <div class="text-[12.5px] md:text-[13px] leading-relaxed text-[#a8b0c0] break-all border-t border-line pt-4">
            <div><span class="text-muted">文件：</span>{{ video.file_path }}</div>
            <div class="mt-1"><span class="text-muted">添加时间：</span>{{ video.added_at }}</div>

            <!-- 标签：点击按标签搜索；管理员可在此编辑 -->
            <div class="mt-2 flex items-start gap-2 flex-wrap">
              <span class="text-muted leading-[22px] shrink-0">标签：</span>

              <template v-if="!editingTags">
                <button
                  v-for="t in video.tags || []"
                  :key="t"
                  class="px-2 py-[1px] rounded bg-white/8 text-[12px] leading-[20px] text-[#c3c9d6] hover:bg-accent/25 hover:text-accent transition-colors"
                  :title="`按标签搜索：${t}`"
                  @click="searchByTag(t)"
                >
                  {{ t }}
                </button>
                <span v-if="!(video.tags && video.tags.length)" class="text-muted leading-[22px]">暂无标签</span>
                <button
                  v-if="auth.isAdmin"
                  class="text-[12px] leading-[22px] text-accent hover:underline"
                  @click="startEditTags"
                >
                  {{ video.tags && video.tags.length ? '编辑' : '+ 添加标签' }}
                </button>
              </template>

              <template v-else>
                <div class="w-full sm:w-[320px] max-w-full">
                  <n-select
                    v-model:value="tagInput"
                    multiple
                    filterable
                    tag
                    size="small"
                    placeholder="输入后回车创建标签"
                  />
                </div>
                <n-button size="tiny" type="primary" :loading="savingTags" @click="saveTags">保存</n-button>
                <n-button size="tiny" @click="cancelEditTags">取消</n-button>
                <span class="text-[12px] text-muted leading-[22px]">回车确认标签，点标签上的 ✕ 可删除</span>
              </template>
            </div>
          </div>
        </div>
      </div>

      <!-- 右侧同类列表 -->
      <aside class="xl:w-[30%] shrink-0">
        <div class="flex items-center justify-between mb-3">
          <h2 class="text-[15px] font-semibold">同目录视频</h2>
          <span class="text-[12px] text-muted">{{ siblings.length }} 个</span>
        </div>

        <div v-if="siblings.length" class="flex flex-col gap-2 xl:max-h-[calc(100vh-200px)] xl:overflow-y-auto cn-scroll pr-1">
          <div
            v-for="(s, i) in siblings"
            :key="s.id"
            class="flex gap-3 p-2 rounded-lg cursor-pointer transition-colors"
            :class="s.id === videoId ? 'bg-accent/15' : 'hover:bg-white/5'"
            @click="router.push(`/watch/${s.id}`)"
          >
            <div class="relative w-[104px] md:w-[120px] shrink-0">
              <img :src="s.thumb_path" class="w-full aspect-video object-cover rounded-md bg-[#0b0d11]" />
              <div class="absolute bottom-1 right-1 px-1 rounded bg-black/75 text-[10px] text-white">
                {{ formatDuration(s.duration) }}
              </div>
            </div>
            <div class="min-w-0 flex-1 py-0.5">
              <div
                class="text-[12.5px] leading-snug cn-clamp-2"
                :class="s.id === videoId ? 'text-accent' : ''"
              >
                {{ s.title || s.file_name }}
              </div>
              <div class="text-[11px] text-muted mt-1 truncate">#{{ i + 1 }} · {{ s.height ? s.height + 'P' : '' }}</div>
            </div>
          </div>
        </div>

        <div v-else class="text-[13px] text-muted py-10 text-center">目录下暂无其他视频</div>
      </aside>
    </div>
  </div>
</template>
