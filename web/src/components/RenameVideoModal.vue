<script setup lang="ts">
/**
 * 视频重命名弹窗（v1.4.8，仅管理员使用）。
 *
 * 详情页与播放页共用：改「视频名」，并把磁盘上的文件一并改名。
 * 扩展名固定不可改（由当前文件决定），输入里即使带上相同扩展名也会被自动剥离；
 * 若输入的是别的视频扩展名，直接拦下并提示 —— 换扩展名属于转封装，不该在这里悄悄做。
 */
import { computed, ref, watch } from 'vue';
import { useMessage } from 'naive-ui';
import { videosApi, type Video } from '@/api';

const props = defineProps<{ show: boolean; video: Video | null }>();
const emit = defineEmits<{
  (e: 'update:show', value: boolean): void;
  (e: 'updated', video: Video): void;
}>();

const message = useMessage();

const name = ref('');
const syncFile = ref(true);
const saving = ref(false);

const fileName = computed(() => props.video?.file_name || '');

/** 当前扩展名（保留原大小写） */
const ext = computed(() => {
  const m = /(\.[^./\\]+)$/.exec(fileName.value);
  return m ? m[1] : '';
});

/** 当前基本名（去掉扩展名） */
const oldBase = computed(() =>
  ext.value ? fileName.value.slice(0, fileName.value.length - ext.value.length) : fileName.value
);

const trimmed = computed(() => name.value.trim());

/** 前端即时校验；服务端另有一份同样的规则兜底 */
const invalid = computed(() => {
  const n = trimmed.value;
  if (!n) return '名称不能为空';
  if (n.length > 120) return '名称过长（最多 120 个字符）';
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(n)) return '名称不能包含 \\ / : * ? " < > | 等字符';
  if (/[. ]$/.test(n)) return '名称不能以空格或点号结尾';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(n)) return '该名称是系统保留名，请换一个';
  return '';
});

const nextFileName = computed(() => (trimmed.value || oldBase.value) + ext.value);
const fileWillChange = computed(() => syncFile.value && nextFileName.value !== fileName.value);
const noChange = computed(() => !fileWillChange.value && trimmed.value === oldBase.value);

watch(
  () => props.show,
  (visible) => {
    if (!visible) return;
    name.value = oldBase.value;
    syncFile.value = true;
  }
);

async function submit() {
  const v = props.video;
  if (!v || saving.value || invalid.value || noChange.value) return;

  saving.value = true;
  try {
    if (fileWillChange.value) {
      const res = await videosApi.rename(v.id, { name: trimmed.value, syncTitle: true });
      emit('updated', res.video);
      const extra = res.subtitles && res.subtitles.length ? `，同步字幕 ${res.subtitles.length} 个` : '';
      message.success(`已重命名为「${res.video.file_name}」${extra}`);
    } else {
      // 只改显示名，磁盘文件名不动
      await videosApi.update(v.id, { title: trimmed.value });
      emit('updated', { ...v, title: trimmed.value });
      message.success('显示名称已更新（磁盘文件名未改动）');
    }
    emit('update:show', false);
  } catch (err: any) {
    message.error(err?.message || '重命名失败');
  } finally {
    saving.value = false;
  }
}

function close() {
  emit('update:show', false);
}
</script>

<template>
  <n-modal :show="show" @update:show="(v: boolean) => emit('update:show', v)">
    <div class="w-[min(520px,94vw)] rounded-xl p-5" style="background: #1a1d24">
      <div class="text-[16px] font-semibold mb-1">重命名视频</div>
      <div class="text-[12.5px] text-muted mb-4">
        磁盘上的文件会一并改名；同目录同名的字幕也会跟着改。视频 ID 不变，收藏与观看进度不受影响。
      </div>

      <div class="text-[12.5px] text-muted mb-1">当前文件名</div>
      <div class="text-[13px] break-all mb-3 text-[#c3c9d6]">{{ fileName }}</div>

      <div class="text-[12.5px] text-muted mb-1">新名称（不含扩展名）</div>
      <div class="flex items-center gap-2">
        <n-input
          v-model:value="name"
          size="small"
          placeholder="输入新的视频名称"
          :status="invalid ? 'error' : undefined"
          @keyup.enter="submit"
        />
        <span class="text-[13px] text-muted shrink-0">{{ ext }}</span>
      </div>
      <div v-if="invalid" class="text-[12px] mt-1" style="color: #ff6b81">{{ invalid }}</div>

      <div class="flex items-center gap-2 mt-3">
        <n-checkbox v-model:checked="syncFile">同时重命名磁盘上的文件</n-checkbox>
      </div>

      <div class="mt-3 text-[12.5px] text-muted break-all">
        <template v-if="fileWillChange">
          磁盘文件：<span class="text-[#c3c9d6]">{{ fileName }}</span>
          <span class="mx-1">→</span>
          <span class="text-accent">{{ nextFileName }}</span>
        </template>
        <template v-else>磁盘文件名保持不变，仅修改显示名称。</template>
      </div>

      <div class="flex justify-end gap-2 mt-5">
        <n-button size="small" @click="close">取消</n-button>
        <n-button
          size="small"
          type="primary"
          :loading="saving"
          :disabled="!!invalid || noChange"
          @click="submit"
        >
          保存
        </n-button>
      </div>
    </div>
  </n-modal>
</template>
