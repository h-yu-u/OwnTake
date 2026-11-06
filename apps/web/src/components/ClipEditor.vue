<script setup lang="ts">
import { computed } from 'vue';
import { NInputNumber, NSelect, NSwitch } from 'naive-ui';
import type { Artifact, TimelineClip } from '../types.ts';

const props = defineProps<{ clip: TimelineClip; artifact?: Artifact; index: number; fps: number; disabled: boolean }>();
const emit = defineEmits<{ change: [patch: Partial<TimelineClip>] }>();
const fits = [{ label: '完整画面 · 留边', value: 'contain' }, { label: '填满画幅 · 裁切', value: 'cover' }];
const isVideo = computed(() => props.artifact?.kind === 'video');
const maxDuration = computed(() => isVideo.value ? Math.max(0, (props.artifact!.media.durationMs - props.clip.sourceInMs) / 1000) : 3600);
function changeStart(value: number | null) {
  if (value === null) return;
  const sourceInMs = Math.max(0, Math.round(value * 1000));
  const durationMs = isVideo.value ? Math.min(props.clip.durationMs, Math.max(0, props.artifact!.media.durationMs - sourceInMs)) : props.clip.durationMs;
  emit('change', { sourceInMs, durationMs });
}
function changeDuration(value: number | null) { if (value !== null) emit('change', { durationMs: Math.max(1, Math.round(value * 1000)) }); }
</script>

<template>
  <div class="clip-fields">
    <label class="field-label"><span>源入点 <small>秒</small></span><NInputNumber :value="clip.sourceInMs / 1000" :min="0" :max="Math.max(0, ((artifact?.media.durationMs || 0) - 1000 / fps) / 1000)" :precision="3" :step="0.1" :show-button="false" :disabled="disabled || !isVideo" :aria-label="`片段 ${index + 1} 源入点（秒）`" @update:value="changeStart" /></label>
    <label class="field-label"><span>使用时长 <small>秒</small></span><NInputNumber :value="clip.durationMs / 1000" :min="Math.ceil(1000 / fps) / 1000" :max="maxDuration" :precision="3" :step="0.1" :show-button="false" :disabled="disabled" :aria-label="`片段 ${index + 1} 使用时长（秒）`" @update:value="changeDuration" /></label>
    <label class="field-label fit-field"><span>画面适配</span><NSelect :value="clip.fit" :options="fits" :disabled="disabled" :aria-label="`片段 ${index + 1} 画面适配`" @update:value="value => emit('change', { fit: value })" /></label>
    <div class="field-label mute-field"><span>保留原声</span><NSwitch :value="!clip.muteSource" :disabled="disabled || !isVideo || !artifact?.media.hasAudio" :aria-label="`片段 ${index + 1} 保留原声`" @update:value="value => emit('change', { muteSource: !value })" /></div>
  </div>
</template>
