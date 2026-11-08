<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import EditorSplitPanel from './EditorSplitPanel.vue';
import { formatDuration } from '../lib/timeline.ts';
import { NButton, NColorPicker, NInput, NInputNumber, NSelect } from 'naive-ui';
import type { Caption } from '../types.ts';
import AppIcon from './AppIcon.vue';
const props = defineProps<{ modelValue: Caption[]; durationMs: number; fps: number; disabled: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: Caption[]]; settings: [] }>();
const selected = ref(0);
const current = computed(() => props.modelValue[selected.value]);
const items = computed(() => props.modelValue.map((caption, index) => ({ key: String(index), label: caption.text.trim() || '未填写字幕', detail: `${formatDuration(caption.startMs)} → ${formatDuration(caption.endMs)}` })));
watch(() => props.modelValue.length, length => { selected.value = Math.max(0, Math.min(selected.value, length - 1)); });
function update(index: number, patch: Partial<Caption>) { emit('update:modelValue', props.modelValue.map((caption, position) => position === index ? { ...caption, ...patch } : caption)); }
function style(index: number, patch: Partial<NonNullable<Caption['style']>>) {
  const next = { ...props.modelValue[index]!.style, ...patch };
  update(index, { style: Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined && value !== '')) });
}
function add() {
  selected.value = props.modelValue.length;
  const frame = Math.ceil(1000 / props.fps), endMs = Math.floor(props.durationMs);
  const startMs = Math.max(0, Math.min(props.modelValue.at(-1)?.endMs || 0, endMs - frame));
  emit('update:modelValue', [...props.modelValue, { startMs, endMs: Math.min(endMs, startMs + 3000), text: '' }]);
}
</script>
<template>
  <section class="overlay-editor editor-module">
    <div class="panel-heading"><div class="heading-line"><h2>字幕</h2><span class="count">{{ modelValue.length }}</span></div><NButton size="small" :disabled="disabled || durationMs < 1000 / fps || modelValue.length >= 1000" @click="add"><template #icon><AppIcon name="plus" :size="15" /></template>添加字幕</NButton></div>
    <p v-if="!modelValue.length" class="overlay-empty">为片中某一刻写下一句话。字幕按设定时段烧录到导出成片。</p>
    <EditorSplitPanel v-if="modelValue.length" :items="items" :selected="selected" label="字幕列表" @select="selected = $event"><article v-if="current" class="overlay-row">
      <div class="overlay-row-heading"><span class="clip-number">字幕 {{ String(selected + 1).padStart(2, '0') }}</span><NButton text size="small" :disabled="disabled" :aria-label="`移除字幕 ${selected + 1}`" @click="emit('update:modelValue', modelValue.filter((_, position) => position !== selected))">移除</NButton></div>
      <NInput :value="current.text" type="textarea" :autosize="{ minRows: 2, maxRows: 5 }" :maxlength="2000" :disabled="disabled" :input-props="{ 'aria-label': `字幕 ${selected + 1} 内容` }" placeholder="字幕内容" @update:value="update(selected, { text: $event })" />
      <div class="caption-timing-fields">
        <label class="field-label"><span>开始（秒）</span><NInputNumber :value="current.startMs / 1000" :min="0" :max="durationMs / 1000" :precision="3" :step="0.1" :show-button="false" :disabled="disabled" @update:value="value => { if (value !== null) update(selected, { startMs: Math.round(value * 1000) }); }" /></label>
        <label class="field-label"><span>结束（秒）</span><NInputNumber :value="current.endMs / 1000" :min="0" :max="durationMs / 1000" :precision="3" :step="0.1" :show-button="false" :disabled="disabled" @update:value="value => { if (value !== null) update(selected, { endMs: Math.round(value * 1000) }); }" /></label>
        <label class="field-label"><span>位置</span><NSelect :value="current.style?.position || 'bottom'" :options="[{ label: '底部', value: 'bottom' }, { label: '居中', value: 'center' }, { label: '顶部', value: 'top' }]" :disabled="disabled" @update:value="style(selected, { position: $event })" /></label>
      </div>
      <div class="caption-style-fields">
        <label class="field-label"><span>字体族（可选）</span><NInput :value="current.style?.fontFamily || ''" :disabled="disabled" placeholder="使用默认字体" @update:value="style(selected, { fontFamily: $event })" /></label>
        <label class="field-label"><span>字号（输出像素）</span><NInputNumber :value="current.style?.fontSize ?? null" :min="8" :max="200" :precision="0" :show-button="false" clearable :disabled="disabled" placeholder="默认" @update:value="style(selected, { fontSize: $event ?? undefined })" /></label>
        <label class="field-label"><span>文字颜色</span><NColorPicker :value="current.style?.color || '#FFFFFF'" :modes="['hex']" :show-alpha="false" :disabled="disabled" @update:value="style(selected, { color: $event })" /></label>
      </div>
    </article></EditorSplitPanel>
    <p class="panel-footnote">字幕只在完整导出中合成。中文显示取决于实际字体；可在<NButton text type="primary" size="small" @click="emit('settings')">工具设置</NButton>指定字体文件，并通过成片检查字形。</p>
  </section>
</template>
