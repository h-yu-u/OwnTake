<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NAlert, NButton, NCheckbox, NInput, NInputNumber, NModal, NSelect, NTag } from 'naive-ui';
import type { Artifact, Shot, StudioOperation, TimelineDraft } from '../types.ts';
import { batchAudioRows, defaultBatchAudioIds, planBatchAudio } from '../../../../packages/domain/src/batch-audio.ts';
import type { BatchAudioMode } from '../../../../packages/domain/src/batch-audio.ts';
import { artifactUrl, errorMessage } from '../lib/api.ts';
import { formatDuration } from '../lib/timeline.ts';

const props = defineProps<{ show: boolean; projectId: string; draft: TimelineDraft; artifacts: Artifact[]; shots: Shot[]; operations: StudioOperation[]; disabled: boolean }>();
const emit = defineEmits<{ 'update:show': [value: boolean]; apply: [draft: TimelineDraft, added: number, extendedShots: number] }>();
const mode = ref<BatchAudioMode>('shots'), startSeconds = ref<number | null>(0);
const selectedIds = ref<string[]>([]), query = ref(''), availableOnly = ref(true), auditionId = ref<string | null>(null), applied = ref(false);
const context = computed(() => ({ projectId: props.projectId, mode: mode.value, startMs: startSeconds.value === null ? NaN : Math.round(startSeconds.value * 1000), shots: props.shots, operations: props.operations }));
const rows = computed(() => batchAudioRows(props.draft, props.artifacts, context.value));
const filtered = computed(() => rows.value.filter(row => (!availableOnly.value || !row.reason) && row.artifact.name.toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase())));
const selection = computed(() => selectedIds.value.map(id => rows.value.find(row => row.artifact.id === id)).filter(row => row !== undefined));
const preview = computed(() => {
  if (!selectedIds.value.length) return { plan: null, error: '' };
  try { return { plan: planBatchAudio(props.draft, selectedIds.value, props.artifacts, context.value), error: '' }; }
  catch (error) { return { plan: null, error: errorMessage(error) }; }
});
const audition = computed(() => props.artifacts.find(artifact => artifact.id === auditionId.value));
const existingCount = computed(() => rows.value.filter(row => props.draft.audio.some(track => track.artifactId === row.artifact.id)).length);
const modes = [{ value: 'shots', label: '按分镜对齐 · 配音' }, { value: 'sequence', label: '依次接入 · 连续播放' }, { value: 'parallel', label: '同时播放 · 叠加配乐' }];
function chooseDefaults() { selectedIds.value = defaultBatchAudioIds(rows.value, mode.value); }
watch(mode, chooseDefaults);
watch(() => props.show, show => {
  if (!show) { auditionId.value = null; return; }
  query.value = ''; availableOnly.value = true; startSeconds.value = 0; applied.value = false;
  mode.value = props.operations.some(operation => operation.projectId === props.projectId && operation.kind === 'tts' && operation.speechBatch && operation.status === 'succeeded') ? 'shots' : 'sequence';
  chooseDefaults();
});
function toggle(id: string, checked: boolean) {
  if (!checked) { selectedIds.value = selectedIds.value.filter(value => value !== id); return; }
  const shotId = rows.value.find(row => row.artifact.id === id)?.operation?.source.shotId;
  selectedIds.value = [...selectedIds.value.filter(value => value !== id && (mode.value !== 'shots' || rows.value.find(row => row.artifact.id === value)?.operation?.source.shotId !== shotId)), id];
}
function selectVisible() {
  for (const id of defaultBatchAudioIds(filtered.value, mode.value)) toggle(id, true);
}
function move(index: number, direction: -1 | 1) {
  const target = index + direction;
  if (target < 0 || target >= selectedIds.value.length) return;
  const ids = [...selectedIds.value]; [ids[index], ids[target]] = [ids[target]!, ids[index]!]; selectedIds.value = ids;
}
function apply() {
  if (!props.show || props.disabled || applied.value || !preview.value.plan) return;
  const { draft, added, extendedShots } = preview.value.plan;
  applied.value = true; emit('apply', draft, added, extendedShots); emit('update:show', false);
}
</script>

<template>
  <NModal :show="show" preset="card" title="批量添加音轨" class="batch-audio-modal" @update:show="value => emit('update:show', value)">
    <p class="dialog-intro">从已有音频中多选，一次加入时间线。已添加的素材会跳过，现有音轨保留。</p>
    <div class="batch-audio-controls"><label class="field-label"><span>排列方式</span><NSelect v-model:value="mode" :options="modes" :disabled="disabled" aria-label="音轨排列方式" /></label><label v-if="mode !== 'shots'" class="field-label"><span>开始位置（秒）</span><NInputNumber v-model:value="startSeconds" :min="0" :max="1800" :precision="3" :show-button="false" :disabled="disabled" :input-props="{ 'aria-label': '批量音轨开始位置' }" /></label></div>
    <p class="form-note">{{ mode === 'shots' ? '按配音来源定位镜头，每镜选一份。默认选择最新可用版本；图片镜头可自动延长，后续镜头和字幕顺延。' : mode === 'sequence' ? '按照右侧已选列表的顺序接入，可上下调整。每段完整播放，不重叠。' : '所选音频从相同起点播放，适合叠加背景音乐和音效。' }}</p>
    <div class="batch-audio-layout"><section aria-label="可添加音频"><NInput v-model:value="query" clearable placeholder="搜索音频名称" :disabled="disabled" :input-props="{ 'aria-label': '搜索音频' }" /><div class="batch-audio-selection-bar"><span>跳过已有 {{ existingCount }} 条</span><NCheckbox v-model:checked="availableOnly" :disabled="disabled">只看可添加</NCheckbox><NButton text size="small" :disabled="disabled" @click="selectVisible">{{ query.trim() ? '选择筛选结果' : '选择全部可用' }}</NButton><NButton text size="small" :disabled="disabled" @click="selectedIds = []">清空</NButton></div><div class="batch-audio-list"><article v-for="row in filtered" :key="row.artifact.id" class="batch-audio-item" :class="{ unavailable: row.reason }"><NCheckbox :checked="selectedIds.includes(row.artifact.id)" :disabled="disabled || Boolean(row.reason)" @update:checked="toggle(row.artifact.id, $event)"><span class="batch-audio-name">{{ row.artifact.name }}</span></NCheckbox><div class="batch-audio-item-meta"><span>{{ formatDuration(row.artifact.media.durationMs) }}</span><NButton text size="small" :disabled="disabled" :aria-label="`试听 ${row.artifact.name}`" @click="auditionId = row.artifact.id">试听</NButton></div><p v-if="row.reason" class="form-note">{{ row.reason }}</p></article><p v-if="!filtered.length" class="overlay-empty">{{ rows.length ? '当前筛选下没有可添加的音频，可调整排列方式或筛选条件。' : '先从素材库导入音频，或按分镜生成配音。' }}</p></div></section>
      <section class="batch-audio-preview" aria-label="音轨排列预览"><h3>已选 {{ selectedIds.length }} 条 <NTag size="small" :bordered="false">{{ mode === 'shots' ? '按镜头位置' : mode === 'sequence' ? '依次播放' : '同时播放' }}</NTag></h3><p v-if="!selectedIds.length" class="overlay-empty">选择音频后查看添加位置</p><div class="batch-audio-list"><article v-for="(row, index) in selection" :key="row.artifact.id" class="batch-audio-preview-row"><div><strong>{{ row.artifact.name }}</strong><p v-if="preview.plan" class="form-note">{{ formatDuration(preview.plan.tracks.find(track => track.artifactId === row.artifact.id)!.startMs) }} → {{ formatDuration(preview.plan.tracks.find(track => track.artifactId === row.artifact.id)!.startMs + row.artifact.media.durationMs) }}</p><p v-else class="form-note">待调整排列</p></div><div v-if="mode === 'sequence'" class="heading-line"><NButton text size="small" :disabled="disabled || index === 0" :aria-label="`上移 ${row.artifact.name}`" @click="move(index, -1)">↑</NButton><NButton text size="small" :disabled="disabled || index === selection.length - 1" :aria-label="`下移 ${row.artifact.name}`" @click="move(index, 1)">↓</NButton></div></article></div></section></div>
    <div v-if="audition" class="batch-audio-audition"><span>{{ audition.name }}</span><audio :key="audition.id" :src="artifactUrl(audition.id)" controls autoplay preload="metadata" /></div>
    <NAlert v-if="preview.error" type="warning" :show-icon="false">{{ preview.error }}</NAlert>
    <p v-else-if="preview.plan?.extendedShots" class="form-note">将延长 {{ preview.plan.extendedShots }} 个图片镜头，完整保留配音。</p>
    <template #footer><div class="dialog-actions"><NButton @click="emit('update:show', false)">取消</NButton><NButton type="primary" :disabled="disabled || applied || !preview.plan" @click="apply">添加 {{ selectedIds.length }} 条音轨</NButton></div></template>
  </NModal>
</template>
