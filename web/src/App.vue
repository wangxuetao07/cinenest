<script setup lang="ts">
import { darkTheme, zhCN, dateZhCN, type GlobalThemeOverrides } from 'naive-ui';

const themeOverrides: GlobalThemeOverrides = {
  common: {
    primaryColor: '#4f8cff',
    primaryColorHover: '#3d7bf0',
    primaryColorPressed: '#2f6ade',
    primaryColorSuppl: '#3d7bf0',
    bodyColor: '#0f1115',
    cardColor: '#1a1d24',
    modalColor: '#1a1d24',
    popoverColor: '#1a1d24',
    tableColor: '#1a1d24',
    borderColor: '#2a2f3a',
    textColorBase: '#e6e8ee',
    fontFamily:
      '"Microsoft YaHei", "PingFang SC", system-ui, -apple-system, "Segoe UI", sans-serif',
    borderRadius: '8px',
  },
};
</script>

<template>
  <n-config-provider
    :theme="darkTheme"
    :theme-overrides="themeOverrides"
    :locale="zhCN"
    :date-locale="dateZhCN"
  >
    <n-message-provider>
      <n-dialog-provider>
        <n-notification-provider>
          <router-view />
        </n-notification-provider>
      </n-dialog-provider>
    </n-message-provider>
  </n-config-provider>
</template>
