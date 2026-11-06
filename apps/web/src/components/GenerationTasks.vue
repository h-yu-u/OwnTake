<script setup lang="ts">
import { computed, ref } from 'vue';
import { NAlert, NButton, NCheckbox, NCollapse, NCollapseItem, NForm, NFormItem, NInput, NInputNumber, NModal, NTag } from 'naive-ui';
import type { Artifact, GenerationRecord, ProviderSummary, Reservation, Shot } from '../types.ts';
import { artifactUrl } from '../lib/api.ts';
import { generationLabels, generationTone, inputModeOptions } from '../lib/generation.ts';
import { formatDate } from '../lib/timeline.ts';
import AppIcon from './AppIcon.vue';
const props = defineProps<{ records: GenerationRecord[]; providers: ProviderSummary[]; shots: Shot[]; artifacts: Artifact[]; disabled: boolean; error: string }>();
const emit = defineEmits<{ refresh: []; candidate: [shotId: string]; cancel: [id: string]; polling: [input: { id: string; paused: boolean }]; retry: [id: string]; reconcile: [input: { id: string; remoteTaskId: string; note: string }]; settle: [input: { id: string; actualAmount: number; currency: Reservation['currency']; note: string }] }>();
const sorted = computed(() => [...props.records].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
const selected = ref<GenerationRecord | null>(null);
const action = ref<'reconcile' | 'settle'>('reconcile');
const remoteTaskId = ref('');
const actualAmount = ref(0);
const note = ref('');
const confirmed = ref(false);
const current = computed(() => props.records.find(record => record.id === selected.value?.id));
const showDialog = computed(() => Boolean(selected.value && current.value?.updatedAt === selected.value.updatedAt));
function open(record: GenerationRecord, operation: 'reconcile' | 'settle') { selected.value = record; action.value = operation; remoteTaskId.value = record.remoteTaskId || ''; actualAmount.value = record.actualAmount ?? record.reservedAmount; note.value = ''; confirmed.value = false; }
function save() {
  if (!selected.value || props.disabled || !note.value.trim()) return;
  if (action.value === 'reconcile' && confirmed.value && remoteTaskId.value.trim()) emit('reconcile', { id: selected.value.id, remoteTaskId: remoteTaskId.value.trim(), note: note.value.trim() });
  if (action.value === 'settle' && Number.isFinite(actualAmount.value) && actualAmount.value >= 0) emit('settle', { id: selected.value.id, actualAmount: actualAmount.value, currency: selected.value.currency, note: note.value.trim() });
}
function terminal(record: GenerationRecord) { return ['succeeded', 'failed', 'cancelled'].includes(record.status); }
function canSettle(record: GenerationRecord) { return terminal(record) || ['submission_unknown', 'download_failed'].includes(record.status); }
</script>
<template>
  <section class="generation-tasks">
    <div class="section-heading"><div><p class="eyebrow">GENERATION DESK</p><h2>图片与视频生成 <span class="count">{{ records.length }}</span></h2></div><NButton size="small" :disabled="disabled" @click="emit('refresh')">刷新生成记录</NButton></div>
    <NAlert v-if="error" type="error" :show-icon="false" class="inline-alert">{{ error }}</NAlert>
    <p v-if="!records.length" class="generation-empty">在分镜中选择镜头，使用「生成候选」审阅并发起请求。后台会保存提交、查询与结果入库状态。</p>
    <div class="generation-task-list"><article v-for="record in sorted" :key="record.id" class="panel generation-task">
      <div class="generation-task-heading"><div class="job-symbol"><AppIcon :name="record.plan.kind === 'image' ? 'image' : 'film'" :size="23" /></div><div class="generation-task-title"><div class="heading-line"><h3>{{ shots.find(shot => shot.id === record.shotId)?.title || '历史镜头' }}</h3><NTag size="small" :bordered="false" :type="generationTone(record.status)">{{ generationLabels[record.status] }}</NTag><NTag v-if="record.pollingPaused && !terminal(record)" size="small" :bordered="false">查询已暂停</NTag></div><p>{{ record.providerModel }} · 视觉要求 v{{ record.visualRevision }} · {{ formatDate(record.createdAt) }}</p></div></div>
      <div class="generation-task-metadata"><span>{{ record.plan.kind === 'image' ? '图片' : '视频' }} · {{ record.plan.ratio }}<span v-if="record.plan.durationSec"> · {{ record.plan.durationSec }} 秒</span></span><span>{{ record.actualAmount === null ? '仍保留预留' : '已人工核对' }} {{ (record.actualAmount ?? record.reservedAmount).toFixed(4) }} {{ record.currency }}</span><span v-if="record.lastRemoteStatus">远端最近状态：{{ record.lastRemoteStatus }}</span></div>
      <NAlert v-if="record.status === 'submission_unknown'" type="warning" :show-icon="false" class="generation-state-note">供应商可能已受理。本地不会自动创建第二次生成请求。<span v-if="record.plan.kind === 'video'">请在同一账号核对原任务 ID，关联后只查询这个任务。</span><span v-else>请在供应商侧核对原请求与结果，未知费用继续保留预留。</span></NAlert>
      <NAlert v-if="record.status === 'download_failed'" type="warning" :show-icon="false" class="generation-state-note">{{ record.plan.kind === 'image' ? '尝试恢复本地保存的原图片回复。同步协议不能重新下载缺失的回复；没有完整文件时需核对供应商，不会重新生成。' : '原任务的结果未能完整入库。重试仅获取这次任务的原结果；链接失效或权限问题仍需要根据错误处理。' }}</NAlert>
      <p v-if="record.cancelRequested && record.status !== 'cancelled'" class="generation-cancel-note">已记录取消意图，尚未确认远端取消。任务仍可能完成并产生费用。</p>
      <p v-if="record.pollingPaused && !terminal(record)" class="generation-cancel-note">这里只暂停查询，远端任务可能继续运行。恢复查询后将读取原任务状态。</p>
      <div v-if="record.error" class="generation-error"><strong>{{ record.error.message }}</strong><span class="mono">{{ record.error.code }}</span></div>
      <div class="generation-task-actions">
        <NButton v-if="record.status === 'submission_unknown' && record.plan.kind === 'video'" size="small" :disabled="disabled" @click="open(record, 'reconcile')">关联原远端任务</NButton>
        <NButton v-if="record.status === 'download_failed'" size="small" :disabled="disabled" @click="emit('retry', record.id)">{{ record.plan.kind === 'image' ? '恢复本地接收文件' : '重试原结果下载' }}</NButton>
        <NButton v-if="record.status === 'waiting_remote' && record.remoteTaskId" size="small" :disabled="disabled" @click="emit('polling', { id: record.id, paused: !record.pollingPaused })">{{ record.pollingPaused ? '恢复查询' : '暂停查询' }}</NButton>
        <NButton v-if="['queued', 'submitting', 'waiting_remote'].includes(record.status) && !record.cancelRequested" size="small" :disabled="disabled" @click="emit('cancel', record.id)">请求取消</NButton>
        <NButton v-if="record.candidateId" size="small" :disabled="disabled" @click="emit('candidate', record.shotId)">查看并复核候选</NButton>
        <a v-if="record.artifactId" class="download-link" :href="artifactUrl(record.artifactId)" :download="artifacts.find(artifact => artifact.id === record.artifactId)?.name">下载结果</a>
        <NButton v-if="canSettle(record)" text size="small" :disabled="disabled" @click="open(record, 'settle')">核对费用</NButton>
      </div>
      <NCollapse class="generation-details"><NCollapseItem title="查看冻结输入与任务标识" :name="record.id"><dl class="generation-detail-list"><div><dt>本地记录</dt><dd><code>{{ record.id }}</code></dd></div><div><dt>远端任务</dt><dd><code>{{ record.remoteTaskId || '尚无可靠任务 ID' }}</code></dd></div><div><dt>模型连接</dt><dd>{{ providers.find(provider => provider.id === record.providerId)?.label || record.providerId }} · {{ record.providerModel }}</dd></div><div><dt>输入方式</dt><dd>{{ inputModeOptions.find(option => option.value === record.plan.inputMode)?.label }}</dd></div><div><dt>提示词</dt><dd class="preserve-text">{{ record.plan.prompt }}</dd></div><div><dt>有序引用</dt><dd>{{ record.plan.referenceArtifactIds.map(id => artifacts.find(artifact => artifact.id === id)?.name || id).join(' → ') || '无' }}</dd></div></dl></NCollapseItem></NCollapse>
    </article></div>
    <NModal :show="showDialog" preset="card" :title="action === 'reconcile' ? '关联已经存在的远端任务' : '记录生成费用核对'" class="provider-modal" :mask-closable="!disabled" :closable="!disabled" @update:show="value => { if (!value) selected = null; }"><template v-if="selected"><NForm @submit.prevent="save"><NAlert type="info" :show-icon="false" class="draft-alert">{{ action === 'reconcile' ? '请在同一供应商账号核对原任务。关联只恢复原任务查询，不会再提交生成。' : '对照供应商账单填写；尚不确定时可以关闭此窗口，继续保留原预留。' }}</NAlert><template v-if="action === 'reconcile'"><NFormItem label="原远端任务 ID"><NInput v-model:value="remoteTaskId" :maxlength="256" :disabled="disabled" placeholder="从供应商控制台复制原任务 ID" /></NFormItem><NCheckbox v-model:checked="confirmed" :disabled="disabled" class="reasoning-acknowledgement">我已确认这是同一账号、同一次生成对应的原任务。</NCheckbox></template><NFormItem v-else :label="`实际费用（${selected.currency}）`"><NInputNumber v-model:value="actualAmount" :min="0" :precision="4" :disabled="disabled" /></NFormItem><NFormItem label="核对说明"><NInput v-model:value="note" type="textarea" :rows="3" :maxlength="4000" :disabled="disabled" placeholder="记录核对依据，便于之后追溯" /></NFormItem><div class="dialog-actions"><NButton :disabled="disabled" @click="selected = null">保持待核对</NButton><NButton type="primary" attr-type="submit" :loading="disabled" :disabled="disabled || !note.trim() || (action === 'reconcile' ? !remoteTaskId.trim() || !confirmed : !Number.isFinite(actualAmount) || actualAmount < 0)">{{ action === 'reconcile' ? '关联并查询原任务' : '记录实际费用' }}</NButton></div></NForm></template></NModal>
  </section>
</template>
