<script setup lang="ts">
import { computed, h, onMounted, ref } from 'vue';
import {
  NButton,
  NPopconfirm,
  NSwitch,
  NTag,
  useMessage,
  type DataTableColumns,
} from 'naive-ui';
import { usersApi, type AuthUser, type Role } from '@/api';
import { useAuthStore } from '@/stores/auth';

const message = useMessage();
const auth = useAuthStore();

const users = ref<AuthUser[]>([]);
const loading = ref(true);

const isSelf = (row: AuthUser) => row.id === auth.user?.id;

/* ------------------------------------------------------------------ *
 * 列表
 * ------------------------------------------------------------------ */

async function loadUsers() {
  loading.value = true;
  try {
    users.value = await usersApi.list();
  } catch (err: any) {
    message.error(err?.message || '加载用户失败');
  } finally {
    loading.value = false;
  }
}

async function toggleEnabled(row: AuthUser, value: boolean) {
  try {
    await usersApi.update(row.id, { enabled: value });
    row.enabled = value ? 1 : 0;
    message.success(value ? `已启用「${row.username}」` : `已禁用「${row.username}」`);
  } catch (err: any) {
    message.error(err?.message || '操作失败');
    await loadUsers();
  }
}

async function changeRole(row: AuthUser, role: Role) {
  try {
    await usersApi.update(row.id, { role });
    row.role = role;
    message.success(`「${row.username}」已设为${role === 'admin' ? '管理员' : '普通用户'}`);
  } catch (err: any) {
    message.error(err?.message || '操作失败');
    await loadUsers();
  }
}

async function removeUser(row: AuthUser) {
  try {
    await usersApi.remove(row.id);
    message.success(`已删除「${row.username}」`);
    await loadUsers();
  } catch (err: any) {
    message.error(err?.message || '删除失败');
  }
}

const columns = computed<DataTableColumns<AuthUser>>(() => [
  {
    title: '用户名',
    key: 'username',
    width: 160,
    render: (row) =>
      h('div', { class: 'flex items-center gap-2' }, [
        h(
          'span',
          {
            class:
              'w-6 h-6 rounded-full text-white text-xs font-semibold flex items-center justify-center shrink-0',
            style: { background: row.role === 'admin' ? '#4f8cff' : '#3a4152' },
          },
          (row.display_name || row.username).slice(0, 1).toUpperCase()
        ),
        h('span', { class: 'text-[13px]' }, row.username),
      ]),
  },
  { title: '显示名', key: 'display_name', width: 150, ellipsis: { tooltip: true } },
  {
    title: '角色',
    key: 'role',
    width: 130,
    render: (row) =>
      row.role === 'admin'
        ? h(NTag, { type: 'info', size: 'small', bordered: false }, { default: () => '管理员' })
        : h(NTag, { size: 'small', bordered: false }, { default: () => '普通用户' }),
  },
  {
    title: '状态',
    key: 'enabled',
    width: 110,
    render: (row) =>
      h(NSwitch, {
        value: !!row.enabled,
        size: 'small',
        disabled: isSelf(row),
        'onUpdate:value': (v: boolean) => toggleEnabled(row, v),
      }),
  },
  { title: '最后登录', key: 'last_login', width: 170, render: (row) => row.last_login || '—' },
  { title: '创建时间', key: 'created_at', width: 170, render: (row) => row.created_at || '—' },
  {
    title: '操作',
    key: 'actions',
    width: 230,
    render: (row) =>
      h('div', { class: 'flex items-center gap-2' }, [
        h(
          NButton,
          { size: 'tiny', quaternary: true, type: 'primary', onClick: () => openReset(row) },
          { default: () => '重置密码' }
        ),
        h(
          NButton,
          {
            size: 'tiny',
            quaternary: true,
            disabled: isSelf(row),
            onClick: () => changeRole(row, row.role === 'admin' ? 'user' : 'admin'),
          },
          { default: () => (row.role === 'admin' ? '降为普通' : '设为管理员') }
        ),
        h(
          NPopconfirm,
          { onPositiveClick: () => removeUser(row), positiveText: '删除', negativeText: '取消' },
          {
            trigger: () =>
              h(
                NButton,
                { size: 'tiny', quaternary: true, type: 'error', disabled: isSelf(row) },
                { default: () => '删除' }
              ),
            default: () => `确定删除用户「${row.username}」？其登录状态会立即失效。`,
          }
        ),
      ]),
  },
]);

/* ------------------------------------------------------------------ *
 * 新增用户
 * ------------------------------------------------------------------ */

const createVisible = ref(false);
const creating = ref(false);
const form = ref({ username: '', displayName: '', password: '', role: 'user' as Role });
const formError = ref('');

function openCreate() {
  form.value = { username: '', displayName: '', password: '', role: 'user' };
  formError.value = '';
  createVisible.value = true;
}

async function submitCreate() {
  formError.value = '';
  const f = form.value;
  if (!f.username.trim()) return (formError.value = '请输入用户名');
  if (f.password.length < 6) return (formError.value = '密码至少 6 位');

  creating.value = true;
  try {
    await usersApi.create({
      username: f.username.trim(),
      password: f.password,
      displayName: f.displayName.trim() || undefined,
      role: f.role,
    });
    createVisible.value = false;
    message.success(`已创建用户「${f.username.trim()}」`);
    await loadUsers();
  } catch (err: any) {
    formError.value = err?.message || '创建失败';
  } finally {
    creating.value = false;
  }
}

/* ------------------------------------------------------------------ *
 * 重置密码
 * ------------------------------------------------------------------ */

const resetVisible = ref(false);
const resetting = ref(false);
const resetTarget = ref<AuthUser | null>(null);
const resetPwd = ref('');
const resetError = ref('');

function openReset(row: AuthUser) {
  resetTarget.value = row;
  resetPwd.value = '';
  resetError.value = '';
  resetVisible.value = true;
}

async function submitReset() {
  resetError.value = '';
  if (resetPwd.value.length < 6) return (resetError.value = '密码至少 6 位');
  if (!resetTarget.value) return;

  resetting.value = true;
  try {
    await usersApi.resetPassword(resetTarget.value.id, resetPwd.value);
    resetVisible.value = false;
    message.success(`已重置「${resetTarget.value.username}」的密码`);
  } catch (err: any) {
    resetError.value = err?.message || '重置失败';
  } finally {
    resetting.value = false;
  }
}

onMounted(loadUsers);
</script>

<template>
  <div class="p-4 md:p-6 max-w-[1200px] mx-auto">
    <div class="flex flex-wrap items-center gap-2 md:gap-4 mb-4 md:mb-6">
      <h1 class="text-[18px] md:text-[22px] font-semibold">用户管理</h1>
      <span class="hidden md:inline text-[13px] text-muted">
        共 {{ users.length }} 个账号 · 普通用户不可见「扫描任务 / 设置 / 用户管理」
      </span>
      <n-button class="ml-auto" type="primary" size="small" @click="openCreate">新增用户</n-button>
    </div>

    <n-data-table
      :columns="columns"
      :data="users"
      :loading="loading"
      :bordered="false"
      :single-line="false"
      size="small"
      :scroll-x="1120"
      :row-key="(row: AuthUser) => row.id"
    />

    <!-- 新增用户 -->
    <n-modal v-model:show="createVisible" preset="card" title="新增用户" style="width: min(440px, 92vw)">
      <div class="text-sm">
        <label class="block text-xs text-muted mb-1.5">用户名</label>
        <input
          v-model="form.username"
          type="text"
          placeholder="2-32 位字母、数字、下划线或中文"
          class="w-full h-10 px-3 rounded-lg bg-[#1e222b] border border-line text-sm outline-none focus:border-accent"
        />

        <label class="block text-xs text-muted mb-1.5 mt-4">显示名（可选）</label>
        <input
          v-model="form.displayName"
          type="text"
          placeholder="留空则与用户名相同"
          class="w-full h-10 px-3 rounded-lg bg-[#1e222b] border border-line text-sm outline-none focus:border-accent"
        />

        <label class="block text-xs text-muted mb-1.5 mt-4">密码（至少 6 位）</label>
        <input
          v-model="form.password"
          type="password"
          autocomplete="new-password"
          class="w-full h-10 px-3 rounded-lg bg-[#1e222b] border border-line text-sm outline-none focus:border-accent"
        />

        <label class="block text-xs text-muted mb-1.5 mt-4">角色</label>
        <n-radio-group v-model:value="form.role" size="small">
          <n-radio value="user">普通用户</n-radio>
          <n-radio value="admin">管理员</n-radio>
        </n-radio-group>

        <div
          v-if="formError"
          class="mt-3 px-3 py-2 rounded-lg text-[13px] text-[#ff8a8a]"
          style="background: rgba(255, 77, 79, 0.12); border: 1px solid rgba(255, 77, 79, 0.3)"
        >
          {{ formError }}
        </div>
      </div>

      <template #footer>
        <div class="flex justify-end gap-2">
          <button
            class="h-9 px-4 rounded-lg border border-line text-sm text-[#c8cfdd] hover:bg-white/5"
            @click="createVisible = false"
          >
            取消
          </button>
          <button
            class="h-9 px-4 rounded-lg bg-accent text-white text-sm hover:bg-[#3d7bf0] disabled:opacity-60"
            :disabled="creating"
            @click="submitCreate"
          >
            {{ creating ? '创建中…' : '创建' }}
          </button>
        </div>
      </template>
    </n-modal>

    <!-- 重置密码 -->
    <n-modal v-model:show="resetVisible" preset="card" title="重置密码" style="width: min(420px, 92vw)">
      <div class="text-sm">
        <p class="text-[13px] text-muted mb-4">
          为用户「{{ resetTarget?.username }}」设置新密码，保存后该用户需重新登录。
        </p>
        <label class="block text-xs text-muted mb-1.5">新密码（至少 6 位）</label>
        <input
          v-model="resetPwd"
          type="password"
          autocomplete="new-password"
          class="w-full h-10 px-3 rounded-lg bg-[#1e222b] border border-line text-sm outline-none focus:border-accent"
          @keyup.enter="submitReset"
        />
        <div
          v-if="resetError"
          class="mt-3 px-3 py-2 rounded-lg text-[13px] text-[#ff8a8a]"
          style="background: rgba(255, 77, 79, 0.12); border: 1px solid rgba(255, 77, 79, 0.3)"
        >
          {{ resetError }}
        </div>
      </div>

      <template #footer>
        <div class="flex justify-end gap-2">
          <button
            class="h-9 px-4 rounded-lg border border-line text-sm text-[#c8cfdd] hover:bg-white/5"
            @click="resetVisible = false"
          >
            取消
          </button>
          <button
            class="h-9 px-4 rounded-lg bg-accent text-white text-sm hover:bg-[#3d7bf0] disabled:opacity-60"
            :disabled="resetting"
            @click="submitReset"
          >
            {{ resetting ? '提交中…' : '确定' }}
          </button>
        </div>
      </template>
    </n-modal>
  </div>
</template>
