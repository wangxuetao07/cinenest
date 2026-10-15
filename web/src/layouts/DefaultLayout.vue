<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { NModal, useMessage } from 'naive-ui';
import SideBar from '@/components/SideBar.vue';
import { useAppStore } from '@/stores/app';
import { useAuthStore } from '@/stores/auth';
import { authApi } from '@/api';

const store = useAppStore();
const auth = useAuthStore();
const router = useRouter();
const route = useRoute();
const message = useMessage();

const keyword = ref('');
const searchFocused = ref(false);

/* ---------------- 响应式：移动端抽屉式导航 ---------------- */

const MOBILE_QUERY = '(max-width: 1023px)';
const isMobile = ref(false);
const mobileMenuOpen = ref(false);
let mq: MediaQueryList | null = null;

function syncMedia(e: MediaQueryList | MediaQueryListEvent) {
  isMobile.value = e.matches;
  if (!e.matches) mobileMenuOpen.value = false; // 回到桌面端时收起抽屉
}

function toggleSidebar() {
  if (isMobile.value) mobileMenuOpen.value = !mobileMenuOpen.value;
  else store.toggleSidebar();
}

/** 手机上搜索框位置有限，用短占位文案 */
const searchPlaceholder = computed(() =>
  isMobile.value ? '搜索影片…' : '搜索标题、文件名或标签（空格分隔多个关键词）'
);

// 切换路由后自动收起抽屉
watch(
  () => route.fullPath,
  () => {
    mobileMenuOpen.value = false;
  }
);

onMounted(() => {
  store.loadLibraries().catch(() => void 0);
  store.loadSettings().catch(() => void 0);

  mq = window.matchMedia(MOBILE_QUERY);
  syncMedia(mq);
  mq.addEventListener('change', syncMedia);
});

onBeforeUnmount(() => {
  mq?.removeEventListener('change', syncMedia);
});

// 路由变化时同步搜索框
watch(
  () => route.query.q,
  (q) => {
    if (route.name === 'search') keyword.value = String(q || '');
  },
  { immediate: true }
);

function submitSearch() {
  const q = keyword.value.trim();
  const query: Record<string, string> = {};
  if (q) query.q = q;
  // 已在按标签搜索时，保留标签条件（搜索页顶部的条件条可移除）
  if (route.name === 'search' && route.query.tag) query.tag = String(route.query.tag);
  router.push({ name: 'search', query });
}

/* ---------------- 用户菜单 ---------------- */

const roleLabel = computed(() => (auth.isAdmin ? '管理员' : '普通用户'));

const userMenu = computed(() => [
  { label: '修改密码', key: 'password' },
  { type: 'divider', key: 'd1' },
  { label: '退出登录', key: 'logout' },
]);

function onUserSelect(key: string) {
  if (key === 'password') openPassword();
  if (key === 'logout') doLogout();
}

async function doLogout() {
  await auth.logout();
  // 整页跳转，顺带清空其它 store 缓存
  window.location.href = '/login';
}

/* ---------------- 修改密码 ---------------- */

const pwdVisible = ref(false);
const oldPwd = ref('');
const newPwd = ref('');
const confirmPwd = ref('');
const pwdLoading = ref(false);
const pwdError = ref('');

function openPassword() {
  oldPwd.value = '';
  newPwd.value = '';
  confirmPwd.value = '';
  pwdError.value = '';
  pwdVisible.value = true;
}

async function submitPassword() {
  pwdError.value = '';
  if (!oldPwd.value) return (pwdError.value = '请输入原密码');
  if (newPwd.value.length < 6) return (pwdError.value = '新密码至少 6 位');
  if (newPwd.value !== confirmPwd.value) return (pwdError.value = '两次输入的新密码不一致');

  pwdLoading.value = true;
  try {
    await authApi.changePassword(oldPwd.value, newPwd.value);
    pwdVisible.value = false;
    message.success('密码已修改，请重新登录');
    setTimeout(() => {
      window.location.href = '/login';
    }, 800);
  } catch (err: any) {
    pwdError.value = err?.message || '修改失败';
  } finally {
    pwdLoading.value = false;
  }
}

</script>

<template>
  <div class="cn-app-shell flex overflow-hidden bg-bg">
    <!-- 移动端遮罩 -->
    <transition name="cn-drawer-mask">
      <div
        v-if="isMobile && mobileMenuOpen"
        class="fixed inset-0 z-40 bg-black/60"
        @click="mobileMenuOpen = false"
      ></div>
    </transition>

    <!-- 左侧导航（桌面端固定，移动端抽屉） -->
    <SideBar
      :collapsed="isMobile ? false : store.sidebarCollapsed"
      :mobile="isMobile"
      :open="mobileMenuOpen"
      @toggle="toggleSidebar"
      @close="mobileMenuOpen = false"
    />

    <!-- 右侧内容 -->
    <div class="flex-1 flex flex-col min-w-0">
      <!-- 顶栏 -->
      <header
        class="h-14 md:h-16 shrink-0 flex items-center gap-2 md:gap-4 px-3 md:px-6 border-b border-line"
        style="background: #14171e"
      >
        <!-- 移动端：打开菜单 -->
        <button
          v-if="isMobile"
          class="w-9 h-9 shrink-0 rounded-lg flex items-center justify-center text-[#c8cfdd] hover:bg-white/5 transition-colors"
          aria-label="打开菜单"
          @click="mobileMenuOpen = true"
        >
          <svg viewBox="0 0 24 24" class="w-5 h-5" fill="currentColor">
            <path d="M4 6h16v2H4zm0 5h16v2H4zm0 5h16v2H4z" />
          </svg>
        </button>

        <div
          class="relative flex-1 min-w-0"
          :style="isMobile ? undefined : { width: '380px', maxWidth: '45vw', flex: 'none' }"
        >
          <svg
            viewBox="0 0 24 24"
            class="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
            :class="searchFocused ? 'text-accent' : 'text-muted'"
            fill="currentColor"
          >
            <path
              d="M10 4a6 6 0 1 0 3.7 10.7l4.3 4.3 1.4-1.4-4.3-4.3A6 6 0 0 0 10 4zm0 2a4 4 0 1 1 0 8 4 4 0 0 1 0-8z"
            />
          </svg>
          <input
            v-model="keyword"
            type="text"
            :placeholder="searchPlaceholder"
            class="w-full h-10 pl-9 pr-3 rounded-lg bg-[#1e222b] border border-line text-sm text-[#e6e8ee] placeholder-[#6b7385] outline-none transition-colors focus:border-accent"
            @focus="searchFocused = true"
            @blur="searchFocused = false"
            @keyup.enter="submitSearch"
          />
        </div>

        <div class="ml-auto flex items-center gap-1.5 md:gap-2 shrink-0">
          <!-- 管理员快捷入口：扫描任务 / 设置 -->
          <template v-if="auth.isAdmin">
            <router-link
              to="/tasks"
              class="w-9 h-9 rounded-lg flex items-center justify-center text-muted hover:text-white hover:bg-white/5 transition-colors"
              title="扫描任务"
            >
              <svg viewBox="0 0 24 24" class="w-5 h-5" fill="currentColor">
                <path d="M12 2a10 10 0 1 0 10 10h-2a8 8 0 1 1-8-8v3l4-4-4-4zm-1 5v6l5 3 .8-1.6L13 12V7z" />
              </svg>
            </router-link>
            <router-link
              to="/settings"
              class="w-9 h-9 rounded-lg flex items-center justify-center text-muted hover:text-white hover:bg-white/5 transition-colors"
              title="设置"
            >
              <svg viewBox="0 0 24 24" class="w-5 h-5" fill="currentColor">
                <path
                  d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm0 2a2 2 0 1 1 0 4 2 2 0 0 1 0-4zm-1-8h2l.4 2.6 2.1.9 2.2-1.4 1.4 1.4-1.4 2.2.9 2.1L21 10v2l-2.6.4-.9 2.1 1.4 2.2-1.4 1.4-2.2-1.4-2.1.9L13 21h-2l-.4-2.6-2.1-.9-2.2 1.4-1.4-1.4 1.4-2.2-.9-2.1L3 12v-2l2.6-.4.9-2.1L5.1 5.3 6.5 3.9l2.2 1.4 2.1-.9z"
                />
              </svg>
            </router-link>
          </template>

          <!-- 用户区 -->
          <n-dropdown trigger="click" :options="userMenu" @select="onUserSelect">
            <button
              class="h-9 pl-1.5 pr-1.5 md:pr-3 rounded-lg flex items-center gap-2 hover:bg-white/5 transition-colors"
              title="账号"
            >
              <span
                class="w-6 h-6 rounded-full bg-accent text-white text-xs font-semibold flex items-center justify-center shrink-0"
              >
                {{ auth.initial }}
              </span>
              <span class="hidden md:inline text-[13px] text-[#c8cfdd] max-w-[120px] truncate">
                {{ auth.displayName }}
              </span>
              <span
                class="hidden md:inline text-[11px] px-1.5 py-0.5 rounded"
                :class="
                  auth.isAdmin
                    ? 'bg-accent/20 text-accent'
                    : 'bg-white/10 text-[#8b93a7]'
                "
              >
                {{ roleLabel }}
              </span>
            </button>
          </n-dropdown>
        </div>
      </header>

      <!-- 主内容 -->
      <main class="flex-1 overflow-y-auto cn-scroll">
        <router-view />
      </main>
    </div>

    <!-- 修改密码 -->
    <n-modal
      v-model:show="pwdVisible"
      preset="card"
      title="修改密码"
      style="width: min(420px, 92vw)"
      :bordered="false"
    >
      <div class="text-sm">
        <label class="block text-xs text-muted mb-1.5">原密码</label>
        <input
          v-model="oldPwd"
          type="password"
          autocomplete="current-password"
          class="w-full h-11 md:h-10 px-3 rounded-lg bg-[#1e222b] border border-line text-sm outline-none focus:border-accent"
        />

        <label class="block text-xs text-muted mb-1.5 mt-4">新密码（至少 6 位）</label>
        <input
          v-model="newPwd"
          type="password"
          autocomplete="new-password"
          class="w-full h-11 md:h-10 px-3 rounded-lg bg-[#1e222b] border border-line text-sm outline-none focus:border-accent"
        />

        <label class="block text-xs text-muted mb-1.5 mt-4">确认新密码</label>
        <input
          v-model="confirmPwd"
          type="password"
          autocomplete="new-password"
          class="w-full h-11 md:h-10 px-3 rounded-lg bg-[#1e222b] border border-line text-sm outline-none focus:border-accent"
          @keyup.enter="submitPassword"
        />

        <div
          v-if="pwdError"
          class="mt-3 px-3 py-2 rounded-lg text-[13px] text-[#ff8a8a]"
          style="background: rgba(255, 77, 79, 0.12); border: 1px solid rgba(255, 77, 79, 0.3)"
        >
          {{ pwdError }}
        </div>
      </div>

      <template #footer>
        <div class="flex justify-end gap-2">
          <button
            class="h-9 px-4 rounded-lg border border-line text-sm text-[#c8cfdd] hover:bg-white/5"
            @click="pwdVisible = false"
          >
            取消
          </button>
          <button
            class="h-9 px-4 rounded-lg bg-accent text-white text-sm hover:bg-[#3d7bf0] disabled:opacity-60"
            :disabled="pwdLoading"
            @click="submitPassword"
          >
            {{ pwdLoading ? '提交中…' : '确定' }}
          </button>
        </div>
      </template>
    </n-modal>
  </div>
</template>
