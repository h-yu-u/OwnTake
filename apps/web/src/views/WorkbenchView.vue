<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NAlert, NButton, NTag } from 'naive-ui';
import type { ProjectSnapshot, TimelineDraft } from '../types.ts';
import { artifactUrl } from '../lib/api.ts';
import { createClip, formatBytes, formatDuration } from '../lib/timeline.ts';
import AppIcon from '../components/AppIcon.vue';
import MediaPreview from '../components/MediaPreview.vue';
import TimelineEditor from '../components/TimelineEditor.vue';

const props = defineProps<{ snapshot: ProjectSnapshot; draft: TimelineDraft; dirty: boolean; version: number; previewRevision: number; disabled: boolean; saving: boolean; importing: { current: number; total: number; name: string } | null; problems: string[] }>();
const emit = defineEmits<{ 'update:draft': [value: TimelineDraft]; import: [files: File[]]; restore: [input: { id: string; file: File }]; save: []; export: []; reload: [] }>();
const input = ref<HTMLInputElement | null>(null);
const restoreInput = ref<HTMLInputElement | null>(null);
const restoreId = ref('');
const selectedId = ref('');
const dragging = ref(false);
const assets = computed(() => props.snapshot.artifacts.filter(asset => asset.source !== 'render'));
const selected = computed(() => assets.value.find(asset => asset.id === selectedId.value) || props.snapshot.artifacts.find(asset => asset.id === selectedId.value) || assets.value[0] || null);
watch(() => props.snapshot.project.id, () => { selectedId.value = ''; });
function filesSelected(event: Event) { const target = event.target as HTMLInputElement; if (target.files?.length) emit('import', Array.from(target.files)); target.value = ''; }
function dropFiles(event: DragEvent) { dragging.value = false; if (!props.disabled && event.dataTransfer?.files.length) emit('import', Array.from(event.dataTransfer.files)); }
function append() { if (selected.value && selected.value.kind !== 'audio') emit('update:draft', { ...props.draft, clips: [...props.draft.clips, createClip(selected.value)] }); }
function chooseRestore() { if (selected.value) { restoreId.value = selected.value.id; restoreInput.value?.click(); } }
function restoreSelected(event: Event) { const target = event.target as HTMLInputElement; const file = target.files?.[0]; if (file && restoreId.value) emit('restore', { id: restoreId.value, file }); target.value = ''; }
</script>

<template>
  <div>
    <header class="page-heading"><div><p class="eyebrow">THE CUTTING ROOM</p><h1>{{ snapshot.project.name }}</h1><p class="subheading">导入你的画面，安排每一次相遇。</p></div><div class="heading-actions"><NTag :bordered="false">{{ draft.width }} × {{ draft.height }} · {{ draft.fps }} fps</NTag><NButton type="primary" :disabled="disabled || problems.length > 0" @click="emit('export')">前往导出 <template #icon><AppIcon name="export" :size="17" /></template></NButton></div></header>
    <div class="workbench-grid">
      <section class="panel asset-panel" :class="{ dragging }" @dragover.prevent="dragging = true" @dragleave.prevent="dragging = false" @drop.prevent="dropFiles">
        <div class="panel-heading"><h2>素材库 <span class="count">{{ assets.length }}</span></h2><NButton quaternary size="small" :disabled="disabled" aria-label="导入素材" @click="input?.click()"><AppIcon name="plus" :size="18" /></NButton></div>
        <input ref="input" type="file" accept="image/*,video/*,audio/*,.mkv,.mov,.m4v,.m4a,.flac,.wav" multiple hidden @change="filesSelected" />
        <NButton dashed block :loading="Boolean(importing)" :disabled="disabled" @click="input?.click()"><template #icon><AppIcon name="upload" :size="17" /></template>{{ importing ? `${importing.current} / ${importing.total} 正在导入` : '导入素材' }}</NButton>
        <p v-if="importing" class="import-status" role="status">{{ importing.name }}</p><p v-else class="asset-hint">拖入图片、视频或音频<br />单个文件不超过 256 MB</p>
        <div v-if="!assets.length" class="asset-empty"><AppIcon name="image" :size="31" /><p>素材会出现在这里</p></div>
        <div v-else class="asset-list"><button v-for="asset in assets" :key="asset.id" class="asset-item" :class="{ selected: selected?.id === asset.id }" :aria-pressed="selected?.id === asset.id" @click="selectedId = asset.id"><div class="asset-thumbnail"><img v-if="asset.kind === 'image'" :src="artifactUrl(asset.id)" alt="" loading="lazy" /><AppIcon v-else :name="asset.kind === 'audio' ? 'audio' : 'film'" :size="23" /></div><div class="asset-copy"><strong :title="asset.name">{{ asset.name }}</strong><span>{{ asset.kind === 'image' ? formatBytes(asset.sizeBytes) : formatDuration(asset.media.durationMs) }}</span></div></button></div>
      </section>
      <section class="panel preview-panel" aria-label="素材预览"><div class="panel-heading"><h2>素材预览</h2><div class="heading-line"><NButton v-if="selected" text size="small" :disabled="disabled" @click="chooseRestore">恢复本地文件</NButton><NTag v-if="selected" size="small" :bordered="false">{{ selected.kind === 'image' ? '图片' : selected.kind === 'video' ? '视频' : '音频' }}</NTag></div></div><input ref="restoreInput" type="file" hidden @change="restoreSelected" /><MediaPreview :key="`${selected?.id}:${previewRevision}`" :artifact="selected" /><div class="preview-actions"><span class="muted small">{{ selected?.kind === 'audio' ? '当前阶段支持音频预览；画面时间线请使用图片或视频。' : '完整画面或填满画幅，可在片段设置中调整。' }}</span><NButton :disabled="disabled || !selected || selected.kind === 'audio'" @click="append"><template #icon><AppIcon name="plus" :size="17" /></template>加入时间线</NButton></div></section>
    </div>
    <NAlert v-if="snapshot.timeline && snapshot.timeline.version !== version && dirty" type="warning" :show-icon="false" class="inline-alert">项目已有新的时间线版本。你的本地修改仍保留；保存遇到版本冲突时，请先复制需要的参数，再重新载入。 <NButton text type="primary" :disabled="disabled" @click="emit('reload')">重新载入已存版本</NButton></NAlert>
    <NAlert v-if="draft.clips.length && problems.length" type="warning" :show-icon="false" class="inline-alert">{{ problems[0] }}</NAlert>
    <TimelineEditor :model-value="draft" :artifacts="snapshot.artifacts" :disabled="disabled" :dirty="dirty" :version="version" :saving="saving" @update:model-value="emit('update:draft', $event)" @save="emit('save')" @preview="selectedId = $event" />
  </div>
</template>
