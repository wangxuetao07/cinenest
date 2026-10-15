import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import DefaultLayout from '@/layouts/DefaultLayout.vue';
import { useAuthStore } from '@/stores/auth';

/**
 * 路由。
 * meta.public  → 无需登录（登录页）
 * meta.admin   → 仅管理员可访问（扫描任务 / 设置 / 用户管理）
 */
const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'login',
    component: () => import('@/pages/Login.vue'),
    meta: { title: '登录', public: true },
  },
  {
    path: '/',
    component: DefaultLayout,
    children: [
      { path: '', name: 'home', component: () => import('@/pages/Home.vue'), meta: { title: '首页' } },
      {
        path: 'library/:id',
        name: 'library',
        component: () => import('@/pages/Library.vue'),
        meta: { title: '媒体库' },
      },
      {
        path: 'video/:id',
        name: 'video',
        component: () => import('@/pages/VideoDetail.vue'),
        meta: { title: '视频详情' },
      },
      {
        path: 'watch/:id',
        name: 'watch',
        component: () => import('@/pages/Watch.vue'),
        meta: { title: '播放' },
      },
      { path: 'search', name: 'search', component: () => import('@/pages/Search.vue'), meta: { title: '搜索' } },
      { path: 'history', name: 'history', component: () => import('@/pages/History.vue'), meta: { title: '继续观看' } },
      {
        path: 'favorites',
        name: 'favorites',
        component: () => import('@/pages/Favorites.vue'),
        meta: { title: '收藏' },
      },
      {
        path: 'playlists',
        name: 'playlists',
        component: () => import('@/pages/Playlists.vue'),
        meta: { title: '播放列表' },
      },
      {
        path: 'tasks',
        name: 'tasks',
        component: () => import('@/pages/Tasks.vue'),
        meta: { title: '扫描任务', admin: true },
      },
      {
        path: 'settings',
        name: 'settings',
        component: () => import('@/pages/Settings.vue'),
        meta: { title: '设置', admin: true },
      },
      {
        path: 'users',
        name: 'users',
        component: () => import('@/pages/Users.vue'),
        meta: { title: '用户管理', admin: true },
      },
    ],
  },
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior() {
    return { top: 0 };
  },
});

router.beforeEach(async (to) => {
  const auth = useAuthStore();

  // 登录页
  if (to.meta.public) {
    await auth.load();
    if (auth.isLoggedIn) return { name: 'home' };
    return true;
  }

  // 其余页面一律需要身份
  await auth.load();
  if (!auth.isLoggedIn) {
    return { name: 'login', query: to.fullPath === '/' ? {} : { redirect: to.fullPath } };
  }

  // 管理员专属页
  if (to.meta.admin && !auth.isAdmin) {
    return { name: 'home' };
  }

  return true;
});

router.afterEach((to) => {
  const title = (to.meta?.title as string) || '';
  document.title = title ? `${title} · 影巢 CineNest` : '影巢 CineNest';
});

export default router;
