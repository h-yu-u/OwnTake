<script setup lang="ts">
import { reactive, watch } from 'vue';
import { NButton, NForm, NFormItem, NInput, NModal, NSelect } from 'naive-ui';
import type { Ratio } from '../types.ts';
const props = defineProps<{ show: boolean; busy: boolean }>();
const emit = defineEmits<{ 'update:show': [value: boolean]; create: [input: { name: string; brief: string; ratio: Ratio }] }>();
const form = reactive({ name: '', brief: '', ratio: '16:9' as Ratio });
const ratios = [{ label: '16:9 · 横屏', value: '16:9' }, { label: '9:16 · 竖屏', value: '9:16' }, { label: '1:1 · 方形', value: '1:1' }];
watch(() => props.show, show => { if (show) { form.name = ''; form.brief = ''; form.ratio = '16:9'; } });
function submit() { if (form.name.trim() && !props.busy) emit('create', { name: form.name.trim(), brief: form.brief.trim(), ratio: form.ratio }); }
</script>
<template>
  <NModal :show="show" preset="card" title="开始一部新作品" class="project-modal" :mask-closable="!busy" :close-on-esc="!busy" :closable="!busy" @update:show="emit('update:show', $event)">
    <p class="dialog-intro">给作品一个名字，把想法留在自己的片场。</p>
    <NForm @submit.prevent="submit">
      <NFormItem label="作品名称" label-for="project-name"><NInput id="project-name" v-model:value="form.name" placeholder="例如：一段城市的晨光" :maxlength="100" :disabled="busy" autofocus /></NFormItem>
      <NFormItem label="创作简报" label-for="project-brief"><NInput id="project-brief" v-model:value="form.brief" type="textarea" placeholder="想拍什么，什么氛围，有哪些想保留的画面？" :rows="4" :maxlength="4000" :disabled="busy" /></NFormItem>
      <NFormItem label="画幅" label-for="project-ratio"><NSelect id="project-ratio" v-model:value="form.ratio" :options="ratios" :disabled="busy" /></NFormItem>
      <div class="dialog-actions"><NButton :disabled="busy" @click="emit('update:show', false)">取消</NButton><NButton type="primary" attr-type="submit" :loading="busy" :disabled="!form.name.trim()">创建项目</NButton></div>
    </NForm>
  </NModal>
</template>
