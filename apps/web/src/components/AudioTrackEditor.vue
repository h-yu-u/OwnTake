<script setup lang="ts">
import { computed, ref } from 'vue';
import { NButton, NInputNumber, NSelect } from 'naive-ui';
import type { Artifact, AudioTrack } from '../types.ts';
import { artifactUrl } from '../lib/api.ts';
import { formatDuration } from '../lib/timeline.ts';
const props = defineProps<{ modelValue: AudioTrack[]; artifacts: Artifact[]; durationMs: number; disabled: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: AudioTrack[]] }>();
const selectedId = ref<string | null>(null);
const assets = computed(() => new Map(props.artifacts.map(artifact => [artifact.id, artifact])));
const options = computed(() => props.artifacts.filter(artifact => artifact.kind === 'audio').map(artifact => ({ value: artifact.id, label: artifact.name })));
function update(index: number, patch: Partial<AudioTrack>) { emit('update:modelValue', props.modelValue.map((track, position) => position === index ? { ...track, ...patch } : track)); }
function add() { if (selectedId.value) emit('update:modelValue', [...props.modelValue, { artifactId: selectedId.value, startMs: 0, sourceInMs: 0, gainDb: 0, fadeInMs: 0, fadeOutMs: 0 }]); }
function duration(track: AudioTrack): number { return Math.max(0, track.durationMs ?? Math.min((assets.value.get(track.artifactId)?.media.durationMs || 0) - track.sourceInMs, props.durationMs - track.startMs)); }
function time(index: number, key: 'startMs' | 'sourceInMs' | 'fadeInMs' | 'fadeOutMs', value: number | null) { if (value !== null) update(index, { [key]: Math.round(value * 1000) }); }
</script>
<template>
  <section id="audio-tracks" class="panel overlay-editor" aria-label="独立音轨编辑">
    <div class="panel-heading"><div class="heading-line"><h2>独立音轨</h2><span class="count">{{ modelValue.length }} / 16</span></div></div>
    <div class="audio-track-adder"><NSelect v-model:value="selectedId" :options="options" filterable :disabled="disabled" placeholder="选择已导入的音频素材" aria-label="音轨素材" /><NButton :disabled="disabled || !selectedId || durationMs <= 0 || modelValue.length >= 16" @click="add">添加音轨</NButton></div>
    <p v-if="!options.length" class="overlay-empty">从上方素材库导入音频，再加入配乐或旁白。</p>
    <div class="overlay-rows"><article v-for="(track, index) in modelValue" :key="`${track.artifactId}:${index}`" class="overlay-row">
      <div class="overlay-row-heading"><div><strong>{{ assets.get(track.artifactId)?.name || '音频素材缺失' }}</strong><span>{{ formatDuration(duration(track)) }}</span></div><NButton text size="small" :disabled="disabled" :aria-label="`移除音轨 ${index + 1}`" @click="emit('update:modelValue', modelValue.filter((_, position) => position !== index))">移除</NButton></div>
      <audio v-if="assets.has(track.artifactId)" :src="artifactUrl(track.artifactId)" controls preload="metadata" class="track-source-player" />
      <div class="audio-timing-fields">
        <label class="field-label"><span>片中起点（秒）</span><NInputNumber :value="track.startMs / 1000" :min="0" :max="durationMs / 1000" :precision="3" :show-button="false" :disabled="disabled" @update:value="time(index, 'startMs', $event)" /></label>
        <label class="field-label"><span>源入点（秒）</span><NInputNumber :value="track.sourceInMs / 1000" :min="0" :max="(assets.get(track.artifactId)?.media.durationMs || 0) / 1000" :precision="3" :show-button="false" :disabled="disabled" @update:value="time(index, 'sourceInMs', $event)" /></label>
        <label class="field-label"><span>时长（秒，留空自动）</span><NInputNumber :value="track.durationMs === undefined ? null : track.durationMs / 1000" :min="0.001" :max="durationMs / 1000" :precision="3" :show-button="false" clearable :disabled="disabled" placeholder="自动至素材或成片结尾" @update:value="update(index, { durationMs: $event === null ? undefined : Math.round($event * 1000) })" /></label>
      </div>
      <div class="audio-mix-fields">
        <label class="field-label"><span>增益（dB）</span><NInputNumber :value="track.gainDb" :min="-96" :max="24" :precision="1" :step="1" :show-button="false" :disabled="disabled" @update:value="value => { if (value !== null) update(index, { gainDb: value }); }" /></label>
        <label class="field-label"><span>淡入（秒）</span><NInputNumber :value="(track.fadeInMs || 0) / 1000" :min="0" :max="duration(track) / 1000" :precision="3" :show-button="false" :disabled="disabled" @update:value="time(index, 'fadeInMs', $event)" /></label>
        <label class="field-label"><span>淡出（秒）</span><NInputNumber :value="(track.fadeOutMs || 0) / 1000" :min="0" :max="duration(track) / 1000" :precision="3" :show-button="false" :disabled="disabled" @update:value="time(index, 'fadeOutMs', $event)" /></label>
      </div>
    </article></div>
    <p class="panel-footnote">播放器试听原始音频。独立音轨与开启的片段原声一起混入导出；完整字幕与混音请检查导出成片。</p>
  </section>
</template>
