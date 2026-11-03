<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { useMessage, useDialog } from 'naive-ui';
import {
  librariesApi,
  settingsApi,
  spriteApi,
  previewApi,
  usersApi,
  formatSize,
  type Library,
  type SpriteBatchState,
  type PreviewBatchState,
  type SystemInfo,
  type AuthUser,
} from '@/api';
import { useAppStore } from '@/stores/app';

const message = useMessage();
const dialog = useDialog();
const store = useAppStore();

const tab = ref<'libraries' | 'playback' | 'system'>('libraries');

// ---------- 媒体库 ----------
const libs = ref<Library[]>([]);
const libsLoading = ref(false);
const scanningId = ref<number | null>(null);

const showModal = ref(false);
const editing = ref<Library | null>(null);
const form = reactive({ name: '', path: '', scanCron: '0 3 * * *', enabled: true, userIds: [] as number[] });
const submitting = ref(false);

// 可见用户（v1.4.11）：可选的「启用中普通用户」，管理员不在列表（始终可见全部）
const viewers = ref<AuthUser[]>([]);
const viewerOptions = computed(() =>
  viewers.value.map((u) => ({ label: u.display_name || u.username, value: u.id }))
);
const viewerNameById = computed(() => {
  const m = new Map<number, string>();
  for (const u of viewers.value) m.set(u.id, u.display_name || u.username);
  return m;
});

async function loadViewers() {
  try {
    // usersApi 仅管理员可用（设置页本身就是 admin-only）
    viewers.value = (await usersApi.list()).filter((u) => u.enabled && u.role !== 'admin');
  } catch (_) {
    viewers.value = [];
  }
}

/** 库卡片上的可见用户摘要 */
function viewersText(lib: Library) {
  const ids = lib.user_ids || [];
  if (!ids.length) return '仅管理员';
  const names = ids.map((id) => viewerNameById.value.get(id) || '#' + id);
  return names.join('、');
}

async function loadLibs() {
  libsLoading.value = true;
  try {
    libs.value = await store.loadLibraries(true);
  } catch (err: any) {
    message.error(err?.message || '加载失败');
  } finally {
    libsLoading.value = false;
  }
}

function openAdd() {
  editing.value = null;
  form.name = '';
  form.path = '';
  form.scanCron = '0 3 * * *';
  form.enabled = true;
  form.userIds = [];
  showModal.value = true;
}

function openEdit(lib: Library) {
  editing.value = lib;
  form.name = lib.name;
  form.path = lib.path;
  form.scanCron = lib.scan_cron || '0 3 * * *';
  form.enabled = !!lib.enabled;
  form.userIds = [...(lib.user_ids || [])];
  showModal.value = true;
}

async function submit() {
  if (!form.name.trim()) {
    message.warning('请填写名称');
    return;
  }
  if (!editing.value && !form.path.trim()) {
    message.warning('请填写目录绝对路径');
    return;
  }
  submitting.value = true;
  try {
    if (editing.value) {
      await librariesApi.update(editing.value.id, {
        name: form.name.trim(),
        scanCron: form.scanCron.trim(),
        enabled: form.enabled,
        userIds: [...form.userIds],
      });
      message.success('已保存');
    } else {
      await librariesApi.create({
        name: form.name.trim(),
        path: form.path.trim(),
        scanCron: form.scanCron.trim(),
        userIds: [...form.userIds],
      });
      message.success('媒体库已添加');
    }
    showModal.value = false;
    await loadLibs();
  } catch (err: any) {
    message.error(err?.message || '保存失败');
  } finally {
    submitting.value = false;
  }
}

function removeLib(lib: Library) {
  dialog.warning({
    title: '删除媒体库',
    content: `确定删除「${lib.name}」吗？该库下已索引的视频记录也会一并移除（不会删除磁盘文件）。`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        await librariesApi.remove(lib.id);
        message.success('已删除');
        await loadLibs();
      } catch (err: any) {
        message.error(err?.message || '删除失败');
      }
    },
  });
}

async function scanLib(lib: Library) {
  scanningId.value = lib.id;
  try {
    const r = await librariesApi.scan(lib.id);
    message.success(`扫描完成：新增 ${r.added}，更新 ${r.updated}，删除 ${r.deleted}，失败 ${r.failed}`);
    await loadLibs();
  } catch (err: any) {
    message.error(err?.message || '扫描失败');
  } finally {
    scanningId.value = null;
  }
}

// ---------- 播放设置 ----------
const playback = reactive({ volume: 1, autoplay: true, rememberProgress: true });
const savingPlayback = ref(false);

async function loadPlayback() {
  const s = await store.loadSettings(true);
  playback.volume = Number(s['playback.volume'] ?? '1');
  playback.autoplay = s['playback.autoplay'] !== 'false';
  playback.rememberProgress = s['playback.rememberProgress'] !== 'false';
}

async function savePlayback() {
  savingPlayback.value = true;
  try {
    await store.saveSettings({
      'playback.volume': String(playback.volume),
      'playback.autoplay': String(playback.autoplay),
      'playback.rememberProgress': String(playback.rememberProgress),
    });
    message.success('播放设置已保存');
  } catch (err: any) {
    message.error(err?.message || '保存失败');
  } finally {
    savingPlayback.value = false;
  }
}

// ---------- 系统 ----------
const sysInfo = ref<SystemInfo | null>(null);
const clearing = ref(false);

async function loadSys() {
  try {
    sysInfo.value = await settingsApi.systemInfo();
  } catch (_) {
    /* ignore */
  }
}

async function clearThumbs() {
  clearing.value = true;
  try {
    const r = await settingsApi.clearThumbs();
    message.success(`已清空缩略图缓存（${r.count} 个文件），下次访问将按需重新生成`);
    await loadSys();
  } catch (err: any) {
    message.error(err?.message || '清空失败');
  } finally {
    clearing.value = false;
  }
}

// ---------- 抽帧预览（精灵图） ----------
const batch = ref<SpriteBatchState | null>(null);
const batchStarting = ref(false);
let batchTimer: number | null = null;

const batchPercent = computed(() => {
  const s = batch.value;
  if (!s || !s.total) return 0;
  return Math.min(100, Math.round(((s.done + s.failed) / s.total) * 100));
});

async function loadBatch() {
  try {
    batch.value = await spriteApi.batchState();
  } catch (_) {
    /* 普通用户无权查看，忽略 */
  }
}

function stopBatchPolling() {
  if (batchTimer) {
    window.clearInterval(batchTimer);
    batchTimer = null;
  }
}

function startBatchPolling() {
  if (batchTimer) return;
  batchTimer = window.setInterval(async () => {
    try {
      const s = await spriteApi.batchState();
      batch.value = s;
      if (s.running) return;
      stopBatchPolling();
      await loadSys();
      message.success(`预览图生成结束：成功 ${s.done} 个，失败 ${s.failed} 个`);
    } catch (_) {
      stopBatchPolling();
    }
  }, 2000);
}

async function startBatch() {
  batchStarting.value = true;
  try {
    const s = await spriteApi.batchStart();
    batch.value = s;
    if (!s.running) {
      message.info('所有视频都已有预览图，无需生成');
      return;
    }
    message.success(`已在后台开始生成预览图，共 ${s.total} 个视频`);
    startBatchPolling();
  } catch (err: any) {
    message.error(err?.message || '启动失败');
  } finally {
    batchStarting.value = false;
  }
}

async function cancelBatch() {
  try {
    batch.value = await spriteApi.batchCancel();
    message.info('已请求取消，当前生成完成后会停止');
  } catch (err: any) {
    message.error(err?.message || '取消失败');
  }
}

// ---------- 悬停预览片段（v1.4） ----------
const pbatch = ref<PreviewBatchState | null>(null);
const pbatchStarting = ref(false);
let pbatchTimer: number | null = null;

const pbatchPercent = computed(() => {
  const s = pbatch.value;
  if (!s || !s.total) return 0;
  return Math.min(100, Math.round(((s.done + s.failed) / s.total) * 100));
});

async function loadPbatch() {
  try {
    pbatch.value = await previewApi.batchState();
  } catch (_) {
    /* 普通用户无权查看，忽略 */
  }
}

function stopPbatchPolling() {
  if (pbatchTimer) {
    window.clearInterval(pbatchTimer);
    pbatchTimer = null;
  }
}

function startPbatchPolling() {
  if (pbatchTimer) return;
  pbatchTimer = window.setInterval(async () => {
    try {
      const s = await previewApi.batchState();
      pbatch.value = s;
      if (s.running) return;
      stopPbatchPolling();
      await loadSys();
      message.success(`悬停预览生成结束：成功 ${s.done} 个，失败 ${s.failed} 个`);
    } catch (_) {
      /* ignore */
    }
  }, 2000);
}

async function startPbatch() {
  pbatchStarting.value = true;
  try {
    const s = await previewApi.batchStart();
    pbatch.value = s;
    if (!s.running) {
      message.info('所有视频都已有悬停预览片段，无需生成');
      return;
    }
    message.success(`已在后台开始生成悬停预览，共 ${s.total} 个视频`);
    startPbatchPolling();
  } catch (err: any) {
    message.error(err?.message || '启动失败');
  } finally {
    pbatchStarting.value = false;
  }
}

async function cancelPbatch() {
  try {
    pbatch.value = await previewApi.batchCancel();
    message.info('已请求取消，当前生成完成后会停止');
  } catch (err: any) {
    message.error(err?.message || '取消失败');
  }
}

// ---------- 孤儿缓存回收 ----------
const gcRunning = ref(false);

async function gcCache() {
  gcRunning.value = true;
  try {
    const r = await settingsApi.gcCache();
    const freed = formatSize(r.bytes);
    message.success(
      `已回收无主缓存：缩略图 ${r.thumbs.removed} 个、预览图 ${r.sprites.removed} 个、悬停片段 ${r.previews?.removed ?? 0} 个，释放 ${freed}`
    );
    await loadSys();
  } catch (err: any) {
    message.error(err?.message || '清理失败');
  } finally {
    gcRunning.value = false;
  }
}

function backupDb() {
  window.open(settingsApi.backupUrl, '_blank');
}

onMounted(async () => {
  await Promise.all([loadLibs(), loadPlayback(), loadSys(), loadBatch(), loadPbatch(), loadViewers()]);
  if (batch.value?.running) startBatchPolling();
  if (pbatch.value?.running) startPbatchPolling();
});

onBeforeUnmount(() => {
  stopBatchPolling();
  stopPbatchPolling();
});
</script>

<template>
  <div class="p-4 md:p-6 max-w-[1100px] mx-auto">
    <h1 class="text-[18px] md:text-[22px] font-semibold mb-4 md:mb-6">设置</h1>

    <n-tabs v-model:value="tab" type="segment">
      <!-- 媒体库 -->
      <n-tab-pane name="libraries" tab="媒体库">
        <div class="flex flex-wrap items-center justify-between gap-2 mb-4 mt-2">
          <div class="hidden sm:block text-[13px] text-muted">
            添加本地目录作为媒体库，扫描后影片会出现在首页。
          </div>
          <n-button size="small" type="primary" class="w-full sm:w-auto" @click="openAdd">新增媒体库</n-button>
        </div>

        <div v-if="libsLoading" class="flex justify-center py-16"><n-spin /></div>

        <div v-else class="flex flex-col gap-3">
          <div v-for="lib in libs" :key="lib.id" class="cn-card p-3 md:p-4">
            <div class="flex flex-wrap items-start gap-3 md:gap-4">
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <span class="text-[15px] font-medium truncate">{{ lib.name }}</span>
                  <n-tag v-if="!lib.enabled" size="tiny" :bordered="false" type="warning">已停用</n-tag>
                </div>
                <div class="text-[12.5px] text-muted mt-1 break-all">{{ lib.path }}</div>
                <div class="text-[12px] text-muted mt-1.5">
                  视频 {{ lib.video_count ?? 0 }} 个 · 定时扫描
                  <code class="px-1 rounded bg-white/5">{{ lib.scan_cron }}</code>
                  · 创建于 {{ lib.created_at }}
                </div>
                <div class="text-[12px] text-muted mt-1">
                  可见范围：{{ viewersText(lib) }}
                </div>
              </div>

              <div class="flex w-full md:w-auto items-center justify-end gap-2 shrink-0">
                <n-button
                  size="tiny"
                  :loading="scanningId === lib.id"
                  :disabled="!lib.enabled"
                  :title="lib.enabled ? '' : '已停用，启用后才能扫描'"
                  @click="scanLib(lib)"
                >扫描</n-button>
                <n-button size="tiny" @click="openEdit(lib)">编辑</n-button>
                <n-button size="tiny" type="error" ghost @click="removeLib(lib)">删除</n-button>
              </div>
            </div>
          </div>

          <div v-if="libs.length === 0" class="text-center py-14 text-muted text-[13.5px]">
            还没有媒体库，点击上方「新增媒体库」开始。
          </div>
        </div>
      </n-tab-pane>

      <!-- 播放设置 -->
      <n-tab-pane name="playback" tab="播放">
        <div class="mt-4 flex flex-col gap-6 max-w-[520px]">
          <div>
            <div class="text-[14px] mb-2">默认音量：{{ Math.round(playback.volume * 100) }}%</div>
            <n-slider v-model:value="playback.volume" :min="0" :max="1" :step="0.05" />
          </div>

          <div class="flex items-center justify-between">
            <div>
              <div class="text-[14px]">自动播放</div>
              <div class="text-[12px] text-muted mt-0.5">进入播放页后自动开始播放</div>
            </div>
            <n-switch v-model:value="playback.autoplay" />
          </div>

          <div class="flex items-center justify-between">
            <div>
              <div class="text-[14px]">记忆播放进度</div>
              <div class="text-[12px] text-muted mt-0.5">
                打开视频时，若上次进度超过 5 秒则自动跳转
              </div>
            </div>
            <n-switch v-model:value="playback.rememberProgress" />
          </div>

          <div>
            <n-button type="primary" size="small" :loading="savingPlayback" @click="savePlayback">
              保存设置
            </n-button>
          </div>
        </div>
      </n-tab-pane>

      <!-- 系统 -->
      <n-tab-pane name="system" tab="系统">
        <div class="mt-4 flex flex-col gap-6 max-w-[720px]">
          <div class="grid grid-cols-1 md:grid-cols-2 gap-3 text-[13px]">
            <div class="cn-card p-3">
              <div class="text-muted mb-1">访问端口</div>
              <div>{{ sysInfo?.port ?? '-' }}</div>
            </div>
            <div class="cn-card p-3">
              <div class="text-muted mb-1">监听地址</div>
              <div>{{ sysInfo?.host ?? '-' }}</div>
            </div>
            <div class="cn-card p-3 md:col-span-2">
              <div class="text-muted mb-1">数据目录</div>
              <div class="break-all">{{ sysInfo?.dataDir ?? '-' }}</div>
            </div>
            <div class="cn-card p-3">
              <div class="text-muted mb-1">数据库大小</div>
              <div>{{ formatSize(sysInfo?.dbSize) }}</div>
            </div>
            <div class="cn-card p-3">
              <div class="text-muted mb-1">缩略图缓存</div>
              <div>{{ sysInfo?.thumbCount ?? 0 }} 个文件</div>
            </div>
            <div class="cn-card p-3 md:col-span-2">
              <div class="text-muted mb-1">ffmpeg</div>
              <div class="break-all">{{ sysInfo?.ffmpeg ?? '-' }}</div>
            </div>
            <div class="cn-card p-3 md:col-span-2">
              <div class="text-muted mb-1">进度条预览图（抽帧）</div>
              <div>
                已生成 {{ sysInfo?.sprite?.ready ?? 0 }} / {{ sysInfo?.sprite?.total ?? 0 }} 个
                · 占用 {{ formatSize(sysInfo?.sprite?.bytes ?? 0) }}
              </div>
              <div v-if="batch?.running" class="mt-2">
                <n-progress
                  type="line"
                  :percentage="batchPercent"
                  :height="6"
                  :show-indicator="false"
                  status="info"
                />
                <div class="text-[12px] text-muted mt-1">
                  生成中：已完成 {{ batch.done }} / {{ batch.total }}
                  <span v-if="batch.failed"> · 失败 {{ batch.failed }}</span>
                </div>
              </div>
              <div v-else class="text-[12px] text-muted mt-1">
                首次打开某个视频时自动生成；也可以点下方按钮一次性补齐存量
              </div>
            </div>
            <div class="cn-card p-3 md:col-span-2">
              <div class="text-muted mb-1">悬停预览片段（卡片悬停播放）</div>
              <div>
                已生成 {{ sysInfo?.preview?.ready ?? 0 }} / {{ sysInfo?.preview?.total ?? 0 }} 个
                · 占用 {{ formatSize(sysInfo?.preview?.bytes ?? 0) }}
              </div>
              <div v-if="pbatch?.running" class="mt-2">
                <n-progress
                  type="line"
                  :percentage="pbatchPercent"
                  :height="6"
                  :show-indicator="false"
                  status="info"
                />
                <div class="text-[12px] text-muted mt-1">
                  生成中：已完成 {{ pbatch.done }} / {{ pbatch.total }}
                  <span v-if="pbatch.failed"> · 失败 {{ pbatch.failed }}</span>
                </div>
              </div>
              <div v-else class="text-[12px] text-muted mt-1">
                鼠标悬停卡片 0.35 秒后自动静音循环播放（全片均匀 5 段 × 2 秒，480p）；
                每次扫描完成后自动补齐新视频，也可点下方按钮一次性生成
              </div>
            </div>
            <div class="cn-card p-3 md:col-span-2">
              <div class="text-muted mb-1">缓存占用</div>
              <div>
                缩略图 {{ sysInfo?.cache?.thumbs?.count ?? 0 }} 个
                （{{ formatSize(sysInfo?.cache?.thumbs?.bytes ?? 0) }}）
                · 预览图 {{ sysInfo?.cache?.sprites?.count ?? 0 }} 个
                （{{ formatSize(sysInfo?.cache?.sprites?.bytes ?? 0) }}）
                · 悬停片段 {{ sysInfo?.cache?.previews?.count ?? 0 }} 个
                （{{ formatSize(sysInfo?.cache?.previews?.bytes ?? 0) }}）
              </div>
            </div>
            <div class="cn-card p-3">
              <div class="text-muted mb-1">Node.js</div>
              <div>{{ sysInfo?.node ?? '-' }}</div>
            </div>
            <div class="cn-card p-3">
              <div class="text-muted mb-1">平台</div>
              <div>{{ sysInfo?.platform ?? '-' }}</div>
            </div>
          </div>

          <div class="flex flex-wrap items-center gap-3">
            <n-button size="small" :loading="batchStarting" :disabled="!!batch?.running" @click="startBatch">
              生成预览图（抽帧）
            </n-button>
            <n-button v-if="batch?.running" size="small" @click="cancelBatch">取消生成</n-button>
            <n-button size="small" :loading="pbatchStarting" :disabled="!!pbatch?.running" @click="startPbatch">
              生成悬停预览
            </n-button>
            <n-button v-if="pbatch?.running" size="small" @click="cancelPbatch">取消悬停预览</n-button>
            <n-button size="small" :loading="clearing" @click="clearThumbs">清空缩略图缓存</n-button>
            <n-button size="small" :loading="gcRunning" @click="gcCache">清理孤儿缓存</n-button>
            <n-button size="small" @click="backupDb">备份数据库（下载 .db）</n-button>
          </div>

          <div class="text-[12px] text-muted leading-relaxed border-t border-line pt-4">
            「预览图」是把整片按时间均匀抽帧拼成的一张长图，播放时鼠标悬停进度条（手机拖动进度条）
            就会显示对应时间点的画面。4K 片源单张约 20-30 秒，全部在后台生成，不影响播放。
            「清理孤儿缓存」用于回收删片 / 删库后残留的无主文件。
          </div>

          <div class="text-[12px] text-muted leading-relaxed border-t border-line pt-4">
            提示：v1 为单用户本地应用，默认仅本机与局域网可访问。局域网访问请使用
            <code class="px-1 rounded bg-white/5">http://&lt;本机IP&gt;:{{ sysInfo?.port ?? 8080 }}</code>。
          </div>
        </div>
      </n-tab-pane>
    </n-tabs>

    <!-- 新增 / 编辑媒体库 -->
    <n-modal v-model:show="showModal">
      <div class="w-[min(540px,92vw)] rounded-xl p-5 md:p-6" style="background: #1a1d24">
        <div class="text-[16px] font-semibold mb-5">
          {{ editing ? '编辑媒体库' : '新增媒体库' }}
        </div>

        <div class="flex flex-col gap-4">
          <div>
            <div class="text-[13px] text-muted mb-1.5">名称</div>
            <n-input v-model:value="form.name" placeholder="例如：我的电影" size="small" />
          </div>

          <div>
            <div class="text-[13px] text-muted mb-1.5">目录绝对路径</div>
            <n-input
              v-model:value="form.path"
              placeholder="例如：D:\Movies"
              size="small"
              :disabled="!!editing"
            />
            <div class="text-[12px] text-muted mt-1">
              {{ editing ? '路径不可修改，如需更换请删除后重新添加。' : '必须是本机存在的绝对路径' }}
            </div>
          </div>

          <div>
            <div class="text-[13px] text-muted mb-1.5">定时扫描（cron 表达式）</div>
            <n-input v-model:value="form.scanCron" placeholder="0 3 * * *" size="small" />
            <div class="text-[12px] text-muted mt-1">默认每天凌晨 3 点扫描一次</div>
          </div>

          <div v-if="editing" class="flex items-center justify-between">
            <div class="text-[13px]">启用该媒体库</div>
            <n-switch v-model:value="form.enabled" />
          </div>

          <div>
            <div class="text-[13px] text-muted mb-1.5">可见用户（可多选）</div>
            <n-select
              v-model:value="form.userIds"
              multiple
              clearable
              size="small"
              :options="viewerOptions"
              placeholder="默认仅管理员可见"
              :max-tag-count="4"
            />
            <div class="text-[12px] text-muted mt-1">
              不选 = 仅管理员可见；普通用户只能看到被勾选的媒体库（含首页、搜索、历史等）。
            </div>
          </div>
        </div>

        <div class="flex justify-end gap-3 mt-6">
          <n-button size="small" @click="showModal = false">取消</n-button>
          <n-button size="small" type="primary" :loading="submitting" @click="submit">保存</n-button>
        </div>
      </div>
    </n-modal>
  </div>
</template>
