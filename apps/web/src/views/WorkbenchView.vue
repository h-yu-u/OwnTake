<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { NAlert, NButton, NTag, useMessage } from 'naive-ui';
import type { ProjectSnapshot, Shot, StudioOperation, TimelineDraft, WorkbenchTab } from '../types.ts';
import { createClip, formatBytes, formatDuration, totalDuration } from '../lib/timeline.ts';
import AppIcon from '../components/AppIcon.vue';
import MediaPreview from '../components/MediaPreview.vue';
import MediaThumbnail from '../components/MediaThumbnail.vue';
import TimelineEditor from '../components/TimelineEditor.vue';
import CaptionEditor from '../components/CaptionEditor.vue';
import BatchAudioDialog from '../components/BatchAudioDialog.vue';
import AudioTrackEditor from '../components/AudioTrackEditor.vue';

const props = defineProps<{ editorTab: WorkbenchTab; snapshot: ProjectSnapshot; shots: Shot[]; operations: StudioOperation[]; draft: TimelineDraft; dirty: boolean; version: number; previewRevision: number; disabled: boolean; saving: boolean; importing: { current: number; total: number; name: string } | null; problems: string[] }>();
const emit = defineEmits<{ 'update:draft': [value: TimelineDraft]; 'update:editorTab': [value: WorkbenchTab]; import: [files: File[]]; restore: [input: { id: string; file: File }]; save: []; export: []; reload: []; settings: []; batchSpeech: [] }>();
const input = ref<HTMLInputElement | null>(null);
const restoreInput = ref<HTMLInputElement | null>(null);
const restoreId = ref('');
const selectedId = ref('');
const dragging = ref(false);
const libraryExpanded = ref(false);
const editorTabs: Array<{ id: WorkbenchTab; label: string }> = [{ id: 'timeline', label: '画面时间线' }, { id: 'captions', label: '字幕' }, { id: 'audio', label: '独立音轨' }];
function tabCount(id: WorkbenchTab) { return id === 'timeline' ? props.draft.clips.length : id === 'captions' ? props.draft.captions.length : props.draft.audio.length; }
async function navigateTab(event: KeyboardEvent, id: WorkbenchTab) {
  const index = editorTabs.findIndex(tab => tab.id === id);
  const target = event.key === 'ArrowRight' ? (index + 1) % 3 : event.key === 'ArrowLeft' ? (index + 2) % 3 : event.key === 'Home' ? 0 : event.key === 'End' ? 2 : -1;
  if (target < 0) return;
  event.preventDefault(); emit('update:editorTab', editorTabs[target]!.id);
  await nextTick(); document.getElementById(`workbench-tab-${editorTabs[target]!.id}`)?.focus();
}
const batchAudioDialog = ref(false);
const message = useMessage();
function applyBatchAudio(value: TimelineDraft, added: number, extendedShots: number) {
  emit('update:draft', value);
  message.success(`已添加 ${added} 条音轨${extendedShots ? `，延长 ${extendedShots} 个图片镜头` : ''}；保存时间线后即可导出。`);
}
const assets = computed(() => props.snapshot.artifacts.filter(asset => asset.source !== 'render' && asset.kind !== 'audio'));
const selected = computed(() => assets.value.find(asset => asset.id === selectedId.value) || props.snapshot.artifacts.find(asset => asset.id === selectedId.value && asset.kind !== 'audio') || assets.value[0] || null);
watch(() => props.snapshot.project.id, () => { selectedId.value = ''; batchAudioDialog.value = false; libraryExpanded.value = false; });
function filesSelected(event: Event) { const target = event.target as HTMLInputElement; if (target.files?.length) emit('import', Array.from(target.files)); target.value = ''; }
function dropFiles(event: DragEvent) { dragging.value = false; if (!props.disabled && event.dataTransfer?.files.length) emit('import', Array.from(event.dataTransfer.files)); }
function append() { if (selected.value && selected.value.kind !== 'audio') emit('update:draft', { ...props.draft, clips: [...props.draft.clips, createClip(selected.value)] }); }
function chooseRestore() { if (selected.value) { restoreId.value = selected.value.id; restoreInput.value?.click(); } }
function restoreSelected(event: Event) { const target = event.target as HTMLInputElement; const file = target.files?.[0]; if (file && restoreId.value) emit('restore', { id: restoreId.value, file }); target.value = ''; }
</script>

<template>
  <div class="workbench-view">
    <header class="page-heading"><div><h1>{{ snapshot.project.name }}</h1><p class="subheading">素材、画面、字幕与声音，在同一个工作区完成。</p></div><div class="heading-actions"><NButton class="workbench-library-toggle" :aria-expanded="libraryExpanded" aria-controls="workbench-library" @click="libraryExpanded = !libraryExpanded">素材库 · {{ assets.length }}</NButton><NTag :bordered="false">{{ draft.width }} × {{ draft.height }} · {{ draft.fps }} fps</NTag><NButton type="primary" :disabled="disabled || problems.length > 0" @click="emit('export')">前往导出 <template #icon><AppIcon name="export" :size="17" /></template></NButton></div></header>
    <NAlert v-if="snapshot.timeline && snapshot.timeline.version !== version && dirty" type="warning" :show-icon="false" class="workbench-alert">时间线已有新版本，本地修改已保留。<NButton text type="primary" :disabled="disabled" @click="emit('reload')">重新载入已存版本</NButton></NAlert>
    <NAlert v-if="draft.clips.length && problems.length" type="warning" :show-icon="false" class="workbench-alert">{{ problems[0] }}</NAlert>
    <div class="workbench-layout">
      <section id="workbench-library" class="panel asset-panel" :class="{ dragging, 'library-expanded': libraryExpanded }" @dragover.prevent="dragging = true" @dragleave.prevent="dragging = false" @drop.prevent="dropFiles">
        <div class="panel-heading"><h2>素材库 <span class="count">{{ assets.length }}</span></h2><NButton quaternary size="small" :disabled="disabled" aria-label="导入素材" @click="input?.click()"><AppIcon name="plus" :size="18" /></NButton></div>
        <input ref="input" type="file" accept="image/*,video/*,audio/*,.mkv,.mov,.m4v,.m4a,.flac,.wav" multiple hidden @change="filesSelected" />
        <NButton dashed block :loading="Boolean(importing)" :disabled="disabled" @click="input?.click()"><template #icon><AppIcon name="upload" :size="17" /></template>{{ importing ? `${importing.current} / ${importing.total} 正在导入` : '导入素材' }}</NButton>
        <p v-if="importing" class="import-status" role="status">{{ importing.name }}</p><p v-else class="asset-hint">图片与视频显示在这里<br />导入音频后在「独立音轨」中使用<br />单个文件不超过 256 MB</p>
        <div v-if="!assets.length" class="asset-empty"><AppIcon name="image" :size="31" /><p>导入图片或视频，开始安排画面</p></div>
        <div v-else class="asset-list"><button v-for="asset in assets" :key="asset.id" class="asset-item" :class="{ selected: selected?.id === asset.id }" :aria-pressed="selected?.id === asset.id" @click="selectedId = asset.id"><div class="asset-thumbnail"><MediaThumbnail :artifact="asset" /></div><div class="asset-copy"><strong :title="asset.name">{{ asset.name }}</strong><span>{{ asset.kind === 'image' ? formatBytes(asset.sizeBytes) : formatDuration(asset.media.durationMs) }}</span></div></button></div>
      </section>
      <div class="workbench-main"><section class="panel preview-panel" aria-label="素材预览"><div class="panel-heading"><h2>素材预览</h2><div class="heading-line"><NButton v-if="selected" text size="small" :disabled="disabled" @click="chooseRestore">恢复本地文件</NButton><NTag v-if="selected" size="small" :bordered="false">{{ selected.kind === 'image' ? '图片' : selected.kind === 'video' ? '视频' : '音频' }}</NTag></div></div><input ref="restoreInput" type="file" hidden @change="restoreSelected" /><MediaPreview :key="`${selected?.id}:${previewRevision}`" :artifact="selected" /><div class="preview-actions"><span class="muted small">{{ selected?.kind === 'audio' ? '切换「独立音轨」加入录音与配乐。' : '完整画面或填满画幅，可在片段设置中调整。' }}</span><NButton :disabled="disabled || !selected || selected.kind === 'audio'" @click="append"><template #icon><AppIcon name="plus" :size="17" /></template>加入时间线</NButton></div></section>

        <section class="panel workbench-editing" aria-label="集中剪辑工作区">
          <div class="workbench-tabbar" role="tablist" aria-label="剪辑模块"><button v-for="tab in editorTabs" :id="`workbench-tab-${tab.id}`" :key="tab.id" role="tab" :aria-selected="editorTab === tab.id" :aria-controls="`workbench-panel-${tab.id}`" :tabindex="editorTab === tab.id ? 0 : -1" :class="{ active: editorTab === tab.id }" @click="emit('update:editorTab', tab.id)" @keydown="navigateTab($event, tab.id)">{{ tab.label }} <span>{{ tabCount(tab.id) }}</span></button></div>
          <div v-show="editorTab === 'timeline'" id="workbench-panel-timeline" class="workbench-editor-panel" role="tabpanel" aria-labelledby="workbench-tab-timeline"><TimelineEditor :shots="shots" :model-value="draft" :artifacts="snapshot.artifacts" :disabled="disabled" @update:model-value="emit('update:draft', $event)" @preview="selectedId = $event" /></div>
          <div v-show="editorTab === 'captions'" id="workbench-panel-captions" class="workbench-editor-panel" role="tabpanel" aria-labelledby="workbench-tab-captions"><CaptionEditor :model-value="draft.captions" :duration-ms="totalDuration(draft)" :fps="draft.fps" :disabled="disabled" @update:model-value="emit('update:draft', { ...draft, captions: $event })" @settings="emit('settings')" /></div>
          <div v-show="editorTab === 'audio'" id="workbench-panel-audio" class="workbench-editor-panel" role="tabpanel" aria-labelledby="workbench-tab-audio"><AudioTrackEditor @batch-add="batchAudioDialog = true" @batch-speech="emit('batchSpeech')" :model-value="draft.audio" :artifacts="snapshot.artifacts" :duration-ms="totalDuration(draft)" :disabled="disabled" @update:model-value="emit('update:draft', { ...draft, audio: $event })" /></div>
          <footer class="workbench-save-bar"><span :class="{ 'has-changes': dirty }">{{ dirty ? '有未保存修改' : version ? `已保存 · v${version}` : '尚未保存时间线' }}<small>画面、字幕与音轨一起保存</small></span><NButton type="primary" :loading="saving" :disabled="disabled || !draft.clips.length || !dirty || problems.length > 0" @click="emit('save')">保存时间线</NButton></footer>
        </section>
      </div>
    </div>
    <BatchAudioDialog v-model:show="batchAudioDialog" :project-id="snapshot.project.id" :draft="draft" :artifacts="snapshot.artifacts" :shots="shots" :operations="operations" :disabled="disabled" @apply="applyBatchAudio" />

  </div>
</template>

<style src="../styles/workbench.css"></style>
