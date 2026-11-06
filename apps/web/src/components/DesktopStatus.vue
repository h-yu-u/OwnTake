<script setup lang="ts">
import { NAlert, NButton, NCollapse, NCollapseItem, NTag } from 'naive-ui';
import type { DesktopInfo } from '../types.ts';
import AppIcon from './AppIcon.vue';
defineProps<{ info: DesktopInfo | null; loading: boolean; error: string; disabled: boolean }>();
const emit = defineEmits<{ refresh: [] }>();
</script>
<template>
  <section class="panel desktop-status" aria-labelledby="desktop-status-heading">
    <div class="desktop-status-heading"><div class="provider-symbol"><AppIcon name="desktop" :size="22" /></div><div><div class="heading-line"><h2 id="desktop-status-heading">桌面工作台</h2><NTag size="small" :bordered="false">{{ info ? `v${info.version}` : '桌面连接' }}</NTag></div><p>关闭窗口后，本地服务继续在后台处理任务。</p></div><NButton text size="small" :loading="loading" :disabled="disabled || loading" @click="emit('refresh')">刷新桌面信息</NButton></div>
    <NAlert v-if="error" type="error" :show-icon="false" class="draft-alert">{{ error }}</NAlert>
    <p class="desktop-lifecycle-note">通过应用菜单或托盘重新打开窗口；需要停止后台服务时，使用应用的「退出」。电脑休眠期间本地处理可能暂停，远端任务仍可能运行，重新打开后会按保存记录恢复。</p>
    <NCollapse v-if="info" class="desktop-details"><NCollapseItem title="查看桌面诊断信息" name="desktop-info"><dl class="detail-list"><div><dt>平台</dt><dd>{{ info.platform }}</dd></div><div><dt>Electron</dt><dd>{{ info.electron }}</dd></div><div><dt>Node</dt><dd>{{ info.node }}</dd></div><div><dt>本地核心</dt><dd><code>{{ info.coreUrl }}</code></dd></div></dl></NCollapseItem></NCollapse>
  </section>
</template>
