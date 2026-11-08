<script setup lang="ts">
import type { DesktopInfo, Health } from '../types.ts';
import AppIcon from './AppIcon.vue';
import DesktopStatus from './DesktopStatus.vue';

defineProps<{ health: Health | null; disabled: boolean; desktopAvailable: boolean; desktopInfo: DesktopInfo | null; desktopLoading: boolean; desktopError: string }>();
const emit = defineEmits<{ refreshDesktop: [] }>();
</script>

<template>
  <div class="workspace-settings">
    <DesktopStatus v-if="desktopAvailable" :info="desktopInfo" :loading="desktopLoading" :error="desktopError" :disabled="disabled" @refresh="emit('refreshDesktop')" />
    <section class="panel settings-card storage-card">
      <div class="panel-heading"><h2>本机工作区</h2><AppIcon name="projects" :size="20" /></div>
      <p class="settings-description">素材复制到项目受管目录，项目与任务记录存储在本地。</p>
      <dl v-if="health" class="detail-list">
        <div><dt>应用版本</dt><dd>{{ health.version }}</dd></div>
        <div><dt>数据结构版本</dt><dd>{{ health.schemaVersion }}</dd></div>
        <div><dt>应用数据</dt><dd><code>{{ health.dataDir }}</code></dd></div>
        <div><dt>项目目录</dt><dd><code>{{ health.projectsDir }}</code></dd></div>
      </dl>
      <p class="panel-footnote">备份与恢复步骤见仓库文档。需要切换数据目录时，请先停止服务并通过启动配置设置。</p>
      <div class="local-note"><span class="status-dot"></span><p>你的素材与成片<br /><strong>由你自己保管。</strong></p></div>
    </section>
  </div>
</template>
