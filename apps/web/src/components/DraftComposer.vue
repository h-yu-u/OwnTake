<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NAlert, NButton, NForm, NFormItem, NModal, NSelect, NTag } from 'naive-ui';
import type { Artifact, DraftOperation, Shot, ShotFields } from '../types.ts';
import { emptyShotFields, operationTitle, shotFields, shotProblems } from '../lib/storyboard.ts';
import ShotFieldsForm from './ShotFieldsForm.vue';
const props = defineProps<{ show: boolean; shots: Shot[]; artifacts: Artifact[]; disabled: boolean }>();
const emit = defineEmits<{ 'update:show': [value: boolean]; create: [operations: DraftOperation[]] }>();
const operations = ref<DraftOperation[]>([]);
const kind = ref<'add' | 'update' | 'delete'>('add');
const targetId = ref<string | null>(null);
const fields = ref<ShotFields>(emptyShotFields());
const problems = computed(() => kind.value === 'delete' ? [] : shotProblems(fields.value));
const duplicate = computed(() => kind.value !== 'add' && operations.value.some(operation => operation.shotId === targetId.value));
const targetOptions = computed(() => props.shots.map(shot => ({ label: shot.title, value: shot.id })));
watch(() => props.show, show => { if (show) { operations.value = []; kind.value = 'add'; targetId.value = null; fields.value = emptyShotFields(props.shots.length); } });
watch([kind, targetId], () => {
  const target = props.shots.find(shot => shot.id === targetId.value);
  fields.value = kind.value !== 'add' && target ? shotFields(target) : emptyShotFields(props.shots.length + operations.value.filter(operation => operation.kind === 'add').length);
});
function addOperation() {
  if (problems.value.length || duplicate.value || (kind.value !== 'add' && !targetId.value)) return;
  operations.value = [...operations.value, { id: crypto.randomUUID(), kind: kind.value, ...(kind.value !== 'add' ? { shotId: targetId.value! } : {}), ...(kind.value !== 'delete' ? { fields: shotFields(fields.value) } : {}) }];
  if (kind.value === 'add') fields.value = emptyShotFields(props.shots.length + operations.value.filter(operation => operation.kind === 'add').length);
}
</script>

<template>
  <NModal :show="show" preset="card" title="新建修改草稿" class="draft-composer-modal" :mask-closable="!disabled" :closable="!disabled" @update:show="emit('update:show', $event)"><p class="dialog-intro">把多个镜头变化放入一份草稿，随后逐项审阅。保存草稿不会修改现有分镜。</p><div class="draft-composer-layout"><NForm @submit.prevent="addOperation"><div class="shot-form-row"><NFormItem label="变更方式"><NSelect v-model:value="kind" :options="[{ label: '新增镜头', value: 'add' }, { label: '修改镜头', value: 'update' }, { label: '归档镜头', value: 'delete' }]" :disabled="disabled" /></NFormItem><NFormItem v-if="kind !== 'add'" label="目标镜头"><NSelect v-model:value="targetId" :options="targetOptions" :disabled="disabled" placeholder="选择一个镜头" /></NFormItem></div><ShotFieldsForm v-if="kind === 'add' || (kind === 'update' && targetId)" v-model="fields" :artifacts="artifacts" :disabled="disabled" compact /><NAlert v-if="kind === 'delete' && targetId" type="warning" :show-icon="false" class="draft-alert">接受此项后会将镜头移出当前分镜顺序，历史素材与候选继续保留。</NAlert><NAlert v-if="duplicate" type="warning" :show-icon="false" class="draft-alert">这份草稿已经包含该镜头的变化，请先移除原条目。</NAlert><NButton attr-type="submit" :disabled="disabled || duplicate || problems.length > 0 || (kind !== 'add' && !targetId)">加入这份草稿</NButton></NForm><div class="draft-queue"><div class="panel-heading"><h2>待审阅变化</h2><span class="muted small">{{ operations.length }} 项</span></div><p v-if="!operations.length" class="draft-empty">填写一项变更，再加入草稿。</p><div v-for="operation in operations" :key="operation.id" class="draft-queue-item"><NTag size="small" :bordered="false">{{ operation.kind === 'add' ? '新增' : operation.kind === 'update' ? '修改' : '归档' }}</NTag><strong>{{ operationTitle(operation, shots) }}</strong><NButton text size="small" :disabled="disabled" @click="operations = operations.filter(item => item.id !== operation.id)">移除</NButton></div></div></div><div class="dialog-actions"><NButton :disabled="disabled" @click="emit('update:show', false)">取消</NButton><NButton type="primary" :loading="disabled" :disabled="disabled || !operations.length" @click="emit('create', operations)">保存草稿 · 稍后审阅</NButton></div></NModal>
</template>
