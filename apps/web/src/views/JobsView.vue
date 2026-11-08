<script setup lang="ts">
import { computed, nextTick, watch } from 'vue';
import { NAlert, NButton, NCollapse, NCollapseItem, NProgress, NTag } from 'naive-ui';
import type { Artifact, Job, JobsTab, GenerationRecord, ProviderSummary, Reservation, Shot, StudioOperation } from '../types.ts';
import type { SettlementInput } from '../lib/studioApi.ts';
import { artifactUrl } from '../lib/api.ts';
import { canCancel, jobLabels, jobTone, progressPercent } from '../lib/jobs.ts';
import { formatDate } from '../lib/timeline.ts';
import AppIcon from '../components/AppIcon.vue';
import EmptyState from '../components/EmptyState.vue';
import GenerationTasks from '../components/GenerationTasks.vue';
import SpeechBatches from '../components/SpeechBatches.vue';
import StudioOperations from '../components/StudioOperations.vue';

const props = defineProps<{ tab: JobsTab; jobs: Job[]; artifacts: Artifact[]; cancelling: string[]; generations: GenerationRecord[]; providers: ProviderSummary[]; shots: Shot[]; studioOperations: StudioOperation[]; generationError: string; studioError: string; disabled: boolean }>();
const emit = defineEmits<{ 'update:tab': [tab: JobsTab]; cancel: [id: string]; refresh: []; workbench: []; export: []; refreshGenerations: []; candidate: [shotId: string]; cancelGeneration: [id: string]; polling: [input: { id: string; paused: boolean }]; retryDownload: [id: string]; reconcile: [input: { id: string; remoteTaskId: string; note: string }]; settleGeneration: [input: { id: string; actualAmount: number; currency: Reservation['currency']; note: string }]; refreshStudio: []; cancelStudio: [id: string]; retryStudio: [id: string]; settleStudio: [input: SettlementInput]; draft: [id: string]; audio: [id: string]; applyBatch: [id: string]; cancelBatch: [id: string] }>();
const sorted = computed(() => props.jobs.filter(job => !props.generations.some(record => record.jobId === job.id) && !props.studioOperations.some(record => record.jobId === job.id)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
const totals = computed(() => ({ active: props.jobs.filter(job => canCancel(job.status) || job.status === 'cancel_requested').length, succeeded: props.jobs.filter(job => job.status === 'succeeded').length, failed: props.jobs.filter(job => job.status === 'failed').length }));
const batchRecords = computed(() => props.studioOperations.filter(record => record.speechBatch));
const otherRecords = computed(() => props.studioOperations.filter(record => !record.speechBatch));
const tabs = computed<Array<{ id: JobsTab; label: string; count: number }>>(() => [
  { id: 'generation', label: '图片与视频', count: props.generations.length },
  { id: 'speech', label: '分镜配音', count: new Set(batchRecords.value.map(record => record.speechBatch!.id)).size },
  { id: 'studio', label: '创作记录', count: otherRecords.value.length },
  { id: 'processing', label: '导出与处理', count: sorted.value.length },
]);
watch(() => props.tab, (_, previous) => {
  document.getElementById(`jobs-panel-${previous}`)?.querySelectorAll<HTMLMediaElement>('audio, video').forEach(media => media.pause());
});
async function navigate(event: KeyboardEvent, index: number) {
  const next = event.key === 'ArrowRight' ? (index + 1) % tabs.value.length : event.key === 'ArrowLeft' ? (index + tabs.value.length - 1) % tabs.value.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.value.length - 1 : -1;
  if (next < 0) return;
  event.preventDefault(); emit('update:tab', tabs.value[next]!.id);
  await nextTick(); document.getElementById(`jobs-tab-${tabs.value[next]!.id}`)?.focus();
}
function output(job: Job) { return props.artifacts.find(asset => asset.id === job.result?.artifactId); }
</script>

<template>
  <div class="jobs-view readable-view">
    <header class="page-heading"><div><p class="eyebrow">WORK IN PROGRESS</p><h1>任务中心</h1><p class="subheading">处理由本地服务继续执行，离开页面后也会保留进度。</p></div><NButton :disabled="disabled" @click="emit('refresh')"><template #icon><AppIcon name="refresh" :size="16" /></template>刷新状态</NButton></header>
    <div class="metric-grid"><div class="metric-card"><span>进行中</span><strong>{{ totals.active }}<small>个任务</small></strong></div><div class="metric-card"><span>已完成</span><strong>{{ totals.succeeded }}<small>个任务</small></strong></div><div class="metric-card"><span>需要关注</span><strong>{{ totals.failed }}<small>个失败任务</small></strong></div></div>
    <section class="jobs-workspace panel" aria-label="分类任务">
      <div class="jobs-tabs" role="tablist" aria-label="任务分类"><button v-for="(item, index) in tabs" :id="`jobs-tab-${item.id}`" :key="item.id" role="tab" :aria-selected="tab === item.id" :aria-controls="`jobs-panel-${item.id}`" :tabindex="tab === item.id ? 0 : -1" @click="emit('update:tab', item.id)" @keydown="navigate($event, index)">{{ item.label }}<span>{{ item.count }}</span></button></div>
      <div v-show="tab === 'generation'" id="jobs-panel-generation" class="jobs-task-panel" role="tabpanel" aria-labelledby="jobs-tab-generation">
        <GenerationTasks :records="generations" :providers="providers" :shots="shots" :artifacts="artifacts" :disabled="disabled" :error="generationError" @refresh="emit('refreshGenerations')" @candidate="emit('candidate', $event)" @cancel="emit('cancelGeneration', $event)" @polling="emit('polling', $event)" @retry="emit('retryDownload', $event)" @reconcile="emit('reconcile', $event)" @settle="emit('settleGeneration', $event)" />
      </div>
      <div v-show="tab === 'speech'" id="jobs-panel-speech" class="jobs-task-panel jobs-scroll-panel" role="tabpanel" aria-labelledby="jobs-tab-speech" tabindex="0">
        <div class="section-heading"><h2>分镜批量配音</h2><NButton size="small" :disabled="disabled" @click="emit('refreshStudio')">刷新配音进度</NButton></div>
        <NAlert v-if="studioError" type="error" :show-icon="false" class="inline-alert">{{ studioError }}</NAlert>
        <EmptyState v-if="!batchRecords.length" title="还没有批量配音任务" description="在分镜或素材剪辑中发起批量配音，进度和结果会集中显示在这里。" icon="audio" />
        <SpeechBatches :records="batchRecords" :disabled="disabled" @apply="emit('applyBatch', $event)" @cancel="emit('cancelBatch', $event)" />
        <NCollapse v-if="batchRecords.length" class="batch-operation-details"><NCollapseItem title="查看逐镜操作记录" name="records"><StudioOperations :records="batchRecords" :artifacts="artifacts" :disabled="disabled" :error="studioError" @refresh="emit('refreshStudio')" @cancel="emit('cancelStudio', $event)" @retry="emit('retryStudio', $event)" @settle="emit('settleStudio', $event)" @draft="emit('draft', $event)" @audio="emit('audio', $event)" @candidate="emit('candidate', $event)" /></NCollapseItem></NCollapse>
      </div>
      <div v-show="tab === 'studio'" id="jobs-panel-studio" class="jobs-task-panel" role="tabpanel" aria-labelledby="jobs-tab-studio">
        <StudioOperations :records="otherRecords" :artifacts="artifacts" :disabled="disabled" :error="studioError" @refresh="emit('refreshStudio')" @cancel="emit('cancelStudio', $event)" @retry="emit('retryStudio', $event)" @settle="emit('settleStudio', $event)" @draft="emit('draft', $event)" @audio="emit('audio', $event)" @candidate="emit('candidate', $event)" />
      </div>
      <div v-show="tab === 'processing'" id="jobs-panel-processing" class="jobs-task-panel jobs-scroll-panel" role="tabpanel" aria-labelledby="jobs-tab-processing" tabindex="0">
        <EmptyState v-if="!sorted.length" title="还没有导出与处理任务" description="保存时间线并发起导出后，可在这里查看进度与结果。" icon="jobs"><NButton @click="emit('workbench')">去安排画面</NButton></EmptyState>
        <div v-else class="job-list"><article v-for="job in sorted" :key="job.id" class="panel job-card"><div class="job-main"><div class="job-symbol"><AppIcon :name="job.status === 'succeeded' ? 'check' : 'export'" :size="23" /></div><div class="job-copy"><div class="heading-line"><h2>{{ job.type.includes('export') || job.type.includes('render') ? '导出成片' : job.type === 'reasoning' ? '分镜推理' : job.type }}</h2><NTag size="small" :bordered="false" :type="jobTone(job.status)">{{ jobLabels[job.status] }}</NTag></div><p>{{ formatDate(job.createdAt) }} · <span class="mono">{{ job.id.slice(0, 8) }}</span></p></div><div class="job-actions"><NButton v-if="canCancel(job.status)" size="small" :loading="cancelling.includes(job.id)" :disabled="disabled" @click="emit('cancel', job.id)">停止任务</NButton><NButton v-if="output(job)" size="small" @click="emit('export')">查看成片</NButton><a v-if="output(job)" class="download-link" :href="artifactUrl(output(job)!.id)" :download="output(job)!.name">下载</a></div></div><div v-if="['running', 'queued', 'waiting_external', 'cancel_requested'].includes(job.status)" class="job-progress"><NProgress type="line" :percentage="progressPercent(job.progress)" :height="5" :processing="job.status === 'running'" :show-indicator="false" /><span>{{ progressPercent(job.progress) }}%</span></div><div v-if="job.error" class="job-error"><strong>{{ job.error.message }}</strong><span class="mono">{{ job.error.code }}</span></div><p v-if="job.status === 'cancel_requested'" class="job-note">停止请求已送达，正在等待正在执行的步骤退出。</p><p v-if="job.status === 'failed'" class="job-note">检查错误信息与工具设置；调整后可从导出页重新发起。</p></article></div>
      </div>
    </section>
  </div>
</template>

<style src="../styles/jobs.css"></style>
