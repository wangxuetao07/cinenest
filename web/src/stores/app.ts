import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { librariesApi, settingsApi, type Library, type SettingsMap } from '@/api';

/**
 * 全局 UI / 数据状态。
 */
export const useAppStore = defineStore('app', () => {
  // 侧边栏
  const sidebarCollapsed = ref(false);
  function toggleSidebar() {
    sidebarCollapsed.value = !sidebarCollapsed.value;
  }

  // 媒体库
  const libraries = ref<Library[]>([]);
  const librariesLoaded = ref(false);
  async function loadLibraries(force = false) {
    if (librariesLoaded.value && !force) return libraries.value;
    libraries.value = await librariesApi.list();
    librariesLoaded.value = true;
    return libraries.value;
  }

  // 设置
  const settings = ref<SettingsMap>({});
  const settingsLoaded = ref(false);
  async function loadSettings(force = false) {
    if (settingsLoaded.value && !force) return settings.value;
    settings.value = await settingsApi.all();
    settingsLoaded.value = true;
    return settings.value;
  }
  async function saveSettings(patch: SettingsMap) {
    await settingsApi.patch(patch);
    Object.assign(settings.value, patch);
  }

  const rememberProgress = computed(
    () => settings.value['playback.rememberProgress'] !== 'false'
  );
  const autoplay = computed(() => settings.value['playback.autoplay'] !== 'false');
  const defaultVolume = computed(() => {
    const v = Number(settings.value['playback.volume']);
    return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 1;
  });

  const hasLibrary = computed(() => libraries.value.length > 0);

  return {
    sidebarCollapsed,
    toggleSidebar,
    libraries,
    librariesLoaded,
    loadLibraries,
    settings,
    settingsLoaded,
    loadSettings,
    saveSettings,
    rememberProgress,
    autoplay,
    defaultVolume,
    hasLibrary,
  };
});
