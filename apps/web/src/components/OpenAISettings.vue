<script setup lang="ts">
import { ref, watch } from 'vue';
import { NAlert, NButton, NTag } from 'naive-ui';
import type { OpenAIConnectionSummary } from '../types.ts';
import type { OpenAIConnectionSave } from '../lib/openaiApi.ts';
import AppIcon from './AppIcon.vue';
import OpenAIConnectionDialog from './OpenAIConnectionDialog.vue';

const props = defineProps<{ connections: OpenAIConnectionSummary[]; loading: boolean; saving: boolean; savedRevision: number; error: string; disabled: boolean }>();
const emit = defineEmits<{ save: [value: OpenAIConnectionSave]; refresh: []; clearError: [] }>();
const show = ref(false);
const editing = ref<OpenAIConnectionSummary | null>(null);
function open(connection: OpenAIConnectionSummary | null): void {
  editing.value = connection;
  emit('clearError');
  show.value = true;
}
watch(() => props.savedRevision, () => { show.value = false; editing.value = null; });
</script>

<template>
  <section class="panel provider-settings openai-settings" aria-labelledby="openai-settings-title">
    <div class="panel-heading">
      <div><h2 id="openai-settings-title">OpenAI</h2><p class="subheading">一个 Key，统一配置分镜推理、图片生成和语音配音。</p></div>
      <div class="heading-line">
        <NButton text size="small" :loading="loading" :disabled="disabled || loading" @click="emit('refresh')">刷新</NButton>
        <NButton type="primary" secondary :disabled="disabled || loading" @click="open(null)"><template #icon><AppIcon name="plus" :size="16" /></template>添加 OpenAI</NButton>
      </div>
    </div>
    <NAlert v-if="error && !show" type="error" :show-icon="false" class="draft-alert">{{ error }}</NAlert>
    <p v-if="loading && !connections.length" class="draft-empty" role="status">正在加载 OpenAI 连接…</p>
    <div v-else-if="!connections.length" class="openai-empty">
      <div class="openai-empty-icon"><AppIcon name="studio" :size="24" /></div>
      <div><strong>已有 OpenAI API Key？</strong><p>填写一次即可在各个创作步骤中选择对应能力，模型已为你预填。</p></div>
    </div>
    <div v-else class="provider-list">
      <article v-for="connection in connections" :key="connection.id" class="openai-entry">
        <div class="provider-row">
          <div class="provider-symbol"><AppIcon name="studio" :size="22" /></div>
          <div class="provider-copy">
            <div class="heading-line"><strong>{{ connection.label }}</strong><NTag size="small" :bordered="false" :type="connection.hasKey ? 'success' : 'warning'">{{ connection.hasKey ? 'Key 已保存' : '待填写 Key' }}</NTag><NTag size="small" :bordered="false">尚未实接验证</NTag></div>
            <p>三项能力共用此连接的 Key，更新时一起生效。</p>
          </div>
          <NButton size="small" :disabled="disabled || loading" :aria-label="`管理 ${connection.label}`" @click="open(connection)">管理连接</NButton>
        </div>
        <dl class="openai-model-grid">
          <div><dt>分镜与抽帧审核</dt><dd>{{ connection.models.reasoning }}</dd></div>
          <div><dt>图片生成</dt><dd>{{ connection.models.image }}</dd></div>
          <div><dt>语音配音</dt><dd>{{ connection.models.speech }}</dd></div>
        </dl>
      </article>
    </div>
    <p class="panel-footnote">第三方或本地模型可在下方添加协议兼容连接。</p>
    <OpenAIConnectionDialog v-model:show="show" :connection="editing" :disabled="disabled" :saving="saving" :error="error" @save="emit('save', $event)" />
  </section>
</template>

<style scoped>
.openai-empty { display: flex; align-items: center; gap: 16px; padding: 20px 0; }
.openai-empty-icon { display: flex; align-items: center; justify-content: center; flex: 0 0 48px; height: 48px; border: 1px solid var(--line); border-radius: 14px; color: var(--accent); }
.openai-empty strong { font-size: 15px; }
.openai-empty p { margin: 6px 0 0; color: var(--muted); font-size: 13px; line-height: 1.7; }
.openai-model-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; margin: 0; padding: 0 0 18px 56px; }
.openai-model-grid dt { color: var(--muted); font-size: 12px; }
.openai-model-grid dd { margin: 5px 0 0; font-size: 13px; overflow-wrap: anywhere; }
.openai-entry + .openai-entry { border-top: 1px solid var(--line); }
@media (max-width: 640px) {
  .openai-model-grid { grid-template-columns: 1fr; padding-left: 0; }
  .openai-settings > .panel-heading { align-items: flex-start; flex-wrap: wrap; }
}
</style>
