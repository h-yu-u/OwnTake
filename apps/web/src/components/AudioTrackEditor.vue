<script setup lang="ts">
import { MAX_AUDIO_TRACKS } from '../../../../packages/contracts/src/index.ts';
import { computed, ref, watch } from 'vue';
import { NButton, NInputNumber, NSelect } from 'naive-ui';
import type { Artifact, AudioTrack } from '../types.ts';
import EditorSplitPanel from './EditorSplitPanel.vue';
import { artifactUrl } from '../lib/api.ts';
import { formatDuration } from '../lib/timeline.ts';
const props = defineProps<{ modelValue: AudioTrack[]; artifacts: Artifact[]; durationMs: number; disabled: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: AudioTrack[]]; batchSpeech: []; batchAdd: [] }>();
const selectedId = ref<string | null>(null);
const assets = computed(() => new Map(props.artifacts.map(artifact => [artifact.id, artifact])));
const options = computed(() => props.artifacts.filter(artifact => artifact.kind === 'audio').map(artifact => ({ value: artifact.id, label: artifact.name })));
const selected = ref(0);
const current = computed(() => props.modelValue[selected.value]);
const items = computed(() => props.modelValue.map((track, index) => ({ key: `${track.artifactId}:${index}`, label: assets.value.get(track.artifactId)?.name || '音频素材缺失', detail: `${formatDuration(track.startMs)} · ${formatDuration(duration(track))}` })));
watch(() => props.modelValue.length, length => { selected.value = Math.max(0, Math.min(selected.value, length - 1)); });
function update(index: number, patch: Partial<AudioTrack>) { emit('update:modelValue', props.modelValue.map((track, position) => position === index ? { ...track, ...patch } : track)); }
function add() { if (selectedId.value) { selected.value = props.modelValue.length; emit('update:modelValue', [...props.modelValue, { artifactId: selectedId.value, startMs: 0, sourceInMs: 0, gainDb: 0, fadeInMs: 0, fadeOutMs: 0 }]); } }
function duration(track: AudioTrack): number { return Math.max(0, track.durationMs ?? Math.min((assets.value.get(track.artifactId)?.media.durationMs || 0) - track.sourceInMs, props.durationMs - track.startMs)); }
function time(index: number, key: 'startMs' | 'sourceInMs' | 'fadeInMs' | 'fadeOutMs', value: number | null) { if (value !== null) update(index, { [key]: Math.round(value * 1000) }); }
</script>
<template>
  <section id="audio-tracks" class="overlay-editor editor-module" aria-label="独立音轨编辑">
    <div class="panel-heading"><div class="heading-line"><h2>独立音轨</h2><span class="count">{{ modelValue.length }} 条</span></div><div class="heading-actions"><NButton secondary :disabled="disabled || !options.length || durationMs <= 0 || modelValue.length >= MAX_AUDIO_TRACKS" @click="emit('batchAdd')">批量添加音轨</NButton><NButton :disabled="disabled" @click="emit('batchSpeech')">按分镜批量配音</NButton></div></div>
    <div class="audio-track-adder"><NSelect v-model:value="selectedId" :options="options" filterable :disabled="disabled" placeholder="选择已导入的音频素材" aria-label="音轨素材" /><NButton :disabled="disabled || !selectedId || durationMs <= 0 || modelValue.length >= MAX_AUDIO_TRACKS" @click="add">添加音轨</NButton></div>
    <p v-if="!options.length" class="overlay-empty">可按分镜批量生成配音，也可通过「导入素材」添加自己的录音或配乐。</p>
    <EditorSplitPanel v-if="modelValue.length" :items="items" :selected="selected" label="音轨列表" @select="selected = $event"><article v-if="current" class="overlay-row">
      <div class="overlay-row-heading"><div><strong>{{ assets.get(current.artifactId)?.name || '音频素材缺失' }}</strong><span>{{ formatDuration(duration(current)) }}</span></div><NButton text size="small" :disabled="disabled" :aria-label="`移除音轨 ${selected + 1}`" @click="emit('update:modelValue', modelValue.filter((_, position) => position !== selected))">移除</NButton></div>
      <audio v-if="assets.has(current.artifactId)" :src="artifactUrl(current.artifactId)" controls preload="metadata" class="track-source-player" />
      <div class="audio-timing-fields">
        <label class="field-label"><span>片中起点（秒）</span><NInputNumber :value="current.startMs / 1000" :min="0" :max="durationMs / 1000" :precision="3" :show-button="false" :disabled="disabled" @update:value="time(selected, 'startMs', $event)" /></label>
        <label class="field-label"><span>源入点（秒）</span><NInputNumber :value="current.sourceInMs / 1000" :min="0" :max="(assets.get(current.artifactId)?.media.durationMs || 0) / 1000" :precision="3" :show-button="false" :disabled="disabled" @update:value="time(selected, 'sourceInMs', $event)" /></label>
        <label class="field-label"><span>时长（秒，留空自动）</span><NInputNumber :value="current.durationMs === undefined ? null : current.durationMs / 1000" :min="0.001" :max="durationMs / 1000" :precision="3" :show-button="false" clearable :disabled="disabled" placeholder="自动至素材或成片结尾" @update:value="update(selected, { durationMs: $event === null ? undefined : Math.round($event * 1000) })" /></label>
      </div>
      <div class="audio-mix-fields">
        <label class="field-label"><span>增益（dB）</span><NInputNumber :value="current.gainDb" :min="-96" :max="24" :precision="1" :step="1" :show-button="false" :disabled="disabled" @update:value="value => { if (value !== null) update(selected, { gainDb: value }); }" /></label>
        <label class="field-label"><span>淡入（秒）</span><NInputNumber :value="(current.fadeInMs || 0) / 1000" :min="0" :max="duration(current) / 1000" :precision="3" :show-button="false" :disabled="disabled" @update:value="time(selected, 'fadeInMs', $event)" /></label>
        <label class="field-label"><span>淡出（秒）</span><NInputNumber :value="(current.fadeOutMs || 0) / 1000" :min="0" :max="duration(current) / 1000" :precision="3" :show-button="false" :disabled="disabled" @update:value="time(selected, 'fadeOutMs', $event)" /></label>
      </div>
    </article></EditorSplitPanel>
    <p class="panel-footnote">播放器试听原始音频。独立音轨与开启的片段原声一起混入导出；完整字幕与混音请检查导出成片。</p>
  </section>
</template>
