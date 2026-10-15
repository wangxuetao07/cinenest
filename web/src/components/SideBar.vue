<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { useAppStore } from '@/stores/app';
import { useAuthStore } from '@/stores/auth';

const props = withDefaults(
  defineProps<{
    collapsed: boolean;
    /** 移动端：以抽屉形式浮在内容之上 */
    mobile?: boolean;
    /** 移动端抽屉是否展开 */
    open?: boolean;
  }>(),
  { mobile: false, open: false }
);
const emit = defineEmits<{ (e: 'toggle'): void; (e: 'close'): void }>();

const store = useAppStore();
const auth = useAuthStore();
const route = useRoute();

onMounted(() => {
  store.loadLibraries().catch(() => void 0);
});

/**
 * 主菜单。
 * admin: true 的条目仅管理员可见（扫描任务 / 设置 / 用户管理）。
 */
const MENUS = [
  { name: 'home', path: '/', label: '首页', admin: false, d: 'M3 10.5 12 3l9 7.5V21a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z' },
  { name: 'history', path: '/history', label: '继续观看', admin: false, d: 'M12 3a9 9 0 1 0 9 9h-2a7 7 0 1 1-7-7v3l4-4-4-4zm-1 5v5l4 2 .8-1.3-3.3-1.7V8z' },
  { name: 'favorites', path: '/favorites', label: '收藏', admin: false, d: 'M12 21s-7.5-4.7-9.3-9A5.3 5.3 0 0 1 12 6.4 5.3 5.3 0 0 1 21.3 12c-1.8 4.3-9.3 9-9.3 9z' },
  { name: 'playlists', path: '/playlists', label: '播放列表', admin: false, d: 'M4 6h11v2H4zm0 5h11v2H4zm0 5h7v2H4zm12-10 5 3-5 3z' },
  { name: 'tasks', path: '/tasks', label: '扫描任务', admin: true, d: 'M12 2a10 10 0 1 0 10 10h-2a8 8 0 1 1-8-8v3l4-4-4-4zm-1 5v6l5 3 .8-1.6L13 12V7z' },
  { name: 'search', path: '/search', label: '搜索', admin: false, d: 'M10 4a6 6 0 1 0 3.7 10.7l4.3 4.3 1.4-1.4-4.3-4.3A6 6 0 0 0 10 4zm0 2a4 4 0 1 1 0 8 4 4 0 0 1 0-8z' },
  { name: 'settings', path: '/settings', label: '设置', admin: true, d: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm0 2a2 2 0 1 1 0 4 2 2 0 0 1 0-4zm-1-8h2l.4 2.6 2.1.9 2.2-1.4 1.4 1.4-1.4 2.2.9 2.1L21 10v2l-2.6.4-.9 2.1 1.4 2.2-1.4 1.4-2.2-1.4-2.1.9L13 21h-2l-.4-2.6-2.1-.9-2.2 1.4-1.4-1.4 1.4-2.2-.9-2.1L3 12v-2l2.6-.4.9-2.1L5.1 5.3 6.5 3.9l2.2 1.4 2.1-.9z' },
  { name: 'users', path: '/users', label: '用户管理', admin: true, d: 'M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zm0 2c-4.4 0-8 2.7-8 6v2h16v-2c0-3.3-3.6-6-8-6z' },
];

const menus = computed(() => MENUS.filter((m) => !m.admin || auth.isAdmin));

/**
 * 媒体库列表：普通用户看不到被管理员停用的库（库内视频同样已从所有列表隐藏）；
 * 管理员保留可见，方便回设置页重新启用。
 */
const libraries = computed(() =>
  auth.isAdmin ? store.libraries : store.libraries.filter((l) => !!l.enabled)
);

const isActive = (path: string) => {
  if (path === '/') return route.path === '/';
  return route.path.startsWith(path);
};

const libActive = (id: number) => route.path === `/library/${id}`;
</script>

<template>
  <aside
    class="h-full flex flex-col bg-[#14171e] border-r border-line shrink-0"
    :class="
      props.mobile
        ? 'fixed inset-y-0 left-0 z-50 w-[248px] shadow-2xl transition-transform duration-200'
        : 'relative transition-all duration-200'
    "
    :style="
      props.mobile
        ? { width: '248px', transform: props.open ? 'translateX(0)' : 'translateX(-100%)' }
        : { width: props.collapsed ? '64px' : '200px' }
    "
  >
    <!-- Logo -->
    <div class="h-16 flex items-center gap-2 px-4 border-b border-line shrink-0">
      <div
        class="w-8 h-8 rounded-lg bg-accent flex items-center justify-center font-bold text-white shrink-0"
      >
        影
      </div>
      <span v-if="props.mobile || !props.collapsed" class="text-[15px] font-semibold whitespace-nowrap">
        影巢 CineNest
      </span>
      <button
        v-if="props.mobile"
        class="ml-auto w-8 h-8 rounded-lg flex items-center justify-center text-muted hover:text-white hover:bg-white/10 transition-colors"
        aria-label="关闭菜单"
        @click="emit('close')"
      >
        <svg viewBox="0 0 24 24" class="w-5 h-5" fill="currentColor">
          <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" fill="none" />
        </svg>
      </button>
    </div>

    <!-- 菜单 -->
    <nav class="flex-1 overflow-y-auto cn-scroll py-3">
      <router-link
        v-for="m in menus"
        :key="m.name"
        :to="m.path"
        class="flex items-center gap-3 mx-2 px-3 h-11 lg:h-10 rounded-lg mb-1 text-sm transition-colors"
        :class="
          isActive(m.path)
            ? 'bg-accent/15 text-accent'
            : 'text-[#a8b0c0] hover:bg-white/5 hover:text-white'
        "
        :title="m.label"
      >
        <svg viewBox="0 0 24 24" class="w-5 h-5 shrink-0" fill="currentColor">
          <path :d="m.d" />
        </svg>
        <span v-if="props.mobile || !props.collapsed" class="whitespace-nowrap">{{ m.label }}</span>
      </router-link>

      <!-- 媒体库分组 -->
      <div
        v-if="props.mobile || !props.collapsed"
        class="px-5 mt-4 mb-2 text-xs text-muted tracking-wider"
      >
        媒体库
      </div>
      <div v-else class="mx-4 my-3 border-t border-line"></div>

      <router-link
        v-for="lib in libraries"
        :key="lib.id"
        :to="`/library/${lib.id}`"
        class="flex items-center gap-3 mx-2 px-3 h-10 lg:h-9 rounded-lg mb-0.5 text-[13px] transition-colors"
        :class="
          libActive(lib.id)
            ? 'bg-accent/15 text-accent'
            : 'text-[#8b93a7] hover:bg-white/5 hover:text-white'
        "
        :title="lib.name"
      >
        <svg viewBox="0 0 24 24" class="w-4 h-4 shrink-0" fill="currentColor">
          <path d="M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm2 3v8h12V8H6z" />
        </svg>
        <span v-if="props.mobile || !props.collapsed" class="truncate">{{ lib.name }}</span>
        <span
          v-if="(props.mobile || !props.collapsed) && !lib.enabled"
          class="ml-auto shrink-0 text-[10px] px-1 rounded bg-white/8 text-[#8b93a7]"
          title="已停用：库内视频不再出现在首页与列表中"
        >
          停用
        </span>
      </router-link>

      <div
        v-if="(props.mobile || !props.collapsed) && libraries.length === 0"
        class="px-5 py-2 text-xs text-muted"
      >
        暂无媒体库
      </div>
    </nav>

    <!-- 折叠按钮（仅桌面端） -->
    <button
      v-if="!props.mobile"
      class="h-11 flex items-center justify-center gap-2 border-t border-line text-muted hover:text-white hover:bg-white/5 transition-colors text-xs"
      @click="emit('toggle')"
    >
      <svg
        viewBox="0 0 24 24"
        class="w-4 h-4 transition-transform"
        :class="props.collapsed ? 'rotate-180' : ''"
        fill="currentColor"
      >
        <path d="M15.4 7.4 14 6l-6 6 6 6 1.4-1.4L10.8 12z" />
      </svg>
      <span v-if="!props.collapsed">收起</span>
    </button>

    <!-- 移动端安全区占位 -->
    <div v-if="props.mobile" class="h-[env(safe-area-inset-bottom)] shrink-0"></div>
  </aside>
</template>
