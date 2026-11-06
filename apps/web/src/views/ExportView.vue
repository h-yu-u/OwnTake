<script setup lang="ts">
import { computed } from 'vue';
import { NAlert, NButton, NInputNumber, NSelect, NTag } from 'naive-ui';
import type { Health, ProjectSnapshot, TimelineDraft } from '../types.ts';
import { artifactUrl } from '../lib/api.ts';
import { jobLabels, jobTone, progressPercent } from '../lib/jobs.ts';
import { formatBytes, formatDate, formatDuration, totalDuration } from '../lib/timeline.ts';
import AppIcon from '../components/AppIcon.vue';
import EmptyState from '../components/EmptyState.vue';
import MediaPreview from '../components/MediaPreview.vue';

const props = defineProps<{ snapshot: ProjectSnapshot; draft: TimelineDraft; dirty: boolean; disabled: boolean; exporting: boolean; health: Health | null; problems: string[] }>();
const emit = defineEmits<{ 'update:draft': [value: TimelineDraft]; export: []; jobs: []; settings: []; workbench: [] }>();
const completed = computed(() => props.snapshot.artifacts.filter(asset => asset.source === 'render').sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
const latestJob = computed(() => [...props.snapshot.jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]);
const toolsReady = computed(() => Boolean(props.health?.ffmpeg.available && props.health.ffprobe.available));
const fpsOptions = [24, 25, 30, 60].map(fps => ({ label: `${fps} fps`, value: fps }));
function updateSize(key: 'width' | 'height', value: number | null) { if (value !== null) emit('update:draft', { ...props.draft, [key]: value }); }
function preset(shortSide: number) {
  const ratio = props.snapshot.project.ratio;
  const longSide = Math.round(shortSide * 16 / 9 / 2) * 2;
  const [width, height] = ratio === '9:16' ? [shortSide, longSide] : ratio === '1:1' ? [shortSide, shortSide] : [longSide, shortSide];
  emit('update:draft', { ...props.draft, width, height });
}
</script>

<template>
  <div class="readable-view">
    <header class="page-heading"><div><p class="eyebrow">THE FINAL TAKE</p><h1>让故事成为作品</h1><p class="subheading">每一次导出都会保留成片，让你从容比较与回看。</p></div><NButton @click="emit('workbench')">返回时间线</NButton></header>
    <div class="export-layout"><section class="panel export-settings"><div class="panel-heading"><h2>导出设置</h2><NTag size="small" :bordered="false">MP4 · H.264 / AAC</NTag></div><div class="export-summary"><strong>{{ formatDuration(totalDuration(draft)) }}</strong><span>{{ draft.clips.length }} 个画面片段 · {{ snapshot.project.ratio }} 项目画幅</span></div><div class="export-presets"><span class="field-label">常用分辨率</span><NButton size="small" :disabled="disabled" @click="preset(720)">720p</NButton><NButton size="small" :disabled="disabled" @click="preset(1080)">1080p</NButton></div><div class="size-fields"><label class="field-label"><span>宽度 <small>px</small></span><NInputNumber :value="draft.width" :min="64" :max="4096" :step="2" :precision="0" :show-button="false" :disabled="disabled" aria-label="输出宽度" @update:value="updateSize('width', $event)" /></label><span class="size-times">×</span><label class="field-label"><span>高度 <small>px</small></span><NInputNumber :value="draft.height" :min="64" :max="4096" :step="2" :precision="0" :show-button="false" :disabled="disabled" aria-label="输出高度" @update:value="updateSize('height', $event)" /></label></div><label class="field-label fps-field"><span>帧率</span><NSelect :value="draft.fps" :options="fpsOptions" :disabled="disabled" aria-label="输出帧率" @update:value="value => emit('update:draft', { ...draft, fps: value })" /></label><NAlert v-if="problems.length" type="warning" :show-icon="false" class="export-alert">{{ problems[0] }}</NAlert><NAlert v-if="!toolsReady" type="warning" :show-icon="false" class="export-alert">需要可用的 FFmpeg 与 ffprobe。<NButton text type="primary" @click="emit('settings')">检查工具设置</NButton></NAlert><NButton type="primary" size="large" block :loading="exporting" :disabled="disabled || problems.length > 0 || !toolsReady" @click="emit('export')"><template #icon><AppIcon name="export" /></template>{{ dirty || !snapshot.timeline ? '保存并导出 MP4' : '导出 MP4' }}</NButton><p class="panel-footnote">导出使用提交时的时间线版本。保持本地服务运行，即可关闭浏览器；成片完成后会保存在本机。</p><div v-if="latestJob" class="latest-job"><div class="heading-line"><span>最近任务</span><NTag size="small" :bordered="false" :type="jobTone(latestJob.status)">{{ jobLabels[latestJob.status] }}</NTag><span v-if="latestJob.status === 'running'" class="small">{{ progressPercent(latestJob.progress) }}%</span></div><NButton text type="primary" @click="emit('jobs')">查看任务详情</NButton></div></section><section class="panel output-preview"><div class="panel-heading"><h2>最近成片</h2><span class="muted small">{{ completed.length }} 个版本</span></div><MediaPreview v-if="completed[0]" :artifact="completed[0]" /><EmptyState v-else title="把最后一个画面接好" description="导出完成后，可在这里播放、检查并下载 MP4。" icon="export" /><div v-if="completed[0]" class="output-download"><span>{{ formatDate(completed[0].createdAt) }} · {{ formatBytes(completed[0].sizeBytes) }}</span><a class="primary-link" :href="artifactUrl(completed[0].id)" :download="completed[0].name"><AppIcon name="export" :size="16" />下载成片</a></div></section></div>
    <section v-if="completed.length > 1" class="output-history"><div class="section-heading"><h2>成片记录</h2><span class="muted small">保留每一次尝试</span></div><div class="panel output-list"><div v-for="artifact in completed.slice(1)" :key="artifact.id" class="output-row"><AppIcon name="film" :size="22" /><div><strong>{{ artifact.name }}</strong><span>{{ formatDate(artifact.createdAt) }} · {{ formatDuration(artifact.media.durationMs) }} · {{ formatBytes(artifact.sizeBytes) }}</span></div><a :href="artifactUrl(artifact.id)" :download="artifact.name">下载 MP4</a></div></div></section>
  </div>
</template>
