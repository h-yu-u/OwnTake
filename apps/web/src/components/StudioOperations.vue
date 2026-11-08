<script setup lang="ts">
import { computed, ref } from 'vue';
import { NAlert, NButton, NCollapse, NCollapseItem, NForm, NFormItem, NInput, NInputNumber, NModal, NTag } from 'naive-ui';
import type { Artifact, SpeechInput, StudioOperation } from '../types.ts';
import { artifactUrl } from '../lib/api.ts';
import { studioCanRetryIngest, studioCanSettle, studioKindLabels, studioStatusLabels, studioTone } from '../lib/studio.ts';
import type { SettlementInput } from '../lib/studioApi.ts';
import { formatDate } from '../lib/timeline.ts';
import AppIcon from './AppIcon.vue';
import FrameReviewReport from './FrameReviewReport.vue';
import MediaPreview from './MediaPreview.vue';

const props = defineProps<{ records: StudioOperation[]; artifacts: Artifact[]; disabled: boolean; error: string }>();
const emit = defineEmits<{ refresh: []; cancel: [id: string]; retry: [id: string]; settle: [input: SettlementInput]; draft: [id: string]; audio: [id: string]; candidate: [shotId: string] }>();
const sorted = computed(() => [...props.records].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
const selected = ref<StudioOperation | null>(null);
const actualAmount = ref<number | null>(null);
const note = ref('');
const current = computed(() => props.records.find(record => record.id === selected.value?.id));
const showDialog = computed(() => Boolean(selected.value && current.value?.updatedAt === selected.value.updatedAt));
function asset(record: StudioOperation) { return props.artifacts.find(item => item.id === record.artifactId) || null; }
function speech(record: StudioOperation): SpeechInput | null { return 'text' in record.input ? record.input : null; }
function openSettlement(record: StudioOperation) { selected.value = record; actualAmount.value = record.actualAmount; note.value = ''; }
function settle() {
  if (!selected.value || props.disabled || actualAmount.value === null || !Number.isFinite(actualAmount.value) || actualAmount.value < 0 || !note.value.trim()) return;
  emit('settle', { id: selected.value.id, actualAmount: actualAmount.value, currency: selected.value.currency, note: note.value.trim() });
}
</script>

<template>
  <section class="studio-operations" aria-labelledby="studio-operations-heading">
    <div class="section-heading"><div><p class="eyebrow">CREATIVE OPERATIONS</p><h2 id="studio-operations-heading">操作台账 <span class="count">{{ records.length }}</span></h2></div><NButton size="small" :disabled="disabled" @click="emit('refresh')">刷新操作记录</NButton></div>
    <NAlert v-if="error" type="error" :show-icon="false" class="inline-alert">{{ error }}</NAlert>
    <div v-if="!records.length" class="studio-empty"><AppIcon name="studio" :size="28" /><h3>为作品补上声音与第二双眼睛</h3><p>发起配音、抽样帧审核或 CLI 草稿后，冻结输入、处理状态与结果会保存在这里。</p></div>
    <div class="studio-operation-list" tabindex="0" aria-label="操作记录列表"><article v-for="record in sorted" :key="record.id" class="panel studio-operation">
      <div class="generation-task-heading"><div class="job-symbol"><AppIcon :name="record.kind === 'tts' ? 'audio' : record.kind === 'frame_review' ? 'review' : 'terminal'" :size="23" /></div><div class="generation-task-title"><div class="heading-line"><h3>{{ record.speechBatch ? `配音 · ${record.speechBatch.shotTitle}` : studioKindLabels[record.kind] }}</h3><NTag size="small" :bordered="false" :type="studioTone(record.status)">{{ studioStatusLabels[record.status] }}</NTag></div><p>{{ record.targetLabel }} · {{ record.targetModel }} · {{ formatDate(record.createdAt) }}</p></div></div>
      <div class="generation-task-metadata"><span v-if="record.budgetMode !== 'none'">{{ record.actualAmount === null ? '仍保留预留' : '已人工核对' }} {{ (record.actualAmount ?? record.reservedAmount).toFixed(4) }} {{ record.currency }}</span><span v-if="record.source.visualRevision !== undefined">候选来源视觉要求 v{{ record.source.visualRevision }}</span><span v-if="record.source.boardRevision !== undefined">分镜 r{{ record.source.boardRevision }} · 简报 r{{ record.source.projectRevision }}</span></div>
      <NAlert v-if="record.status === 'submission_unknown'" type="warning" :show-icon="false" class="generation-state-note">请求可能已经被受理，但本地未获得可靠结果。不会自动重发，也没有再次提交按钮。请在原服务或 CLI 侧核对；费用请以原服务账单为准。</NAlert>
      <p v-if="record.status === 'received'" class="generation-cancel-note">完整回复已接收，正在本地入库。</p>
      <NAlert v-if="studioCanRetryIngest(record)" type="info" :show-icon="false" class="generation-state-note">已经接收原回复，当前只处理本地入库。恢复入库会读取这次操作保存的回复，不会重新请求模型。</NAlert>
      <p v-if="record.status === 'cancelled'" class="generation-cancel-note">本地处理已停止。若外部服务已收到请求，它仍可能处理并产生费用。</p>
      <div v-if="record.error" class="generation-error"><strong>{{ record.error.message }}</strong><span class="mono">{{ record.error.code }}</span></div>
      <div v-if="record.kind === 'tts' && record.artifactId" class="studio-audio-result"><h3>配音结果 · 试听后使用</h3><MediaPreview v-if="asset(record)" :artifact="asset(record)" compact /><p v-else class="form-note">音频已入库，素材快照正在更新。可以先下载原结果。</p></div>
      <FrameReviewReport v-if="record.review" :operation-id="record.id" :review="record.review" />
      <div class="generation-task-actions">
        <NButton v-if="['queued', 'submitting'].includes(record.status)" size="small" :disabled="disabled" @click="emit('cancel', record.id)">请求停止本地处理</NButton>
        <NButton v-if="studioCanRetryIngest(record)" size="small" :disabled="disabled" @click="emit('retry', record.id)">恢复原回复入库</NButton>
        <NButton v-if="record.draftId" size="small" type="primary" :disabled="disabled" @click="emit('draft', record.draftId)">逐项审阅分镜草稿</NButton>
        <NButton v-if="record.kind === 'tts' && record.artifactId && !record.speechBatch" size="small" type="primary" :disabled="disabled || !asset(record)" @click="emit('audio', record.artifactId)">试听后添加到音轨</NButton>
        <NButton v-if="record.review && record.source.shotId" size="small" :disabled="disabled" @click="emit('candidate', record.source.shotId)">打开候选进行人工复核</NButton>
        <a v-if="record.artifactId" class="download-link" :href="artifactUrl(record.artifactId)" :download="asset(record)?.name">下载结果</a>
        <NButton v-if="studioCanSettle(record)" text size="small" :disabled="disabled" @click="openSettlement(record)">核对费用</NButton>
      </div>
      <NCollapse class="generation-details"><NCollapseItem title="查看冻结输入与来源" :name="record.id"><dl class="generation-detail-list"><div><dt>操作 ID</dt><dd><code>{{ record.id }}</code></dd></div><div><dt>目标</dt><dd>{{ record.targetLabel }} · {{ record.targetModel }}</dd></div><template v-if="speech(record)"><div><dt>配音文字</dt><dd class="preserve-text">{{ speech(record)!.text }}</dd></div><div><dt>声音 / 语速</dt><dd>{{ speech(record)!.voice }} · {{ speech(record)!.speed }} 倍</dd></div><div><dt>风格指令</dt><dd class="preserve-text">{{ speech(record)!.instructions || '无' }}</dd></div></template><template v-if="record.kind === 'frame_review'"><div><dt>原候选视觉版本</dt><dd>v{{ record.source.visualRevision }}</dd></div><div><dt>素材 ID</dt><dd><code>{{ record.source.artifactId }}</code></dd></div><div><dt>原素材 SHA-256</dt><dd><code>{{ record.source.sha256 }}</code></dd></div><div v-if="'candidateId' in record.input"><dt>候选 ID</dt><dd><code>{{ record.input.candidateId }}</code></dd></div></template><template v-if="record.kind === 'runtime_draft' && 'expectedBoardRevision' in record.input"><div><dt>分镜版本</dt><dd>r{{ record.input.expectedBoardRevision }}</dd></div><div><dt>简报版本</dt><dd>r{{ record.input.expectedProjectRevision }}</dd></div></template></dl></NCollapseItem></NCollapse>
    </article></div>
    <NModal :show="showDialog" preset="card" title="核对创作工具费用" class="provider-modal" :mask-closable="!disabled" :closable="!disabled" @update:show="value => { if (!value) selected = null; }"><NForm v-if="selected" @submit.prevent="settle"><NAlert type="info" :show-icon="false" class="draft-alert">对照原服务账单填写实际费用。未知金额无需猜测，可以关闭窗口继续保留 {{ selected.reservedAmount.toFixed(4) }} {{ selected.currency }} 的预留。费用核对不会重新执行操作。</NAlert><NFormItem :label="`实际费用（${selected.currency}）`"><NInputNumber :input-props="{ 'aria-label': '实际费用' }" v-model:value="actualAmount" :min="0" :precision="4" :disabled="disabled" placeholder="依据账单填写" /></NFormItem><NFormItem label="核对依据"><NInput :input-props="{ 'aria-label': '核对依据' }" v-model:value="note" type="textarea" :rows="3" :maxlength="4000" :disabled="disabled" placeholder="记录账单或其他实际核对依据" /></NFormItem><div class="dialog-actions"><NButton :disabled="disabled" @click="selected = null">保持待核对</NButton><NButton type="primary" attr-type="submit" :loading="disabled" :disabled="disabled || actualAmount === null || !Number.isFinite(actualAmount) || actualAmount < 0 || !note.trim()">记录实际费用</NButton></div></NForm></NModal>
  </section>
</template>
