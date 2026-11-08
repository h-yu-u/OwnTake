<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { NAlert, NButton, NCollapse, NCollapseItem, NForm, NFormItem, NInput, NModal, NSelect, NTag } from 'naive-ui';
import type { OpenAIConnectionInput, OpenAIConnectionSummary, OpenAIModels } from '../types.ts';
import type { OpenAIConnectionSave } from '../lib/openaiApi.ts';
import { OPENAI_BASE_URL, OPENAI_DEFAULT_MODELS, OPENAI_MODEL_OPTIONS, OPENAI_SPEECH_SHUTDOWN_DATE } from '../../../../packages/providers/src/openai-presets.ts';

const props = defineProps<{ show: boolean; connection: OpenAIConnectionSummary | null; disabled: boolean; saving: boolean; error: string }>();
const emit = defineEmits<{ 'update:show': [value: boolean]; save: [value: OpenAIConnectionSave] }>();
const label = ref('OpenAI');
const key = ref('');
const models = ref<OpenAIModels>({ ...OPENAI_DEFAULT_MODELS });
const expanded = ref<string[]>([]);
const modelFields: { key: keyof OpenAIModels; label: string }[] = [
  { key: 'reasoning', label: '分镜推理与抽帧审核模型' },
  { key: 'image', label: '图片生成模型' },
  { key: 'speech', label: '配音模型' },
];
const modelOptions = Object.fromEntries(modelFields.map(field => [
  field.key, OPENAI_MODEL_OPTIONS[field.key].map(model => ({ label: model, value: model })),
])) as Record<keyof OpenAIModels, { label: string; value: string }[]>;
const valid = computed(() => Boolean(
  label.value.trim()
  && label.value.trim().length <= 100
  && modelFields.every(field => models.value[field.key].trim().length > 0 && models.value[field.key].trim().length <= 200)
  && (props.connection?.hasKey || key.value.trim()),
));

watch(() => props.show, show => {
  key.value = '';
  if (!show) return;
  label.value = props.connection?.label ?? 'OpenAI';
  models.value = { ...(props.connection?.models ?? OPENAI_DEFAULT_MODELS) };
  expanded.value = [];
}, { immediate: true });
onBeforeUnmount(() => { key.value = ''; });

function updateModel(field: keyof OpenAIModels, value: unknown): void {
  if (typeof value === 'string') models.value = { ...models.value, [field]: value };
}
function close(value = false): void {
  if (!props.disabled && !props.saving) emit('update:show', value);
}
function save(): void {
  if (!valid.value || props.disabled || props.saving) return;
  const input: OpenAIConnectionInput = {
    label: label.value.trim(),
    models: { reasoning: models.value.reasoning.trim(), image: models.value.image.trim(), speech: models.value.speech.trim() },
    ...(key.value.trim() ? { key: key.value.trim() } : {}),
  };
  emit('save', props.connection
    ? { id: props.connection.id, input: { ...input, expectedRevision: props.connection.revision } }
    : { id: null, input });
}
</script>

<template>
  <NModal :show="show" preset="card" :title="connection ? '管理 OpenAI 连接' : '连接 OpenAI'" class="provider-modal" :mask-closable="!disabled && !saving" :closable="!disabled && !saving" @update:show="close">
    <p class="dialog-intro">填写一次 API Key，统一用于分镜推理、图片生成与配音。</p>
    <div class="openai-capabilities" aria-label="OpenAI 连接包含的能力">
      <NTag size="small" :bordered="false">分镜与审核</NTag>
      <NTag size="small" :bordered="false">图片生成</NTag>
      <NTag size="small" :bordered="false">语音配音</NTag>
    </div>
    <NForm @submit.prevent="save">
      <NFormItem :label="connection?.hasKey ? 'API Key（留空保留已保存值）' : 'OpenAI API Key'">
        <NInput v-model:value="key" type="password" show-password-on="click" :maxlength="8192" :disabled="disabled || saving" :input-props="{ autocomplete: 'new-password', 'aria-label': 'OpenAI API Key' }" :placeholder="connection?.hasKey ? '输入新 Key 可同时更新这三项能力' : '填写 OpenAI 平台的 API Key'" />
      </NFormItem>
      <p class="form-note">Key 保存在本机服务，保存后不回显。服务地址使用 OpenAI 官方地址。</p>
      <NCollapse v-model:expanded-names="expanded" class="openai-advanced">
        <NCollapseItem title="模型与高级设置" name="models">
          <NFormItem label="连接名称">
            <NInput v-model:value="label" :maxlength="100" :disabled="disabled || saving" :input-props="{ 'aria-label': 'OpenAI 连接名称' }" />
          </NFormItem>
          <NFormItem v-for="field in modelFields" :key="field.key" :label="field.label">
            <NSelect :value="models[field.key]" :options="modelOptions[field.key]" filterable tag :disabled="disabled || saving" :aria-label="field.label" :input-props="{ 'aria-label': field.label }" placeholder="选择模型，或输入实际可用的模型 ID" @update:value="value => updateModel(field.key, value)" />
          </NFormItem>
          <p class="form-note">已预填对应能力的模型。可按账号权限调整；实际可用性以请求结果为准。</p>
          <NAlert type="info" :show-icon="false" class="draft-alert">当前 OpenAI 配音模型计划于 {{ OPENAI_SPEECH_SHUTDOWN_DATE }} 停服，届时需要更新应用的配音接口。</NAlert>
          <p class="openai-endpoint"><span class="muted small">官方服务地址</span><code>{{ OPENAI_BASE_URL }}</code></p>
        </NCollapseItem>
      </NCollapse>
      <NAlert v-if="error" type="error" :show-icon="false" class="draft-alert">{{ error }}</NAlert>
      <p class="panel-footnote">保存只更新连接配置，不会调用模型。已有任务继续使用提交时的配置。</p>
      <div class="dialog-actions">
        <NButton :disabled="disabled || saving" @click="close()">取消</NButton>
        <NButton type="primary" attr-type="submit" :loading="saving" :disabled="disabled || saving || !valid">保存 OpenAI 连接</NButton>
      </div>
    </NForm>
  </NModal>
</template>

<style scoped>
.openai-capabilities { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 20px; }
.openai-advanced { margin: 22px 0; }
.openai-endpoint { display: flex; flex-direction: column; gap: 6px; margin: 18px 0 0; }
.openai-endpoint code { overflow-wrap: anywhere; }
</style>
