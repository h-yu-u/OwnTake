<script setup lang="ts">
import { computed, watch } from 'vue';
import { NAlert, NButton, NFormItem } from 'naive-ui';
import type { OpenAICapability, OpenAIConnectionSummary, OpenAIModelDiscoveryInput, OpenAIModels } from '../types.ts';
import { openAIModelOptions, openAIModelSelectionNote } from '../lib/openaiModelOptions.ts';
import { useOpenAIModelCatalog } from '../composables/useOpenAIModelCatalog.ts';
import AppIcon from './AppIcon.vue';
import OpenAIModelSelect from './OpenAIModelSelect.vue';

const props = defineProps<{ modelValue: OpenAIModels; connection: OpenAIConnectionSummary | null; apiKey: string; show: boolean; expanded: boolean; disabled: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: OpenAIModels] }>();
const credentials = computed<OpenAIModelDiscoveryInput | null>(() => {
  const key = props.apiKey.trim();
  if (key) return { key, ...(props.connection ? { connectionId: props.connection.id } : {}) };
  return props.connection?.hasKey ? { connectionId: props.connection.id } : null;
});
const { catalog, loading, error, attempted, refresh } = useOpenAIModelCatalog(() => credentials.value, () => props.show);
const fields: { key: OpenAICapability; label: string }[] = [
  { key: 'reasoning', label: '分镜推理与抽帧审核模型' },
  { key: 'image', label: '图片生成模型' },
  { key: 'speech', label: '配音模型' },
];
const selections = computed(() => fields.map(field => ({
  ...field,
  options: openAIModelOptions(field.key, props.modelValue[field.key], catalog.value),
  note: openAIModelSelectionNote(field.key, props.modelValue[field.key], catalog.value),
})));
const fetchedTime = computed(() => catalog.value ? new Date(catalog.value.fetchedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '');

// Expanding is the automatic read boundary. Editing a Key only invalidates the old list.
watch(() => props.show && props.expanded, expanded => {
  if (expanded && credentials.value && !attempted.value && !props.disabled) void refresh();
}, { immediate: true });

function updateModel(field: OpenAICapability, value: unknown): void {
  if (typeof value === 'string') emit('update:modelValue', { ...props.modelValue, [field]: value });
}
</script>

<template>
  <div class="openai-model-catalog">
    <div class="catalog-heading">
      <div>
        <strong>账号模型</strong>
        <p v-if="loading" class="form-note" role="status">正在读取当前 Key 的模型目录…</p>
        <p v-else-if="catalog" class="form-note" role="status">已读取 {{ catalog.models.length }} 个账号模型 · {{ fetchedTime }}</p>
        <p v-else class="form-note">读取当前 Key 可见的型号，按用途选择。</p>
      </div>
      <NButton size="small" :loading="loading" :disabled="disabled || loading || !credentials" @click="refresh">
        <template #icon><AppIcon name="refresh" :size="15" /></template>{{ catalog ? '刷新账号模型' : '读取账号模型' }}
      </NButton>
    </div>
    <p class="form-note">{{ apiKey.trim() ? '使用当前输入的 Key 读取，尚未保存这个 Key。' : connection?.hasKey ? '使用此连接已保存的 Key 读取。' : '先填写 API Key，即可读取账号模型。' }}读取目录不会运行模型。</p>
    <NAlert v-if="error" type="warning" :show-icon="false" class="catalog-error">{{ error }}<p>暂用官方预设，也可手动输入模型 ID；表单内容已保留。</p></NAlert>
  </div>
  <NFormItem v-for="field in selections" :key="field.key" :label="field.label" class="openai-model-field">
    <div class="model-field-content">
      <OpenAIModelSelect :value="modelValue[field.key]" :options="field.options" :disabled="disabled" :label="field.label" @update:value="value => updateModel(field.key, value)" />
      <p v-if="field.note" class="form-note model-selection-note">{{ field.note }}</p>
    </div>
  </NFormItem>
  <p class="form-note">{{ catalog ? '目录按模型名称分组，尚未验证各项生成能力。' : '当前显示官方预设，账号是否可用需通过目录或实际请求确认。' }}刷新列表会保留你的选择，也可手动输入模型 ID。</p>
</template>

<style scoped>
.openai-model-catalog { padding: 16px; margin: 0 0 22px; border: 1px solid var(--line); border-radius: 10px; }
.catalog-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.catalog-heading strong { font-size: 14px; }
.catalog-heading .form-note { margin: 5px 0 0; }
.catalog-heading .n-button { flex-shrink: 0; }
.openai-model-catalog > .form-note { margin-bottom: 0; }
.catalog-error { margin-top: 14px; }
.catalog-error p { margin: 6px 0 0; }
.model-field-content { width: 100%; min-width: 0; }
.model-selection-note { margin: 7px 0 0; }
@media (max-width: 420px) { .catalog-heading { flex-wrap: wrap; } }
</style>
