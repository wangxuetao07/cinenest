<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import { useMessage, useDialog } from 'naive-ui';
import { librariesApi, tasksApi, type ScanLog, type ScanState } from '@/api';
import { useAppStore } from '@/stores/app';

const message = useMessage();
const dialog = useDialog();
const store = useAppStore();

const logs = ref<ScanLog[]>([]);
const loading = ref(true);
const running = ref<ScanState | null>(null);
const scanningLocal = ref(false);
const purging = ref(false);

let pollTimer: number | null = null;

const percent = computed(() => {
  const s = running.value;
  if (!s || !s.total) return 0;
  return Math.min(100, Math.round((s.scanned / s.total) * 100));
});

/**
 * 最近一次被删除闸门拦下的扫描（v1.3）。
 * 出现它说明某次扫描发现大量记录的文件不存在 —— 大概率是外接盘 / NAS 没挂上，
 * 而不是用户真的删了片子。此时提供「确认清理」入口。
 */
const blockedLog = computed(() => logs.value.find((l) => Number(l.blocked) > 0) || null);

const columns = [
  { title: '媒体库', key: 'library_name', width: 150 },
  { title: '开始时间', key: 'started_at', width: 170 },
  { title: '结束时间', key: 'finished_at', width: 170 },
  { title: '新增', key: 'added', width: 70 },
  { title: '更新', key: 'updated', width: 70 },
  { title: '删除', key: 'deleted', width: 70 },
  { title: '失败', key: 'failed', width: 70 },
  { title: '拦下', key: 'blocked', width: 70 },
  { title: '说明', key: 'message', ellipsis: { tooltip: true } },
];

async function loadLogs() {
  try {
    logs.value = await tasksApi.list(50);
  } catch (err: any) {
    message.error(err?.message || '加载日志失败');
  }
}

async function poll() {
  try {
    running.value = await tasksApi.running();
    if (running.value.running) {
      // 扫描中：刷新日志
      if (pollTimer) { /* keep polling */ }
    }
  } catch (_) {
    /* ignore */
  }
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = window.setInterval(poll, 1000);
}

function stopPolling() {
  if (pollTimer) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function scanAll() {
  const libs = store.libraries.filter((l) => l.enabled);
  if (!libs.length) {
    message.warning('没有启用的媒体库，请先在「设置」中添加');
    return;
  }
  scanningLocal.value = true;
  startPolling();
  try {
    for (const lib of libs) {
      const r = await librariesApi.scan(lib.id);
      const extra = r.blocked ? `；⚠️ 已跳过删除 ${r.blocked} 条失效记录（疑似存储离线）` : '';
      message.success(
        `「${lib.name}」扫描完成：新增 ${r.added}，更新 ${r.updated}，删除 ${r.deleted}，失败 ${r.failed}${extra}`
      );
    }
    await loadLogs();
    await store.loadLibraries(true);
  } catch (err: any) {
    message.error(err?.message || '扫描失败');
  } finally {
    scanningLocal.value = false;
    await poll();
    stopPolling();
  }
}

/** 确认清理：二次确认后无视闸门，真正删除失效记录 */
function confirmPurge(log: ScanLog) {
  const libId = Number(log.library_id);
  if (!libId) return;
  const name = log.library_name || `#${libId}`;
  dialog.warning({
    title: '确认清理失效记录',
    content:
      `「${name}」中有 ${log.blocked} 条记录的文件已不存在。` +
      '请先确认该目录当前可以正常访问、文件确实已被移除。' +
      '清理后这些视频的标签、收藏与观看进度会一并删除，且无法恢复。',
    positiveText: '确认清理',
    negativeText: '取消',
    onPositiveClick: async () => {
      purging.value = true;
      try {
        const r = await librariesApi.purgeMissing(libId);
        message.success(`已清理 ${r.deleted} 条失效记录`);
        await loadLogs();
        await store.loadLibraries(true);
      } catch (err: any) {
        message.error(err?.message || '清理失败');
      } finally {
        purging.value = false;
      }
    },
  });
}

onMounted(async () => {
  loading.value = true;
  await store.loadLibraries();
  await Promise.all([loadLogs(), poll()]);
  loading.value = false;
});

onBeforeUnmount(stopPolling);
</script>

<template>
  <div class="p-4 md:p-6 max-w-[1400px] mx-auto">
    <div class="flex items-center gap-3 md:gap-4 mb-4 md:mb-6">
      <h1 class="text-[18px] md:text-[22px] font-semibold">扫描任务</h1>
      <n-button class="ml-auto" type="primary" size="small" :loading="scanningLocal" @click="scanAll">
        立即扫描
      </n-button>
    </div>

    <!-- 扫描进行中 -->
    <div
      v-if="running?.running"
      class="mb-5 p-3 md:p-4 rounded-lg border border-accent/30"
      style="background: rgba(79, 140, 255, 0.08)"
    >
      <div class="flex items-center gap-3 mb-2 text-[13px]">
        <n-spin size="small" />
        <span>正在扫描媒体库 #{{ running.libraryId }}…</span>
        <span class="ml-auto text-muted">{{ running.scanned }} / {{ running.total }}</span>
      </div>
      <n-progress type="line" :percentage="percent" :show-indicator="false" />
    </div>

    <!-- 删除闸门告警（v1.3）：疑似存储离线导致大量记录缺失，已跳过删除 -->
    <div
      v-if="blockedLog"
      class="mb-5 p-3 md:p-4 rounded-lg border"
      style="border-color: rgba(240, 160, 32, 0.4); background: rgba(240, 160, 32, 0.08)"
    >
      <div class="flex flex-wrap items-center gap-2">
        <span class="text-[13px] font-medium" style="color: #f0a020">⚠️ 疑似存储离线</span>
        <span class="text-[13px]">
          媒体库「{{ blockedLog.library_name || '#' + blockedLog.library_id }}」上次扫描发现
          {{ blockedLog.blocked }} 条记录的文件不存在，<b>已跳过删除</b>
          （防止外接盘 / NAS 未挂载时整库记录被清空）。
        </span>
        <n-button
          class="ml-auto shrink-0"
          size="tiny"
          type="warning"
          :loading="purging"
          @click="confirmPurge(blockedLog)"
        >
          确认清理
        </n-button>
      </div>
      <div class="text-[12px] text-muted mt-1.5">
        请先确认该目录当前可以正常访问、文件确实已被移除，再点「确认清理」。
        清理后这些视频的标签、收藏与观看进度会一并移除。
      </div>
    </div>

    <n-data-table
      :columns="columns"
      :data="logs"
      :loading="loading"
      :bordered="false"
      :single-line="false"
      size="small"
      :scroll-x="980"
      :row-key="(row: ScanLog) => row.id"
      :max-height="620"
    />
  </div>
</template>
