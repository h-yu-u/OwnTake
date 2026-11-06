<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NButton, NTag } from 'naive-ui';
import type { Artifact, TimelineClip, TimelineDraft } from '../types.ts';
import { formatDuration, moveClip, totalDuration } from '../lib/timeline.ts';
import AppIcon from './AppIcon.vue';
import ClipEditor from './ClipEditor.vue';

const props = defineProps<{ modelValue: TimelineDraft; artifacts: Artifact[]; disabled: boolean; dirty: boolean; version: number; saving: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: TimelineDraft]; save: []; preview: [id: string] }>();
const selected = ref(0);
const assets = computed(() => new Map(props.artifacts.map(asset => [asset.id, asset])));
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
  <section class="panel timeline-panel" aria-labelledby="timeline-title">
    <div class="panel-heading">
      <div class="heading-line"><h2 id="timeline-title">顺序时间线</h2><NTag size="small" :bordered="false" :type="dirty ? 'warning' : 'default'">{{ dirty ? '有未保存修改' : version ? `已保存 · v${version}` : '未开始' }}</NTag></div>
      <div class="heading-line"><span class="muted small">{{ modelValue.clips.length }} 个片段 · {{ formatDuration(duration) }}</span><NButton size="small" :loading="saving" :disabled="disabled || !modelValue.clips.length || (!dirty && version > 0)" @click="emit('save')">保存时间线</NButton></div>
    </div>
    <div v-if="!modelValue.clips.length" class="timeline-empty"><AppIcon name="film" :size="26" /><div><strong>从素材开始，拼出你的节奏</strong><p>选择图片或视频，点击「加入时间线」。片段按从左到右的顺序播放。</p></div></div>
    <template v-else>
      <div class="timeline-ruler"><span>00:00</span><span>{{ formatDuration(duration) }}</span></div>
      <div class="timeline-strip" aria-label="时间线片段">
        <button v-for="(clip, index) in modelValue.clips" :key="`${clip.artifactId}:${index}`" class="timeline-segment" :class="{ selected: selected === index }" :style="{ flexGrow: Math.max(clip.durationMs, 1) }" :aria-pressed="selected === index" :aria-label="`选择片段 ${index + 1}：${assets.get(clip.artifactId)?.name || '素材缺失'}`" @click="choose(index)"><span class="segment-number">{{ String(index + 1).padStart(2, '0') }}</span><span class="segment-name">{{ assets.get(clip.artifactId)?.name || '素材缺失' }}</span><small>{{ formatDuration(clip.durationMs) }}</small></button>
      </div>
      <div class="clip-list">
        <article v-for="(clip, index) in modelValue.clips" :key="`${clip.artifactId}:${index}`" class="clip-row" :class="{ selected: selected === index }">
          <div class="clip-topline"><button class="clip-select" :aria-label="`预览片段 ${index + 1}`" @click="choose(index)"><span class="clip-number">{{ String(index + 1).padStart(2, '0') }}</span><AppIcon :name="assets.get(clip.artifactId)?.kind === 'image' ? 'image' : 'film'" :size="17" /><strong>{{ assets.get(clip.artifactId)?.name || '素材缺失' }}</strong></button><div class="clip-actions"><NButton quaternary size="small" :disabled="disabled || index === 0" :aria-label="`向前移动片段 ${index + 1}`" @click="move(index, -1)"><AppIcon name="up" :size="16" /></NButton><NButton quaternary size="small" :disabled="disabled || index === modelValue.clips.length - 1" :aria-label="`向后移动片段 ${index + 1}`" @click="move(index, 1)"><AppIcon name="down" :size="16" /></NButton><NButton quaternary size="small" :disabled="disabled" :aria-label="`移除片段 ${index + 1}`" @click="remove(index)"><AppIcon name="remove" :size="16" /></NButton></div></div>
          <ClipEditor :clip="clip" :artifact="assets.get(clip.artifactId)" :index="index" :fps="modelValue.fps" :disabled="disabled" @change="changeClip(index, $event)" />
        </article>
      </div>
      <p class="panel-footnote">采用硬切连接。入点与时长用于导出；上方播放器显示源素材，完整结果可在导出后预览。</p>
    </template>
  </section>
</template>
