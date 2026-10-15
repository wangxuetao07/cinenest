<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useMessage, useDialog } from 'naive-ui';
import { playlistsApi, formatDuration, type Playlist, type Video } from '@/api';
import EmptyState from '@/components/EmptyState.vue';

const router = useRouter();
const message = useMessage();
const dialog = useDialog();

const playlists = ref<Playlist[]>([]);
const currentId = ref<number | null>(null);
const items = ref<Video[]>([]);
const loading = ref(true);
const itemsLoading = ref(false);

const newName = ref('');
const creating = ref(false);

async function loadPlaylists(keepCurrent = false) {
  loading.value = true;
  try {
    playlists.value = await playlistsApi.list();
    if (!keepCurrent || currentId.value === null) {
      currentId.value = playlists.value[0]?.id ?? null;
    }
    if (currentId.value) await loadItems();
    else items.value = [];
  } catch (err: any) {
    message.error(err?.message || '加载失败');
  } finally {
    loading.value = false;
  }
}

async function loadItems() {
  if (!currentId.value) {
    items.value = [];
    return;
  }
  itemsLoading.value = true;
  try {
    items.value = await playlistsApi.items(currentId.value);
  } catch (err: any) {
    message.error(err?.message || '加载列表项失败');
  } finally {
    itemsLoading.value = false;
  }
}

async function create() {
  const name = newName.value.trim();
  if (!name) return;
  creating.value = true;
  try {
    const { id } = await playlistsApi.create(name);
    newName.value = '';
    await loadPlaylists(true);
    currentId.value = id;
    await loadItems();
    message.success('已创建播放列表');
  } catch (err: any) {
    message.error(err?.message || '创建失败');
  } finally {
    creating.value = false;
  }
}

function selectPlaylist(id: number) {
  currentId.value = id;
  loadItems();
}

function removePlaylist(pl: Playlist) {
  dialog.warning({
    title: '删除播放列表',
    content: `确定删除「${pl.name}」吗？此操作不可撤销。`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        await playlistsApi.remove(pl.id);
        message.success('已删除');
        if (currentId.value === pl.id) currentId.value = null;
        await loadPlaylists(true);
      } catch (err: any) {
        message.error(err?.message || '删除失败');
      }
    },
  });
}

async function move(index: number, dir: -1 | 1) {
  const target = index + dir;
  if (target < 0 || target >= items.value.length || !currentId.value) return;

  const arr = [...items.value];
  [arr[index], arr[target]] = [arr[target], arr[index]];
  items.value = arr;

  try {
    // 重新分配顺序号
    await Promise.all(
      arr.map((v, i) => playlistsApi.setSort(currentId.value as number, v.id, i + 1))
    );
  } catch (err: any) {
    message.error(err?.message || '排序失败');
    await loadItems();
  }
}

async function removeItem(v: Video) {
  if (!currentId.value) return;
  try {
    await playlistsApi.removeItem(currentId.value, v.id);
    items.value = items.value.filter((it) => it.id !== v.id);
    playlists.value = await playlistsApi.list();
  } catch (err: any) {
    message.error(err?.message || '移除失败');
  }
}

onMounted(() => loadPlaylists());
</script>

<template>
  <div class="p-3 md:p-6 max-w-[1500px] mx-auto">
    <h1 class="text-[18px] md:text-[22px] font-semibold mb-4 md:mb-6">播放列表</h1>

    <div v-if="loading" class="flex justify-center py-24"><n-spin size="large" /></div>

    <div v-else class="flex gap-5 md:gap-6 flex-col lg:flex-row">
      <!-- 左：列表 -->
      <aside class="w-full lg:w-[280px] shrink-0">
        <div class="flex gap-2 mb-4">
          <input
            v-model="newName"
            type="text"
            placeholder="新建播放列表…"
            class="flex-1 h-10 md:h-9 px-3 rounded-lg bg-[#1e222b] border border-line text-[13px] outline-none focus:border-accent"
            @keyup.enter="create"
          />
          <n-button size="small" :loading="creating" @click="create">新建</n-button>
        </div>

        <div class="flex flex-col gap-1">
          <button
            v-for="pl in playlists"
            :key="pl.id"
            class="group h-11 px-3 rounded-lg flex items-center justify-between transition-colors text-left"
            :class="pl.id === currentId ? 'bg-accent/15 text-accent' : 'text-[#c3c9d6] hover:bg-white/5'"
            @click="selectPlaylist(pl.id)"
          >
            <span class="truncate text-[13.5px]">{{ pl.name }}</span>
            <span class="flex items-center gap-2 shrink-0 ml-2">
              <span class="text-[11px] text-muted">{{ pl.item_count || 0 }}</span>
              <svg
                viewBox="0 0 24 24"
                class="w-4 h-4 md:opacity-0 group-hover:opacity-100 text-muted hover:text-[#ff6b81] transition-opacity"
                fill="currentColor"
                @click.stop="removePlaylist(pl)"
              >
                <path d="M9 3h6l1 2h4v2H4V5h4zm-3 6h12l-1 12H7z" />
              </svg>
            </span>
          </button>

          <div v-if="playlists.length === 0" class="text-[13px] text-muted px-3 py-6 text-center">
            还没有播放列表
          </div>
        </div>
      </aside>

      <!-- 右：条目 -->
      <section class="flex-1 min-w-0">
        <div v-if="!currentId">
          <EmptyState
            title="选择或新建一个播放列表"
            description="播放列表可以把不同目录的影片自由编排在一起。"
          />
        </div>

        <div v-else-if="itemsLoading" class="flex justify-center py-20"><n-spin /></div>

        <div v-else-if="items.length" class="flex flex-col gap-2">
          <div
            v-for="(v, i) in items"
            :key="v.id"
            class="cn-card flex flex-wrap md:flex-nowrap items-center gap-2.5 md:gap-4 p-2.5"
          >
            <span class="w-5 md:w-6 text-center text-[13px] text-muted shrink-0">{{ i + 1 }}</span>
            <img
              :src="v.thumb_path"
              class="w-[96px] md:w-[120px] aspect-video object-cover rounded-md bg-[#0b0d11] shrink-0"
            />
            <div class="min-w-0 flex-1">
              <div class="text-[13.5px] md:text-[14px] truncate">{{ v.title || v.file_name }}</div>
              <div class="text-[12px] text-muted mt-1">{{ formatDuration(v.duration) }}</div>
            </div>
            <div class="flex w-full md:w-auto items-center justify-end gap-1 shrink-0">
              <button
                class="w-8 h-8 rounded-md bg-white/5 hover:bg-white/10 disabled:opacity-30 flex items-center justify-center"
                :disabled="i === 0"
                title="上移"
                @click="move(i, -1)"
              >
                <svg viewBox="0 0 24 24" class="w-4 h-4" fill="currentColor"><path d="M12 7l6 6-1.4 1.4L12 9.8l-4.6 4.6L6 13z" /></svg>
              </button>
              <button
                class="w-8 h-8 rounded-md bg-white/5 hover:bg-white/10 disabled:opacity-30 flex items-center justify-center"
                :disabled="i === items.length - 1"
                title="下移"
                @click="move(i, 1)"
              >
                <svg viewBox="0 0 24 24" class="w-4 h-4" fill="currentColor"><path d="M12 17l-6-6 1.4-1.4L12 14.2l4.6-4.6L18 11z" /></svg>
              </button>
              <button
                class="h-8 px-3 rounded-md bg-accent/90 hover:bg-accent text-white text-[12.5px] transition-colors"
                @click="router.push(`/watch/${v.id}`)"
              >
                播放
              </button>
              <button
                class="h-8 px-3 rounded-md border border-line text-muted hover:text-[#ff6b81] hover:border-[#ff6b81]/50 text-[12.5px] transition-colors"
                @click="removeItem(v)"
              >
                移除
              </button>
            </div>
          </div>
        </div>

        <EmptyState
          v-else
          title="这个列表还是空的"
          description="打开任意影片详情页，点击「加入播放列表」即可添加。"
          action-text="去首页找影片"
          @action="router.push('/')"
        />
      </section>
    </div>
  </div>
</template>
