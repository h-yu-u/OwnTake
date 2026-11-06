<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NAlert, NButton, NForm, NFormItem, NInput, NInputNumber, NModal, NTag } from 'naive-ui';
import type { ProviderSummary } from '../types.ts';
import type { ProviderInput } from '../lib/providerApi.ts';
import AppIcon from './AppIcon.vue';

const props = defineProps<{ providers: ProviderSummary[]; disabled: boolean }>();
const emit = defineEmits<{ save: [input: { id: string | null; profile: ProviderInput }]; refresh: [] }>();
const show = ref(false);
const editing = ref<ProviderSummary | null>(null);
const connectionForm = ref({ label: '', baseUrl: 'https://api.openai.com/v1', model: '', key: '', maxOutputTokens: 4096, timeoutMs: 60000 });
const connections = computed(() => props.providers.filter(provider => provider.kind === 'chat-completions'));
const requiresNewKey = computed(() => { try { return Boolean(editing.value?.hasKey && new URL(editing.value.baseUrl).origin !== new URL(connectionForm.value.baseUrl).origin); } catch { return false; } });
const valid = computed(() => {
  try { const url = new URL(connectionForm.value.baseUrl); return Boolean(connectionForm.value.label.trim() && connectionForm.value.model.trim() && ['http:', 'https:'].includes(url.protocol) && (!requiresNewKey.value || connectionForm.value.key.trim()) && connectionForm.value.maxOutputTokens >= 1 && connectionForm.value.maxOutputTokens <= 8192 && connectionForm.value.timeoutMs >= 1000 && connectionForm.value.timeoutMs <= 120000); }
  catch { return false; }
});
function open(provider: ProviderSummary | null) {
  editing.value = provider;
  Object.assign(connectionForm.value, { label: provider?.label || '', baseUrl: provider?.baseUrl || 'https://api.openai.com/v1', model: provider?.model || '', key: '', maxOutputTokens: provider?.maxOutputTokens || 4096, timeoutMs: provider?.timeoutMs || 60000 });
  show.value = true;
}
watch(() => props.providers, () => { if (show.value && props.providers !== undefined) { show.value = false; connectionForm.value.key = ''; } });
watch(show, value => { if (!value) connectionForm.value.key = ''; });
function save() {
  if (!valid.value || props.disabled) return;
  emit('save', { id: editing.value?.id || null, profile: { label: connectionForm.value.label.trim(), kind: 'chat-completions', baseUrl: connectionForm.value.baseUrl.trim(), model: connectionForm.value.model.trim(), capabilities: { inputModes: ['text'], ratios: [], durationsSec: [], maxReferences: 0 }, maxOutputTokens: connectionForm.value.maxOutputTokens, timeoutMs: connectionForm.value.timeoutMs, ...(connectionForm.value.key.trim() ? { key: connectionForm.value.key.trim() } : {}) } });
}
</script>

<template>
  <section class="panel provider-settings"><div class="panel-heading"><div><h2>推理模型连接</h2><p class="subheading">使用兼容 Chat Completions 的服务，或你在本机运行的模型。</p></div><div class="heading-line"><NButton text size="small" :disabled="disabled" @click="emit('refresh')">刷新</NButton><NButton :disabled="disabled" @click="open(null)"><template #icon><AppIcon name="plus" :size="16" /></template>添加连接</NButton></div></div><p v-if="!connections.length" class="draft-empty">无需配置模型也能手工创建分镜。添加连接后，可把简报和当前分镜发送给模型，得到待审阅的修改草稿。</p><div v-else class="provider-list"><article v-for="provider in connections" :key="provider.id" class="provider-row"><div class="provider-symbol"><AppIcon name="storyboard" :size="22" /></div><div class="provider-copy"><div class="heading-line"><strong>{{ provider.label }}</strong><NTag size="small" :bordered="false">尚未验证</NTag><NTag size="small" :bordered="false" :type="provider.hasKey ? 'success' : 'default'">{{ provider.hasKey ? '已保存密钥' : '未配置密钥' }}</NTag></div><p>{{ provider.model }} · 最多 {{ provider.maxOutputTokens }} 输出 tokens · {{ provider.timeoutMs / 1000 }} 秒超时</p><code>{{ provider.baseUrl }}</code></div><NButton size="small" :disabled="disabled" @click="open(provider)">编辑</NButton></article></div><p class="panel-footnote">连接参数由你填写。保存连接不会发起推理请求，也不代表供应商或模型已经验证可用。</p><NModal v-model:show="show" preset="card" :title="editing ? '编辑推理连接' : '添加推理连接'" class="provider-modal" :mask-closable="!disabled" :closable="!disabled"><NForm @submit.prevent="save"><NFormItem label="连接名称"><NInput v-model:value="connectionForm.label" :maxlength="100" :disabled="disabled" placeholder="例如：本机推理模型" /></NFormItem><NFormItem label="服务地址（Base URL）"><NInput v-model:value="connectionForm.baseUrl" :disabled="disabled" placeholder="https://api.openai.com/v1" /></NFormItem><NFormItem label="模型名称"><NInput v-model:value="connectionForm.model" :disabled="disabled" placeholder="填写服务实际提供的模型 ID" /></NFormItem><NFormItem :label="editing?.hasKey ? 'API Key（留空保留已保存值）' : 'API Key（本地模型可留空）'"><NInput v-model:value="connectionForm.key" type="password" show-password-on="click" :disabled="disabled" :input-props="{ autocomplete: 'new-password' }" placeholder="密钥保存在本地服务，不会回显" /></NFormItem><div class="shot-form-row"><NFormItem label="最大输出 tokens"><NInputNumber v-model:value="connectionForm.maxOutputTokens" :min="1" :max="8192" :precision="0" :disabled="disabled" /></NFormItem><NFormItem label="请求超时（秒）"><NInputNumber :value="connectionForm.timeoutMs / 1000" :min="1" :max="120" :precision="0" :disabled="disabled" @update:value="value => { if (value !== null) connectionForm.timeoutMs = value * 1000; }" /></NFormItem></div><NAlert v-if="requiresNewKey" type="warning" :show-icon="false" class="draft-alert">服务地址已改到另一个来源。请重新填写该服务的密钥，原连接密钥不会被转交到新地址。</NAlert><NAlert type="info" :show-icon="false" class="draft-alert">每次分镜推理最多提交一次请求。返回的内容先成为草稿，只有你接受的操作才会写入项目。</NAlert><div class="dialog-actions"><NButton :disabled="disabled" @click="show = false">取消</NButton><NButton type="primary" attr-type="submit" :loading="disabled" :disabled="disabled || !valid">保存连接</NButton></div></NForm></NModal></section>
</template>
