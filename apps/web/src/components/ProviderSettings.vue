<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NAlert, NButton, NCheckbox, NForm, NFormItem, NInput, NInputNumber, NModal, NSelect, NTag } from 'naive-ui';
import type { ProviderCapabilities, ProviderInputMode, ProviderKind, ProviderSummary, Ratio } from '../types.ts';
import type { ProviderInput } from '../lib/providerApi.ts';
import { inputModeOptions, parseDurationChoices, ratioOptions } from '../lib/generation.ts';
import { parseVoiceChoices } from '../lib/studio.ts';
import AppIcon from './AppIcon.vue';

const props = defineProps<{ providers: ProviderSummary[]; disabled: boolean }>();
const emit = defineEmits<{ save: [input: { id: string | null; profile: ProviderInput }]; refresh: [] }>();
const show = ref(false);
const editing = ref<ProviderSummary | null>(null);
const connectionForm = ref({ label: '', kind: 'chat-completions' as ProviderKind, baseUrl: 'https://api.openai.com/v1', model: '', key: '', maxOutputTokens: 4096, timeoutMs: 60000,
  inputModes: ['text'] as ProviderInputMode[], ratios: [] as Ratio[], durationChoices: '', maxReferences: 0,
  frameReviewEnabled: false, frameReviewMaxImages: 3, voiceChoices: '', supportsInstructions: false, minSpeed: 0.25, maxSpeed: 4, maxInputChars: 4096 });
const kinds = [{ label: '分镜推理 / 抽帧审核 · Chat Completions', value: 'chat-completions' }, { label: '图片生成 · OpenAI Images', value: 'openai-images' }, { label: '视频生成 · Ark', value: 'ark-video' }, { label: '配音 · OpenAI Speech 兼容协议', value: 'openai-speech' }];
const kindLabel = (kind: ProviderKind) => ({ 'chat-completions': '分镜推理 / 审核', 'openai-images': '图片生成', 'ark-video': '视频生成', 'openai-speech': '配音' })[kind];
const requiresNewKey = computed(() => { try { return Boolean(editing.value?.hasKey && new URL(editing.value.baseUrl).origin !== new URL(connectionForm.value.baseUrl).origin); } catch { return false; } });
const durations = computed(() => parseDurationChoices(connectionForm.value.durationChoices));
const voices = computed(() => parseVoiceChoices(connectionForm.value.voiceChoices));
const valid = computed(() => {
  const value = connectionForm.value;
  try {
    const url = new URL(value.baseUrl);
    const capabilityValid = value.kind === 'chat-completions'
      ? !value.frameReviewEnabled || Number.isInteger(value.frameReviewMaxImages) && value.frameReviewMaxImages >= 1 && value.frameReviewMaxImages <= 16
      : value.kind === 'openai-speech'
        ? voices.value.length > 0 && voices.value.length <= 100 && voices.value.every(voice => voice.length <= 128 && !/[\u0000-\u001f\u007f]/.test(voice)) && value.minSpeed >= 0.25 && value.maxSpeed >= value.minSpeed && value.maxSpeed <= 4 && Number.isInteger(value.maxInputChars) && value.maxInputChars > 0 && value.maxInputChars <= 4096
        : value.ratios.length > 0 && value.inputModes.length > 0 && value.maxReferences >= 0 && value.maxReferences <= 20 && (value.kind !== 'ark-video' || Boolean(durations.value?.length));
    return Boolean(value.label.trim() && value.model.trim() && ['http:', 'https:'].includes(url.protocol) && (!requiresNewKey.value || value.key.trim()) && value.maxOutputTokens >= 1 && value.maxOutputTokens <= 8192 && value.timeoutMs >= 1000 && value.timeoutMs <= 120000 && capabilityValid);
  } catch { return false; }
});
function open(provider: ProviderSummary | null) {
  editing.value = provider;
  connectionForm.value = { label: provider?.label || '', kind: provider?.kind || 'chat-completions', baseUrl: provider?.baseUrl || 'https://api.openai.com/v1', model: provider?.model || '', key: '', maxOutputTokens: provider?.maxOutputTokens || 4096, timeoutMs: provider?.timeoutMs || 60000,
    inputModes: [...provider?.capabilities.inputModes || ['text']], ratios: [...provider?.capabilities.ratios || []], durationChoices: provider?.capabilities.durationsSec.join(', ') || '', maxReferences: provider?.capabilities.maxReferences || 0,
    frameReviewEnabled: Boolean(provider?.capabilities.frameReview), frameReviewMaxImages: provider?.capabilities.frameReview?.maxImages ?? 3,
    voiceChoices: provider?.capabilities.speech?.voices.join(', ') || '', supportsInstructions: provider?.capabilities.speech?.supportsInstructions ?? false,
    minSpeed: provider?.capabilities.speech?.minSpeed ?? 0.25, maxSpeed: provider?.capabilities.speech?.maxSpeed ?? 4, maxInputChars: provider?.capabilities.speech?.maxInputChars ?? 4096 };
  show.value = true;
}
function changeKind(kind: ProviderKind) {
  const value = connectionForm.value;
  const knownDefaults = ['https://api.openai.com/v1', 'https://ark.cn-beijing.volces.com/api/v3'];
  connectionForm.value = { ...value, kind, model: '',
    baseUrl: knownDefaults.includes(value.baseUrl) ? kind === 'ark-video' ? knownDefaults[1]! : knownDefaults[0]! : value.baseUrl,
    inputModes: ['text'], ratios: ['chat-completions', 'openai-speech'].includes(kind) ? [] : ['16:9'], durationChoices: kind === 'ark-video' ? '5' : '', maxReferences: 0, frameReviewEnabled: false };
}
watch(() => props.providers, () => { if (show.value) { show.value = false; connectionForm.value.key = ''; } });
watch(show, value => { if (!value) connectionForm.value.key = ''; });
function save() {
  if (!valid.value || props.disabled) return;
  const value = connectionForm.value;
  const capabilities: ProviderCapabilities = ['chat-completions', 'openai-speech'].includes(value.kind)
    ? { inputModes: ['text'], ratios: [], durationsSec: [], maxReferences: 0 }
    : { inputModes: value.kind === 'openai-images' ? ['text'] : [...value.inputModes], ratios: [...value.ratios], durationsSec: value.kind === 'ark-video' ? durations.value! : [], maxReferences: value.kind === 'openai-images' ? 0 : value.maxReferences };
  if (value.kind === 'chat-completions' && value.frameReviewEnabled) capabilities.frameReview = { maxImages: value.frameReviewMaxImages };
  if (value.kind === 'openai-speech') capabilities.speech = { voices: voices.value, supportsInstructions: value.supportsInstructions, minSpeed: value.minSpeed, maxSpeed: value.maxSpeed, maxInputChars: value.maxInputChars };
  emit('save', { id: editing.value?.id || null, profile: { label: value.label.trim(), kind: value.kind, baseUrl: value.baseUrl.trim(), model: value.model.trim(), capabilities, maxOutputTokens: value.maxOutputTokens, timeoutMs: value.timeoutMs, ...(value.key.trim() ? { key: value.key.trim() } : {}) } });
}
</script>

<template>
  <section class="panel provider-settings">
    <div class="panel-heading"><div><h2>模型连接与能力声明</h2><p class="subheading">按推理、图片、视频、配音与抽样审核所需的能力配置连接。</p></div><div class="heading-line"><NButton text size="small" :disabled="disabled" @click="emit('refresh')">刷新</NButton><NButton :disabled="disabled" @click="open(null)"><template #icon><AppIcon name="plus" :size="16" /></template>添加连接</NButton></div></div>
    <p v-if="!providers.length" class="draft-empty">手工分镜与导入素材始终可用。配置连接后，可审阅并提交相应请求。</p>
    <div v-else class="provider-list"><article v-for="provider in providers" :key="provider.id" class="provider-row"><div class="provider-symbol"><AppIcon :name="provider.kind === 'chat-completions' ? 'storyboard' : provider.kind === 'openai-images' ? 'image' : provider.kind === 'openai-speech' ? 'audio' : 'film'" :size="22" /></div><div class="provider-copy"><div class="heading-line"><strong>{{ provider.label }}</strong><NTag size="small" :bordered="false">{{ kindLabel(provider.kind) }}</NTag><NTag size="small" :bordered="false" type="warning">尚未实接验证</NTag><NTag size="small" :bordered="false" :type="provider.hasKey ? 'success' : 'default'">{{ provider.hasKey ? '已保存密钥' : '未配置密钥' }}</NTag></div><p>{{ provider.model }} · {{ provider.timeoutMs / 1000 }} 秒请求超时<span v-if="provider.kind === 'chat-completions'"> · 最多 {{ provider.maxOutputTokens }} 输出 tokens</span></p><p v-if="provider.capabilities.speech">声明：{{ provider.capabilities.speech.voices.join(' / ') }} · {{ provider.capabilities.speech.minSpeed }}–{{ provider.capabilities.speech.maxSpeed }} 倍速 · 最多 {{ provider.capabilities.speech.maxInputChars }} 字符 · WAV</p><p v-if="provider.capabilities.frameReview">声明：可读图片并返回严格 JSON 结构，最多 {{ provider.capabilities.frameReview.maxImages }} 帧</p><p v-if="provider.kind === 'openai-images' || provider.kind === 'ark-video'">声明：{{ provider.capabilities.inputModes.map(mode => inputModeOptions.find(option => option.value === mode)?.label).join(' / ') }} · {{ provider.capabilities.ratios.join(' / ') }}<span v-if="provider.capabilities.durationsSec.length"> · {{ provider.capabilities.durationsSec.join(' / ') }} 秒</span></p><code>{{ provider.baseUrl }}</code></div><NButton size="small" :disabled="disabled" @click="open(provider)">编辑</NButton></article></div>
    <p class="panel-footnote">保存连接不会发起付费请求。能力由你声明，实际端点、模型权限、模型有效期与结果需通过真实使用核验。</p>
    <NModal v-model:show="show" preset="card" :title="editing ? '编辑模型连接' : '添加模型连接'" class="provider-modal" :mask-closable="!disabled" :closable="!disabled">
      <NForm @submit.prevent="save">
        <NFormItem label="连接类型"><NSelect aria-label="连接类型" :input-props="{ 'aria-label': '连接类型' }" :value="connectionForm.kind" :options="kinds" :disabled="disabled" @update:value="changeKind" /></NFormItem>
        <NFormItem label="连接名称"><NInput :input-props="{ 'aria-label': '连接名称' }" v-model:value="connectionForm.label" :maxlength="100" :disabled="disabled" placeholder="给这个模型连接起一个便于辨认的名字" /></NFormItem>
        <NFormItem label="服务地址（Base URL）"><NInput :input-props="{ 'aria-label': '服务地址（Base URL）' }" v-model:value="connectionForm.baseUrl" :disabled="disabled" /></NFormItem>
        <NFormItem label="模型名称"><NInput :input-props="{ 'aria-label': '模型名称' }" v-model:value="connectionForm.model" :maxlength="200" :disabled="disabled" placeholder="填写服务实际提供的模型 ID" /></NFormItem>
        <NFormItem :label="editing?.hasKey ? 'API Key（留空保留已保存值）' : 'API Key（本地兼容服务可留空）'"><NInput v-model:value="connectionForm.key" type="password" show-password-on="click" :disabled="disabled" :input-props="{ autocomplete: 'new-password', 'aria-label': 'API Key' }" placeholder="密钥保存在本地服务，不会回显" /></NFormItem>
        <div class="shot-form-row"><NFormItem v-if="connectionForm.kind === 'chat-completions'" label="最大输出 tokens"><NInputNumber :input-props="{ 'aria-label': '最大输出 tokens' }" v-model:value="connectionForm.maxOutputTokens" :min="1" :max="8192" :precision="0" :disabled="disabled" /></NFormItem><NFormItem label="单次 HTTP 超时（秒）"><NInputNumber :input-props="{ 'aria-label': '单次 HTTP 超时（秒）' }" :value="connectionForm.timeoutMs / 1000" :min="1" :max="120" :precision="0" :disabled="disabled" @update:value="value => { if (value !== null) connectionForm.timeoutMs = value * 1000; }" /></NFormItem></div>
        <template v-if="connectionForm.kind === 'chat-completions'">
          <h3 class="capability-heading">可选抽样帧审核</h3>
          <NCheckbox v-model:checked="connectionForm.frameReviewEnabled" :disabled="disabled">此模型支持图片输入与严格 JSON Schema 输出</NCheckbox>
          <NFormItem v-if="connectionForm.frameReviewEnabled" label="一次最多接收几张图片"><NInputNumber :input-props="{ 'aria-label': '一次最多接收几张图片' }" v-model:value="connectionForm.frameReviewMaxImages" :min="1" :max="16" :precision="0" :disabled="disabled" /></NFormItem>
          <p class="form-note">图片审核发送 1 张图；视频审核固定发送 10%、50%、90% 位置的 3 帧。模型上限不足时会阻止请求，不会减少采样后声称完成视频审核。</p>
        </template>
        <template v-else-if="connectionForm.kind === 'openai-speech'">
          <h3 class="capability-heading">语音能力声明</h3>
          <NFormItem label="支持的声音 ID（逗号或换行分隔）"><NInput :input-props="{ 'aria-label': '支持的声音 ID（逗号或换行分隔）' }" v-model:value="connectionForm.voiceChoices" type="textarea" :rows="2" :disabled="disabled" placeholder="填写该模型实际提供的声音 ID" /></NFormItem>
          <div class="shot-form-row"><NFormItem label="最低语速（倍）"><NInputNumber :input-props="{ 'aria-label': '最低语速（倍）' }" v-model:value="connectionForm.minSpeed" :min="0.25" :max="4" :precision="2" :step="0.25" :disabled="disabled" /></NFormItem><NFormItem label="最高语速（倍）"><NInputNumber :input-props="{ 'aria-label': '最高语速（倍）' }" v-model:value="connectionForm.maxSpeed" :min="0.25" :max="4" :precision="2" :step="0.25" :disabled="disabled" /></NFormItem></div>
          <NFormItem label="单次文字上限（字符）"><NInputNumber :input-props="{ 'aria-label': '单次文字上限（字符）' }" v-model:value="connectionForm.maxInputChars" :min="1" :max="4096" :precision="0" :disabled="disabled" /></NFormItem>
          <NCheckbox v-model:checked="connectionForm.supportsInstructions" :disabled="disabled">此模型支持单独的语气与风格指令</NCheckbox>
          <p class="form-note">本适配器使用 Speech 兼容协议，请求完整 WAV 文件。按实际模型文档填写能力；仅填写一个模型名称不会验证服务、订阅或模型是否仍有效。</p>
        </template>
        <template v-else>
          <h3 class="capability-heading">模型能力声明</h3>
          <NAlert v-if="connectionForm.kind === 'openai-images'" type="info" :show-icon="false" class="draft-alert">本次图片适配器只支持纯文字生成，不支持参考图片。能力检查会明确阻止不支持的输入。</NAlert>
          <NFormItem v-if="connectionForm.kind === 'ark-video'" label="支持的输入方式"><NSelect aria-label="支持的输入方式" :input-props="{ 'aria-label': '支持的输入方式' }" v-model:value="connectionForm.inputModes" multiple :options="inputModeOptions" :disabled="disabled" /></NFormItem>
          <NFormItem label="支持的画幅"><NSelect aria-label="支持的画幅" :input-props="{ 'aria-label': '支持的画幅' }" v-model:value="connectionForm.ratios" multiple :options="ratioOptions" :disabled="disabled" /></NFormItem>
          <div v-if="connectionForm.kind === 'ark-video'" class="shot-form-row"><NFormItem label="支持时长（秒，逗号分隔）"><NInput :input-props="{ 'aria-label': '支持时长（秒，逗号分隔）' }" v-model:value="connectionForm.durationChoices" :disabled="disabled" placeholder="例如 5, 10" /></NFormItem><NFormItem label="最多参考图片数"><NInputNumber :input-props="{ 'aria-label': '最多参考图片数' }" v-model:value="connectionForm.maxReferences" :min="0" :max="20" :precision="0" :disabled="disabled" /></NFormItem></div>
          <p class="form-note">按这个模型的实际文档填写。声明会限制可提交计划，不会把未知能力自动标成可用。</p>
        </template>
        <NAlert v-if="requiresNewKey" type="warning" :show-icon="false" class="draft-alert">地址已改到另一个来源，请重新填写该服务的密钥。</NAlert>
        <div class="dialog-actions"><NButton :disabled="disabled" @click="show = false">取消</NButton><NButton type="primary" attr-type="submit" :loading="disabled" :disabled="disabled || !valid">保存连接</NButton></div>
      </NForm>
    </NModal>
  </section>
</template>
