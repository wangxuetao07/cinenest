import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { authApi, type AuthUser } from '@/api';

/**
 * 登录状态。
 * 会话本身由后端 HttpOnly Cookie 承载，这里只缓存"当前是谁"，用于：
 * - 路由守卫（是否登录 / 是否管理员）
 * - 菜单与页面的权限显隐
 */
export const useAuthStore = defineStore('auth', () => {
  const user = ref<AuthUser | null>(null);
  const loaded = ref(false); // 是否已向后端确认过身份
  const loading = ref(false);

  const isLoggedIn = computed(() => !!user.value);
  const isAdmin = computed(() => user.value?.role === 'admin');
  const displayName = computed(() => user.value?.display_name || user.value?.username || '');
  /** 头像用的首字 */
  const initial = computed(() => {
    const n = displayName.value.trim();
    return n ? n.slice(0, 1).toUpperCase() : '?';
  });

  /** 拉取当前身份（缓存，force 强制刷新） */
  async function load(force = false): Promise<AuthUser | null> {
    if (loaded.value && !force) return user.value;
    loading.value = true;
    try {
      const data = await authApi.me();
      user.value = data.user || null;
    } catch (_) {
      user.value = null;
    } finally {
      loaded.value = true;
      loading.value = false;
    }
    return user.value;
  }

  async function login(username: string, password: string): Promise<AuthUser> {
    const data = await authApi.login(username, password);
    user.value = data.user;
    loaded.value = true;
    return data.user;
  }

  async function logout() {
    try {
      await authApi.logout();
    } catch (_) {
      /* 网络异常也照常清理本地状态 */
    }
    user.value = null;
    loaded.value = true;
  }

  /** 本地清空（401 被动登出时用） */
  function clear() {
    user.value = null;
    loaded.value = true;
  }

  return {
    user,
    loaded,
    loading,
    isLoggedIn,
    isAdmin,
    displayName,
    initial,
    load,
    login,
    logout,
    clear,
  };
});
