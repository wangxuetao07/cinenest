<script setup lang="ts">
withDefaults(
  defineProps<{
    title?: string;
    description?: string;
    actionText?: string;
  }>(),
  {
    title: '暂无内容',
    description: '',
    actionText: '',
  }
);

const emit = defineEmits<{ (e: 'action'): void }>();
</script>

<template>
  <div class="flex flex-col items-center justify-center py-20 text-center select-none">
    <svg viewBox="0 0 24 24" class="w-16 h-16 text-[#2f3542] mb-4" fill="currentColor">
      <path
        d="M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm1 2v10h14V7H5zm5.5 2.2 4.2 2.8-4.2 2.8z"
      />
    </svg>
    <div class="text-[15px] text-[#c3c9d6] mb-1">{{ title }}</div>
    <div v-if="description" class="text-[13px] text-muted max-w-md leading-relaxed">
      {{ description }}
    </div>
    <button
      v-if="actionText"
      class="mt-4 px-4 h-9 rounded-lg bg-accent hover:bg-accenthover text-white text-sm transition-colors"
      @click="emit('action')"
    >
      {{ actionText }}
    </button>
  </div>
</template>
