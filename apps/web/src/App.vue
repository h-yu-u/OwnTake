<script setup lang="ts">
import { NConfigProvider, NDialogProvider, NGlobalStyle, NMessageProvider, darkTheme, dateZhCN, zhCN } from 'naive-ui';
import WorkspaceApp from './WorkspaceApp.vue';
import { themeOverrides } from './theme.ts';
</script>

<template>
  <NConfigProvider :theme="darkTheme" :theme-overrides="themeOverrides" :locale="zhCN" :date-locale="dateZhCN">
    <NGlobalStyle />
    <NMessageProvider placement="top" :max="3">
      <NDialogProvider><WorkspaceApp /></NDialogProvider>
    </NMessageProvider>
  </NConfigProvider>
</template>
