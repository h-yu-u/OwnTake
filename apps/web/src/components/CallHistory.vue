<script setup lang="ts">
import { computed, ref } from 'vue';
import { NAlert, NButton, NForm, NFormItem, NInput, NInputNumber, NModal, NTag } from 'naive-ui';
import type { CallRecord, CallStatus, ProviderSummary, Reservation } from '../types.ts';
import { formatDate } from '../lib/timeline.ts';
const props = defineProps<{ calls: CallRecord[]; providers: ProviderSummary[]; disabled: boolean }>();
const emit = defineEmits<{ refresh: []; settle: [input: { id: string; actualAmount: number; currency: Reservation['currency']; note: string }] }>();
const sorted = computed(() => [...props.calls].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
const labels: Record<CallStatus, string> = { queued: '等待提交', submitting: '正在请求', submission_unknown: '响应不明 · 待核对', succeeded: '草稿已生成', failed: '调用失败' };
const selected = ref<CallRecord | null>(null);
const amount = ref(0);
const note = ref('');
function reconcile(call: CallRecord) { selected.value = call; amount.value = call.actualAmount ?? call.reservedAmount; note.value = ''; }
function settle() { if (selected.value && Number.isFinite(amount.value) && amount.value >= 0 && note.value.trim()) emit('settle', { id: selected.value.id, actualAmount: amount.value, currency: selected.value.currency, note: note.value.trim() }); }
function isSettled(call: CallRecord) { const next = props.calls.find(item => item.id === call.id); return next?.actualAmount !== call.actualAmount || next?.updatedAt !== call.updatedAt; }
</script>

<template>
  <section class="panel call-history"><div class="panel-heading"><h2>推理调用记录</h2><NButton text size="small" :disabled="disabled" @click="emit('refresh')">刷新记录</NButton></div><p v-if="!sorted.length" class="draft-empty">尚未发起推理请求。每次请求都会保留状态和草稿结果。</p><div v-for="call in sorted" :key="call.id" class="call-row"><div class="call-main"><div class="heading-line"><strong>{{ providers.find(provider => provider.id === call.providerId)?.label || '推理连接' }}</strong><NTag size="small" :bordered="false" :type="call.status === 'succeeded' ? 'success' : call.status === 'failed' ? 'error' : 'warning'">{{ labels[call.status] }}</NTag></div><p>{{ formatDate(call.createdAt) }}<template v-if="call.budgetMode !== 'none'"> · {{ call.actualAmount === null ? '仍保留预留' : '已人工核对' }} {{ (call.actualAmount ?? call.reservedAmount).toFixed(4) }} {{ call.currency }}</template></p><p v-if="call.error" class="call-error">{{ call.error.message }} <span class="mono">{{ call.error.code }}</span></p><p v-if="call.status === 'submission_unknown'" class="call-unknown">请在供应商侧核对请求与账单。刷新只读取本地状态，不会再次提交这次请求。</p></div><NButton v-if="call.budgetMode !== 'none' && ['succeeded', 'failed', 'submission_unknown'].includes(call.status)" size="small" :disabled="disabled" @click="reconcile(call)">核对费用</NButton></div><NModal :show="Boolean(selected) && !isSettled(selected!)" preset="card" title="记录账单核对结果" class="provider-modal" :mask-closable="!disabled" :closable="!disabled" @update:show="value => { if (!value) selected = null; }"><template v-if="selected"><NAlert type="info" :show-icon="false" class="draft-alert">请对照供应商记录填写实际费用。这里不会推断账单，也不会再次提交模型请求。</NAlert><NForm @submit.prevent="settle"><NFormItem :label="`实际费用（${selected.currency}）`"><NInputNumber v-model:value="amount" :min="0" :precision="4" :step="0.1" :disabled="disabled" /></NFormItem><NFormItem label="核对说明"><NInput v-model:value="note" type="textarea" :maxlength="1000" :rows="3" :disabled="disabled" placeholder="例如：已在供应商控制台确认本次费用；或本地服务未收费" /></NFormItem><div class="dialog-actions"><NButton :disabled="disabled" @click="selected = null">取消</NButton><NButton type="primary" attr-type="submit" :loading="disabled" :disabled="disabled || amount < 0 || !note.trim()">记录实际费用</NButton></div></NForm></template></NModal></section>
</template>
