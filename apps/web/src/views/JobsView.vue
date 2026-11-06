<script setup lang="ts">
import { computed } from 'vue';
import { NButton, NProgress, NTag } from 'naive-ui';
import type { Artifact, Job, GenerationRecord, ProviderSummary, Reservation, Shot, StudioOperation } from '../types.ts';
import { artifactUrl } from '../lib/api.ts';
import { canCancel, jobLabels, jobTone, progressPercent } from '../lib/jobs.ts';
import { formatDate } from '../lib/timeline.ts';
import AppIcon from '../components/AppIcon.vue';
import EmptyState from '../components/EmptyState.vue';
import GenerationTasks from '../components/GenerationTasks.vue';

const props = defineProps<{ jobs: Job[]; artifacts: Artifact[]; cancelling: string[]; generations: GenerationRecord[]; providers: ProviderSummary[]; shots: Shot[]; studioOperations: StudioOperation[]; generationError: string; disabled: boolean }>();
const emit = defineEmits<{ studio: []; cancel: [id: string]; refresh: []; workbench: []; export: []; refreshGenerations: []; candidate: [shotId: string]; cancelGeneration: [id: string]; polling: [input: { id: string; paused: boolean }]; retryDownload: [id: string]; reconcile: [input: { id: string; remoteTaskId: string; note: string }]; settleGeneration: [input: { id: string; actualAmount: number; currency: Reservation['currency']; note: string }] }>();
const sorted = computed(() => props.jobs.filter(job => !props.generations.some(record => record.jobId === job.id) && !props.studioOperations.some(record => record.jobId === job.id)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
const totals = computed(() => ({ active: props.jobs.filter(job => canCancel(job.status) || job.status === 'cancel_requested').length, succeeded: props.jobs.filter(job => job.status === 'succeeded').length, failed: props.jobs.filter(job => job.status === 'failed').length }));
function output(job: Job) { return props.artifacts.find(asset => asset.id === job.result?.artifactId); }
</script>

<template>
  <div class="readable-view">
    <header class="page-heading"><div><p class="eyebrow">WORK IN PROGRESS</p><h1>任务中心</h1><p class="subheading">处理由本地服务继续执行，离开页面后也会保留进度。</p></div><NButton :disabled="disabled" @click="emit('refresh')"><template #icon><AppIcon name="refresh" :size="16" /></template>刷新状态</NButton></header>
    <div class="metric-grid"><div class="metric-card"><span>进行中</span><strong>{{ totals.active }}<small>个任务</small></strong></div><div class="metric-card"><span>已完成</span><strong>{{ totals.succeeded }}<small>个任务</small></strong></div><div class="metric-card"><span>需要关注</span><strong>{{ totals.failed }}<small>个失败任务</small></strong></div></div>
    <div v-if="studioOperations.length" class="studio-job-link panel"><div><strong>创作工具 · {{ studioOperations.length }} 次操作</strong><p>配音、抽样帧审核与 CLI 草稿的结果、停止请求和费用核对集中在创作工具页。</p></div><NButton :disabled="disabled" @click="emit('studio')">打开操作台账</NButton></div>
    <GenerationTasks :records="generations" :providers="providers" :shots="shots" :artifacts="artifacts" :disabled="disabled" :error="generationError" @refresh="emit('refreshGenerations')" @candidate="emit('candidate', $event)" @cancel="emit('cancelGeneration', $event)" @polling="emit('polling', $event)" @retry="emit('retryDownload', $event)" @reconcile="emit('reconcile', $event)" @settle="emit('settleGeneration', $event)" /><EmptyState v-if="!sorted.length && !generations.length && !studioOperations.length" title="片场准备就绪" description="保存时间线并发起导出后，你会在这里看到实际处理进度与结果。" icon="jobs"><NButton @click="emit('workbench')">去安排画面</NButton></EmptyState>
    <div v-else class="job-list"><article v-for="job in sorted" :key="job.id" class="panel job-card"><div class="job-main"><div class="job-symbol"><AppIcon :name="job.status === 'succeeded' ? 'check' : 'export'" :size="23" /></div><div class="job-copy"><div class="heading-line"><h2>{{ job.type.includes('export') || job.type.includes('render') ? '导出成片' : job.type === 'reasoning' ? '分镜推理' : job.type }}</h2><NTag size="small" :bordered="false" :type="jobTone(job.status)">{{ jobLabels[job.status] }}</NTag></div><p>{{ formatDate(job.createdAt) }} · <span class="mono">{{ job.id.slice(0, 8) }}</span></p></div><div class="job-actions"><NButton v-if="canCancel(job.status)" size="small" :loading="cancelling.includes(job.id)" :disabled="disabled" @click="emit('cancel', job.id)">停止任务</NButton><NButton v-if="output(job)" size="small" @click="emit('export')">查看成片</NButton><a v-if="output(job)" class="download-link" :href="artifactUrl(output(job)!.id)" :download="output(job)!.name">下载</a></div></div><div v-if="['running', 'queued', 'waiting_external', 'cancel_requested'].includes(job.status)" class="job-progress"><NProgress type="line" :percentage="progressPercent(job.progress)" :height="5" :processing="job.status === 'running'" :show-indicator="false" /><span>{{ progressPercent(job.progress) }}%</span></div><div v-if="job.error" class="job-error"><strong>{{ job.error.message }}</strong><span class="mono">{{ job.error.code }}</span></div><p v-if="job.status === 'cancel_requested'" class="job-note">停止请求已送达，正在等待正在执行的步骤退出。</p><p v-if="job.status === 'failed'" class="job-note">检查错误信息与工具设置；调整后可从导出页重新发起。</p></article></div>
  </div>
</template>
