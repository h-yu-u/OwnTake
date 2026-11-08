<script setup lang="ts">
import { computed, ref } from 'vue';
import { NSelect } from 'naive-ui';
import type { OpenAIModelOptionGroup } from '../lib/openaiModelOptions.ts';

const props = defineProps<{ value: string; options: OpenAIModelOptionGroup[]; label: string; disabled: boolean }>();
const emit = defineEmits<{ 'update:value': [value: string] }>();
const query = ref('');
const filtered = computed<OpenAIModelOptionGroup[]>(() => {
  const value = query.value.trim();
  if (!value) return props.options;
  const pattern = value.toLowerCase();
  const groups = props.options.map(group => ({ ...group, children: group.children.filter(option => option.label.toLowerCase().includes(pattern)) })).filter(group => group.children.length);
  if (value.length <= 200 && !props.options.some(group => group.children.some(option => option.value === value))) {
    groups.unshift({ type: 'group', key: 'manual', label: '手动输入模型 ID', children: [{ label: value, value }] });
  }
  return groups;
});
function select(value: unknown): void {
  if (typeof value === 'string') { emit('update:value', value); query.value = ''; }
}
</script>

<template>
  <!-- Grouped tag matching is handled here so known IDs are not duplicated as new tags. -->
  <NSelect :value="value" :options="filtered" filterable tag remote :disabled="disabled" :aria-label="label" :input-props="{ 'aria-label': label }" placeholder="选择模型，或输入实际可用的模型 ID" @search="query = $event" @update:value="select" @update:show="shown => { if (!shown) query = ''; }" />
</template>
