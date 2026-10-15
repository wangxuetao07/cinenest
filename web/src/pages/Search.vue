<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { searchApi, type Video } from '@/api';
import VideoGrid from '@/components/VideoGrid.vue';

const route = useRoute();
const router = useRouter();

const keyword = ref('');
/** 标签条件：由播放页 / 结果卡片点标签跳转带过来，也可手动移除 */
const tag = ref('');

const results = ref<Video[]>([]);
const loading = ref(false);
const searched = ref(false);

let timer: number | null = null;

/** 关键词分隔符（半角空格 / 全角空格 / Tab / 换行），与服务端 splitKeywords 保持一致 */
const KW_SPLIT = /[\s\u3000]+/;
const MAX_KEYWORDS = 8;

/**
 * 把输入框内容拆成关键词数组。
 * 多个关键词之间是「或」的关系：任一关键词命中（标题 / 文件名 / 标签）即返回该视频。
 */
const keywords = computed(() => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of keyword.value.split(KW_SPLIT)) {
    const k = part.trim();
    if (!k) continue;
    const low = k.toLowerCase();
    if (seen.has(low)) continue;
    seen.add(low);
    out.push(k);
    if (out.length >= MAX_KEYWORDS) break;
  }
  return out;
});

const hasCondition = computed(() => keywords.value.length > 0 || !!tag.value.trim());

/** 本次结果里通过标签命中的数量 */
const tagHitCount = computed(
  () => results.value.filter((v) => (v.matched_tags || []).length > 0).length
);

async function run() {
  const q = keyword.value.trim();
  const t = tag.value.trim();
  if (!q && !t) {
    results.value = [];
    searched.value = false;
    return;
  }
  loading.value = true;
  try {
    const res = await searchApi.query({ q, tag: t });
    results.value = res.items;
    searched.value = true;
  } catch (_) {
    results.value = [];
  } finally {
    loading.value = false;
  }
}

/** 条件写回地址栏（便于分享 / 前进后退） */
function syncUrl() {
  const query: Record<string, string> = {};
  if (keyword.value.trim()) query.q = keyword.value.trim();
  if (tag.value.trim()) query.tag = tag.value.trim();
  router.replace({ name: 'search', query });
}

/** 输入防抖 300ms */
function onInput() {
  if (timer) window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    syncUrl();
    run();
  }, 300);
}

/** 移除某一个关键词（其余关键词保留，用空格重新拼回去） */
function removeKeyword(k: string) {
  keyword.value = keywords.value
    .filter((x) => x.toLowerCase() !== k.toLowerCase())
    .join(' ');
  syncUrl();
  run();
}

function clearKeyword() {
  keyword.value = '';
  syncUrl();
  run();
}

function clearTag() {
  tag.value = '';
  syncUrl();
  run();
}

function clearAll() {
  keyword.value = '';
  tag.value = '';
  syncUrl();
  run();
}

// URL 变化时同步（含从播放页 / 卡片点标签跳进来）
watch(
  () => [route.query.q, route.query.tag],
  ([q, t]) => {
    const k = String(q || '');
    const g = String(t || '');
    if (k !== keyword.value) keyword.value = k;
    if (g !== tag.value) tag.value = g;
    run();
  },
  { immediate: true }
);
</script>

<template>
  <div class="p-3 md:p-6 max-w-[1400px] mx-auto">
    <!-- 大搜索框 -->
    <div class="max-w-[720px] mx-auto mb-6 md:mb-8 mt-0 md:mt-4">
      <div class="relative">
        <svg
          viewBox="0 0 24 24"
          class="w-5 h-5 absolute left-4 top-1/2 -translate-y-1/2 text-muted"
          fill="currentColor"
        >
          <path d="M10 4a6 6 0 1 0 3.7 10.7l4.3 4.3 1.4-1.4-4.3-4.3A6 6 0 0 0 10 4zm0 2a4 4 0 1 1 0 8 4 4 0 0 1 0-8z" />
        </svg>
        <input
          v-model="keyword"
          type="text"
          placeholder="搜索标题、文件名或标签（空格分隔多个关键词）"
          autofocus
          class="w-full h-12 md:h-14 pl-12 pr-12 rounded-xl bg-[#1a1d24] border border-line text-[16px] text-[#e6e8ee] placeholder-[#6b7385] outline-none transition-colors focus:border-accent"
          @input="onInput"
        />
        <button
          v-if="keyword"
          class="absolute right-3 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full text-muted hover:text-white hover:bg-white/10 transition-colors flex items-center justify-center"
          title="清空关键词"
          @click="clearKeyword"
        >
          ✕
        </button>
      </div>

      <!-- 搜索条件 -->
      <div class="mt-3 flex items-center justify-center gap-2 flex-wrap text-[12px] min-h-[24px]">
        <span class="text-muted">搜索条件：</span>
        <template v-if="hasCondition">
          <n-tag
            v-for="k in keywords"
            :key="'kw-' + k"
            size="small"
            closable
            :bordered="false"
            @close="removeKeyword(k)"
          >
            关键词：{{ k }}
          </n-tag>
          <n-tag
            v-if="tag"
            size="small"
            closable
            type="primary"
            :bordered="false"
            @close="clearTag"
          >
            标签：{{ tag }}
          </n-tag>
          <button class="text-muted hover:text-white underline ml-1" @click="clearAll">全部清空</button>
        </template>
        <span v-else class="text-muted">无（输入关键词，或点击影片上的标签）</span>
      </div>
      <div class="text-[12px] text-muted mt-1 text-center">
        匹配范围：标题 · 文件名 · 标签
        <template v-if="keywords.length > 1">
          ｜ {{ keywords.length }} 个关键词之间为
          <span class="text-accent">「或」</span>
          关系，任一命中即显示
        </template>
        <template v-else> ｜ 多个关键词用空格分隔，任一命中即显示（或） </template>
      </div>
    </div>

    <!-- 结果 -->
    <div v-if="loading" class="flex justify-center py-20"><n-spin size="large" /></div>

    <template v-else>
      <div v-if="searched" class="text-[13px] text-muted mb-4">
        找到 <span class="text-accent">{{ results.length }}</span> 个结果
        <span v-if="keywords.length > 1 || tagHitCount">
          （
          <span v-if="keywords.length > 1">{{ keywords.length }} 个关键词，任一命中</span>
          <span v-if="keywords.length > 1 && tagHitCount"> · </span>
          <span v-if="tagHitCount">{{ tagHitCount }} 个由标签命中</span>
          ）
        </span>
      </div>
      <VideoGrid
        v-if="searched"
        :videos="results"
        show-tags
        empty-title="没有匹配的影片"
        empty-description="换个关键词试试，支持标题、文件名与标签的模糊匹配；多个关键词用空格分隔（任一命中即显示），也可以点击影片上的标签来筛选。"
      />
      <div v-else class="text-center py-24 text-muted text-[14px]">
        输入关键词开始搜索
      </div>
    </template>
  </div>
</template>
