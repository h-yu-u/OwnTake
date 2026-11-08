<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NButton, NTag } from 'naive-ui';
import type { Artifact, Shot, TimelineClip, TimelineDraft } from '../types.ts';
import { formatDuration, moveClip, totalDuration } from '../lib/timeline.ts';
import AppIcon from './AppIcon.vue';
import ClipEditor from './ClipEditor.vue';

const props = defineProps<{ modelValue: TimelineDraft; artifacts: Artifact[]; shots: Shot[]; disabled: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: TimelineDraft]; preview: [id: string] }>();
const selected = ref(0);
const assets = computed(() => new Map(props.artifacts.map(asset => [asset.id, asset])));
const shotNames = computed(() => new Map(props.shots.map(shot => [shot.id, shot.title])));
function clipName(clip: TimelineClip) { return (clip.shotId && shotNames.value.get(clip.shotId)) || assets.value.get(clip.artifactId)?.name || '素材缺失'; }
const current = computed(() => props.modelValue.clips[selected.value]);
const duration = computed(() => totalDuration(props.modelValue));
watch(() => props.modelValue.clips.length, length => { selected.value = Math.max(0, Math.min(selected.value, length - 1)); });
function changeClip(index: number, patch: Partial<TimelineClip>) {
  emit('update:modelValue', { ...props.modelValue, clips: props.modelValue.clips.map((clip, position) => position === index ? { ...clip, ...patch } : clip) });
}
function remove(index: number) { emit('update:modelValue', { ...props.modelValue, clips: props.modelValue.clips.filter((_, position) => position !== index) }); }
function move(index: number, direction: -1 | 1) { selected.value = index + direction; emit('update:modelValue', moveClip(props.modelValue, index, direction)); }
function choose(index: number) { selected.value = index; emit('preview', props.modelValue.clips[index]!.artifactId); }
</script>

<template>
  <section class="timeline-panel editor-module" aria-labelledby="timeline-title">
    <div class="panel-heading"><div class="heading-line"><h2 id="timeline-title">顺序时间线</h2><span class="muted small">{{ modelValue.clips.length }} 个片段 · {{ formatDuration(duration) }}</span></div><NTag size="small" :bordered="false">选中片段后调整参数</NTag></div>
    <div v-if="!modelValue.clips.length" class="timeline-empty"><AppIcon name="film" :size="26" /><div><strong>从素材开始，拼出你的节奏</strong><p>选择图片或视频，点击「加入时间线」。片段按从左到右的顺序播放。</p></div></div>
    <template v-else>
      <div class="timeline-ruler"><span>00:00</span><span>{{ formatDuration(duration) }}</span></div>
      <div class="timeline-strip" aria-label="时间线片段">
        <button v-for="(clip, index) in modelValue.clips" :key="`${clip.artifactId}:${index}`" class="timeline-segment" :class="{ selected: selected === index }" :style="{ flexGrow: Math.max(clip.durationMs, 1) }" :aria-pressed="selected === index" :aria-label="`选择片段 ${index + 1}：${clipName(clip)}`" @click="choose(index)"><span class="segment-number">{{ String(index + 1).padStart(2, '0') }}</span><span class="segment-name">{{ clipName(clip) }}</span><small>{{ formatDuration(clip.durationMs) }}</small></button>
      </div>
      <div class="timeline-inspector" tabindex="0" aria-label="当前片段设置">
        <article v-if="current" class="clip-row selected"><div class="clip-topline"><strong>片段 {{ selected + 1 }} · {{ clipName(current) }}</strong><div class="clip-actions"><NButton quaternary size="small" :disabled="disabled || selected === 0" aria-label="向前移动当前片段" @click="move(selected, -1)"><AppIcon name="up" :size="16" /></NButton><NButton quaternary size="small" :disabled="disabled || selected === modelValue.clips.length - 1" aria-label="向后移动当前片段" @click="move(selected, 1)"><AppIcon name="down" :size="16" /></NButton><NButton quaternary size="small" :disabled="disabled" aria-label="移除当前片段" @click="remove(selected)"><AppIcon name="remove" :size="16" /></NButton></div></div><ClipEditor :clip="current" :artifact="assets.get(current.artifactId)" :index="selected" :fps="modelValue.fps" :disabled="disabled" @change="changeClip(selected, $event)" /></article>
      </div>
      <p class="panel-footnote">采用硬切连接。入点与时长用于导出；上方播放器显示源素材，完整结果可在导出后预览。</p>
    </template>
  </section>
</template>
