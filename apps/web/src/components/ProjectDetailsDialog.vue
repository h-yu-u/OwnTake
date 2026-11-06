<script setup lang="ts">
import { reactive, ref, watch } from 'vue';
import { NButton, NForm, NFormItem, NInput, NModal, NSelect } from 'naive-ui';
import type { Project, Ratio } from '../types.ts';
const props = defineProps<{ show: boolean; project: Project; disabled: boolean }>();
const emit = defineEmits<{ 'update:show': [value: boolean]; save: [input: { name: string; brief: string; ratio: Ratio; expectedRevision: number }] }>();
const form = reactive({ name: '', brief: '', ratio: '16:9' as Ratio });
const revision = ref(0);
watch(() => props.show, show => { if (show) { Object.assign(form, { name: props.project.name, brief: props.project.brief, ratio: props.project.ratio }); revision.value = props.project.revision; } });
function save() { if (form.name.trim() && !props.disabled) emit('save', { name: form.name.trim(), brief: form.brief.trim(), ratio: form.ratio, expectedRevision: revision.value }); }
</script>
<template>
  <NModal :show="show" preset="card" title="作品与创作简报" class="project-details-modal" :mask-closable="!disabled" :closable="!disabled" @update:show="emit('update:show', $event)"><NForm @submit.prevent="save"><NFormItem label="作品名称"><NInput v-model:value="form.name" :maxlength="100" :disabled="disabled" /></NFormItem><NFormItem label="创作简报"><NInput v-model:value="form.brief" type="textarea" :rows="7" :maxlength="4000" :disabled="disabled" placeholder="想拍什么、面向谁、希望什么氛围，以及要保留的细节。推理模型会以此为依据。" /></NFormItem><NFormItem label="项目画幅"><NSelect v-model:value="form.ratio" :options="[{ label: '16:9 · 横屏', value: '16:9' }, { label: '9:16 · 竖屏', value: '9:16' }, { label: '1:1 · 方形', value: '1:1' }]" :disabled="disabled" /></NFormItem><p class="form-note">项目画幅用于首次时间线的默认尺寸；已有时间线的输出设置会保留，可在导出页单独调整。</p><div class="dialog-actions"><NButton :disabled="disabled" @click="emit('update:show', false)">取消</NButton><NButton type="primary" attr-type="submit" :loading="disabled" :disabled="disabled || !form.name.trim()">保存简报</NButton></div></NForm></NModal>
</template>
