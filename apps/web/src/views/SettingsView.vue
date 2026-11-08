<script setup lang="ts">
import { nextTick, ref } from 'vue';
import { NTabPane, NTabs } from 'naive-ui';
import type { AppSettings, DesktopInfo, Health, LocalRuntimeProfile, OpenAIConnectionSummary, ProviderSummary } from '../types.ts';
import MediaSettings from '../components/MediaSettings.vue';
import ProviderSettings from '../components/ProviderSettings.vue';
import OpenAISettings from '../components/OpenAISettings.vue';
import RuntimeSettings from '../components/RuntimeSettings.vue';
import WorkspaceSettings from '../components/WorkspaceSettings.vue';
import type { RuntimeSettingsInput } from '../lib/studioApi.ts';
import type { ProviderInput } from '../lib/providerApi.ts';
import type { OpenAIConnectionSave } from '../lib/openaiApi.ts';

defineProps<{ settings: AppSettings; health: Health | null; disabled: boolean; saving: boolean; checking: boolean; providers: ProviderSummary[]; providerSavedRevision: number; openaiConnections: OpenAIConnectionSummary[]; openaiLoading: boolean; openaiSaving: boolean; openaiSavedRevision: number; openaiError: string; runtimes: LocalRuntimeProfile[]; desktopAvailable: boolean; desktopInfo: DesktopInfo | null; desktopLoading: boolean; desktopError: string }>();
const emit = defineEmits<{ save: [input: AppSettings]; check: []; saveProvider: [input: { id: string | null; profile: ProviderInput }]; refreshProviders: []; saveOpenai: [input: OpenAIConnectionSave]; refreshOpenai: []; clearOpenaiError: []; saveRuntime: [input: { id: string | null; profile: RuntimeSettingsInput }]; refreshRuntimes: []; refreshDesktop: [] }>();
const tab = ref('media');
const tabNames = ['media', 'openai', 'providers', 'runtimes', 'workspace'];
function tabProps(name: string) {
  return {
    id: `settings-tab-${name}`, role: 'tab', 'aria-selected': tab.value === name,
    'aria-controls': `settings-panel-${name}`, tabindex: tab.value === name ? 0 : -1,
    onKeydown: async (event: KeyboardEvent) => {
      const index = tabNames.indexOf(name);
      const next = event.key === 'ArrowRight' ? (index + 1) % tabNames.length
        : event.key === 'ArrowLeft' ? (index + tabNames.length - 1) % tabNames.length
        : event.key === 'Home' ? 0 : event.key === 'End' ? tabNames.length - 1 : -1;
      if (next < 0) return;
      event.preventDefault();
      tab.value = tabNames[next]!;
      await nextTick();
      document.getElementById(`settings-tab-${tab.value}`)?.focus();
    },
  };
}
</script>

<template>
  <div class="settings-view readable-view">
    <header class="page-heading">
      <div><p class="eyebrow">YOUR LOCAL STUDIO</p><h1>工作台设置</h1><p class="subheading">按模块管理媒体工具、模型连接与本机工作区。</p></div>
    </header>
    <NTabs v-model:value="tab" type="line" class="settings-tabs" :pane-style="{ paddingTop: '24px' }" aria-label="设置模块" role="tablist">
      <NTabPane name="media" tab="媒体工具" :tab-props="tabProps('media')" id="settings-panel-media" role="tabpanel" aria-labelledby="settings-tab-media" display-directive="show">
        <MediaSettings :settings="settings" :health="health" :disabled="disabled" :saving="saving" :checking="checking" @save="emit('save', $event)" @check="emit('check')" />
      </NTabPane>
      <NTabPane name="openai" tab="OpenAI" :tab-props="tabProps('openai')" id="settings-panel-openai" role="tabpanel" aria-labelledby="settings-tab-openai" display-directive="show">
        <OpenAISettings :connections="openaiConnections" :loading="openaiLoading" :saving="openaiSaving" :saved-revision="openaiSavedRevision" :error="openaiError" :disabled="disabled" @save="emit('saveOpenai', $event)" @refresh="emit('refreshOpenai')" @clear-error="emit('clearOpenaiError')" />
      </NTabPane>
      <NTabPane name="providers" tab="其他模型连接" :tab-props="tabProps('providers')" id="settings-panel-providers" role="tabpanel" aria-labelledby="settings-tab-providers" display-directive="show">
        <ProviderSettings :providers="providers" :saved-revision="providerSavedRevision" :disabled="disabled" @save="emit('saveProvider', $event)" @refresh="emit('refreshProviders')" />
      </NTabPane>
      <NTabPane name="runtimes" tab="本机 CLI" :tab-props="tabProps('runtimes')" id="settings-panel-runtimes" role="tabpanel" aria-labelledby="settings-tab-runtimes" display-directive="show">
        <RuntimeSettings :runtimes="runtimes" :disabled="disabled" @save="emit('saveRuntime', $event)" @refresh="emit('refreshRuntimes')" />
      </NTabPane>
      <NTabPane name="workspace" tab="本机工作区" :tab-props="tabProps('workspace')" id="settings-panel-workspace" role="tabpanel" aria-labelledby="settings-tab-workspace" display-directive="show">
        <WorkspaceSettings :health="health" :disabled="disabled" :desktop-available="desktopAvailable" :desktop-info="desktopInfo" :desktop-loading="desktopLoading" :desktop-error="desktopError" @refresh-desktop="emit('refreshDesktop')" />
      </NTabPane>
    </NTabs>
  </div>
</template>
