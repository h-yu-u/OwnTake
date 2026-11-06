<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NAlert, NButton, NForm, NFormItem, NInput, NInputNumber, NModal, NSelect, NTag } from 'naive-ui';
import type { ProviderInputMode, ProviderKind, ProviderSummary, Ratio } from '../types.ts';
import type { ProviderInput } from '../lib/providerApi.ts';
import { inputModeOptions, parseDurationChoices, ratioOptions } from '../lib/generation.ts';
import AppIcon from './AppIcon.vue';

const props = defineProps<{ providers: ProviderSummary[]; disabled: boolean }>();
const emit = defineEmits<{ save: [input: { id: string | null; profile: ProviderInput }]; refresh: [] }>();
const show = ref(false);
const editing = ref<ProviderSummary | null>(null);
const connectionForm = ref({ label: '', kind: 'chat-completions' as ProviderKind, baseUrl: 'https://api.openai.com/v1', model: '', key: '', maxOutputTokens: 4096, timeoutMs: 60000,
  inputModes: ['text'] as ProviderInputMode[], ratios: [] as Ratio[], durationChoices: '', maxReferences: 0 });
const kinds = [{ label: '分镜推理 · Chat Completions', value: 'chat-completions' }, { label: '图片生成 · OpenAI Images', value: 'openai-images' }, { label: '视频生成 · Ark', value: 'ark-video' }];
const kindLabel = (kind: ProviderKind) => kind === 'chat-completions' ? '分镜推理' : kind === 'openai-images' ? '图片生成' : '视频生成';
const requiresNewKey = computed(() => { try { return Boolean(editing.value?.hasKey && new URL(editing.value.baseUrl).origin !== new URL(connectionForm.value.baseUrl).origin); } catch { return false; } });
const durations = computed(() => parseDurationChoices(connectionForm.value.durationChoices));
const valid = computed(() => {
  const value = connectionForm.value;
  try {
    const url = new URL(value.baseUrl);
    const capabilityValid = value.kind === 'chat-completions' || (value.ratios.length > 0 && value.inputModes.length > 0 && value.maxReferences >= 0 && value.maxReferences <= 20 && (value.kind !== 'ark-video' || Boolean(durations.value?.length)));
    return Boolean(value.label.trim() && value.model.trim() && ['http:', 'https:'].includes(url.protocol) && (!requiresNewKey.value || value.key.trim()) && value.maxOutputTokens >= 1 && value.maxOutputTokens <= 8192 && value.timeoutMs >= 1000 && value.timeoutMs <= 120000 && capabilityValid);
  } catch { return false; }
});
function open(provider: ProviderSummary | null) {
  editing.value = provider;
  connectionForm.value = { label: provider?.label || '', kind: provider?.kind || 'chat-completions', baseUrl: provider?.baseUrl || 'https://api.openai.com/v1', model: provider?.model || '', key: '', maxOutputTokens: provider?.maxOutputTokens || 4096, timeoutMs: provider?.timeoutMs || 60000,
    inputModes: [...provider?.capabilities.inputModes || ['text']], ratios: [...provider?.capabilities.ratios || []], durationChoices: provider?.capabilities.durationsSec.join(', ') || '', maxReferences: provider?.capabilities.maxReferences || 0 };
  show.value = true;
}
function changeKind(kind: ProviderKind) {
  const value = connectionForm.value;
  const knownDefaults = ['https://api.openai.com/v1', 'https://ark.cn-beijing.volces.com/api/v3'];
  connectionForm.value = { ...value, kind, model: '',
    baseUrl: knownDefaults.includes(value.baseUrl) ? kind === 'ark-video' ? knownDefaults[1]! : knownDefaults[0]! : value.baseUrl,
    inputModes: ['text'], ratios: kind === 'chat-completions' ? [] : ['16:9'], durationChoices: kind === 'ark-video' ? '5' : '', maxReferences: 0 };
}
watch(() => props.providers, () => { if (show.value) { show.value = false; connectionForm.value.key = ''; } });
watch(show, value => { if (!value) connectionForm.value.key = ''; });
function save() {
  if (!valid.value || props.disabled) return;
  const value = connectionForm.value;
  const capabilities = value.kind === 'chat-completions' ? { inputModes: ['text'] as ProviderInputMode[], ratios: [], durationsSec: [], maxReferences: 0 }
    : { inputModes: value.kind === 'openai-images' ? ['text'] as ProviderInputMode[] : [...value.inputModes], ratios: [...value.ratios], durationsSec: value.kind === 'ark-video' ? durations.value! : [], maxReferences: value.kind === 'openai-images' ? 0 : value.maxReferences };
  emit('save', { id: editing.value?.id || null, profile: { label: value.label.trim(), kind: value.kind, baseUrl: value.baseUrl.trim(), model: value.model.trim(), capabilities, maxOutputTokens: value.maxOutputTokens, timeoutMs: value.timeoutMs, ...(value.key.trim() ? { key: value.key.trim() } : {}) } });
}
</script>

<template>
  <section class="panel provider-settings">
    <div class="panel-heading"><div><h2>模型连接与能力声明</h2><p class="subheading">为分镜推理、图片和视频分别配置连接，按任务所需能力选择。</p></div><div class="heading-line"><NButton text size="small" :disabled="disabled" @click="emit('refresh')">刷新</NButton><NButton :disabled="disabled" @click="open(null)"><template #icon><AppIcon name="plus" :size="16" /></template>添加连接</NButton></div></div>
    <p v-if="!providers.length" class="draft-empty">手工分镜与导入素材始终可用。配置连接后，可审阅并提交相应的推理或生成请求。</p>
    <div v-else class="provider-list"><article v-for="provider in providers" :key="provider.id" class="provider-row"><div class="provider-symbol"><AppIcon :name="provider.kind === 'chat-completions' ? 'storyboard' : provider.kind === 'openai-images' ? 'image' : 'film'" :size="22" /></div><div class="provider-copy"><div class="heading-line"><strong>{{ provider.label }}</strong><NTag size="small" :bordered="false">{{ kindLabel(provider.kind) }}</NTag><NTag size="small" :bordered="false" type="warning">尚未实接验证</NTag><NTag size="small" :bordered="false" :type="provider.hasKey ? 'success' : 'default'">{{ provider.hasKey ? '已保存密钥' : '未配置密钥' }}</NTag></div><p>{{ provider.model }} · {{ provider.timeoutMs / 1000 }} 秒请求超时<span v-if="provider.kind === 'chat-completions'"> · 最多 {{ provider.maxOutputTokens }} 输出 tokens</span></p><p v-if="provider.kind !== 'chat-completions'">声明：{{ provider.capabilities.inputModes.map(mode => inputModeOptions.find(option => option.value === mode)?.label).join(' / ') }} · {{ provider.capabilities.ratios.join(' / ') }}<span v-if="provider.capabilities.durationsSec.length"> · {{ provider.capabilities.durationsSec.join(' / ') }} 秒</span></p><code>{{ provider.baseUrl }}</code></div><NButton size="small" :disabled="disabled" @click="open(provider)">编辑</NButton></article></div>
    <p class="panel-footnote">保存连接不会发起付费请求。能力由你声明，实际端点、模型权限与结果需通过真实使用核验。</p>
    <NModal v-model:show="show" preset="card" :title="editing ? '编辑模型连接' : '添加模型连接'" class="provider-modal" :mask-closable="!disabled" :closable="!disabled">
      <NForm @submit.prevent="save">
        <NFormItem label="连接类型"><NSelect :value="connectionForm.kind" :options="kinds" :disabled="disabled" @update:value="changeKind" /></NFormItem>
        <NFormItem label="连接名称"><NInput v-model:value="connectionForm.label" :maxlength="100" :disabled="disabled" placeholder="给这个模型连接起一个便于辨认的名字" /></NFormItem>
        <NFormItem label="服务地址（Base URL）"><NInput v-model:value="connectionForm.baseUrl" :disabled="disabled" /></NFormItem>
        <NFormItem label="模型名称"><NInput v-model:value="connectionForm.model" :disabled="disabled" placeholder="填写服务实际提供的模型 ID" /></NFormItem>
        <NFormItem :label="editing?.hasKey ? 'API Key（留空保留已保存值）' : 'API Key（本地兼容服务可留空）'"><NInput v-model:value="connectionForm.key" type="password" show-password-on="click" :disabled="disabled" :input-props="{ autocomplete: 'new-password' }" placeholder="密钥保存在本地服务，不会回显" /></NFormItem>
        <div class="shot-form-row"><NFormItem v-if="connectionForm.kind === 'chat-completions'" label="最大输出 tokens"><NInputNumber v-model:value="connectionForm.maxOutputTokens" :min="1" :max="8192" :precision="0" :disabled="disabled" /></NFormItem><NFormItem label="单次 HTTP 超时（秒）"><NInputNumber :value="connectionForm.timeoutMs / 1000" :min="1" :max="120" :precision="0" :disabled="disabled" @update:value="value => { if (value !== null) connectionForm.timeoutMs = value * 1000; }" /></NFormItem></div>
        <template v-if="connectionForm.kind !== 'chat-completions'">
          <h3 class="capability-heading">模型能力声明</h3>
          <NAlert v-if="connectionForm.kind === 'openai-images'" type="info" :show-icon="false" class="draft-alert">本次图片适配器只支持纯文字生成，不支持参考图片。能力检查会明确阻止不支持的输入。</NAlert>
          <NFormItem v-if="connectionForm.kind === 'ark-video'" label="支持的输入方式"><NSelect v-model:value="connectionForm.inputModes" multiple :options="inputModeOptions" :disabled="disabled" /></NFormItem>
          <NFormItem label="支持的画幅"><NSelect v-model:value="connectionForm.ratios" multiple :options="ratioOptions" :disabled="disabled" /></NFormItem>
          <div v-if="connectionForm.kind === 'ark-video'" class="shot-form-row"><NFormItem label="支持时长（秒，逗号分隔）"><NInput v-model:value="connectionForm.durationChoices" :disabled="disabled" placeholder="例如 5, 10" /></NFormItem><NFormItem label="最多参考图片数"><NInputNumber v-model:value="connectionForm.maxReferences" :min="0" :max="20" :precision="0" :disabled="disabled" /></NFormItem></div>
          <p class="form-note">按这个模型的实际文档填写。声明会限制可提交计划，不会把未知能力自动标成可用。</p>
        </template>
        <NAlert v-if="requiresNewKey" type="warning" :show-icon="false" class="draft-alert">地址已改到另一个来源，请重新填写该服务的密钥。</NAlert>
        <div class="dialog-actions"><NButton :disabled="disabled" @click="show = false">取消</NButton><NButton type="primary" attr-type="submit" :loading="disabled" :disabled="disabled || !valid">保存连接</NButton></div>
      </NForm>
    </NModal>
  </section>
</template>
