<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();

const username = ref('');
const password = ref('');
const error = ref('');
const loading = ref(false);

const inputRef = ref<HTMLInputElement | null>(null);

onMounted(() => {
  inputRef.value?.focus();
});

async function submit() {
  error.value = '';
  const u = username.value.trim();
  if (!u || !password.value) {
    error.value = '请输入用户名和密码';
    return;
  }

  loading.value = true;
  try {
    await auth.login(u, password.value);
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/';
    router.replace(redirect);
  } catch (err: any) {
    error.value = err?.message || '登录失败';
    password.value = '';
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="cn-min-shell flex items-center justify-center bg-bg relative overflow-hidden py-8">
    <!-- 背景光晕 -->
    <div
      class="absolute rounded-full pointer-events-none"
      style="width: min(720px, 120vw); height: min(720px, 120vw); top: -280px; left: -160px; background: radial-gradient(circle, rgba(79,140,255,0.16), transparent 68%)"
    />
    <div
      class="absolute rounded-full pointer-events-none"
      style="width: min(620px, 110vw); height: min(620px, 110vw); bottom: -240px; right: -140px; background: radial-gradient(circle, rgba(79,140,255,0.10), transparent 70%)"
    />

    <div class="relative w-full" style="max-width: 400px; padding: 0 20px">
      <!-- 品牌 -->
      <div class="flex flex-col items-center mb-6 md:mb-7">
        <div class="w-14 h-14 rounded-2xl bg-accent flex items-center justify-center text-2xl font-bold text-white">
          影
        </div>
        <h1 class="mt-4 text-xl font-semibold tracking-wide">影巢 CineNest</h1>
        <p class="mt-1 text-[13px] text-muted">把你的硬盘变成私人影院</p>
      </div>

      <!-- 表单 -->
      <form
        class="rounded-2xl border border-line p-5 md:p-6"
        style="background: #14171e"
        @submit.prevent="submit"
      >
        <div class="text-sm font-medium mb-4">账号登录</div>

        <label class="block text-xs text-muted mb-1.5">用户名</label>
        <input
          ref="inputRef"
          v-model="username"
          type="text"
          autocomplete="username"
          placeholder="请输入用户名"
          class="w-full h-11 md:h-10 px-3 rounded-lg bg-[#1e222b] border border-line text-sm text-[#e6e8ee] placeholder-[#6b7385] outline-none transition-colors focus:border-accent"
        />

        <label class="block text-xs text-muted mb-1.5 mt-4">密码</label>
        <input
          v-model="password"
          type="password"
          autocomplete="current-password"
          placeholder="请输入密码"
          class="w-full h-11 md:h-10 px-3 rounded-lg bg-[#1e222b] border border-line text-sm text-[#e6e8ee] placeholder-[#6b7385] outline-none transition-colors focus:border-accent"
        />

        <div
          v-if="error"
          class="mt-4 px-3 py-2 rounded-lg text-[13px] text-[#ff8a8a]"
          style="background: rgba(255, 77, 79, 0.12); border: 1px solid rgba(255, 77, 79, 0.3)"
        >
          {{ error }}
        </div>

        <button
          type="submit"
          :disabled="loading"
          class="mt-5 w-full h-11 md:h-10 rounded-lg bg-accent text-white text-sm font-medium transition-colors hover:bg-[#3d7bf0] disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {{ loading ? '登录中…' : '登 录' }}
        </button>

        <p class="mt-4 text-xs text-muted leading-relaxed">
          首次使用请用默认管理员账号
          <code class="text-[#a8b0c0]">admin / admin123</code>
          登录，随后请在右上角头像菜单中修改密码。
        </p>
      </form>
    </div>
  </div>
</template>
