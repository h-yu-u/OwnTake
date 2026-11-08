<script setup lang="ts">
import { computed } from 'vue';
import { NAlert, NButton, NTag } from 'naive-ui';
import type { StudioOperation } from '../types.ts';
import { formatDate } from '../lib/timeline.ts';
const props = defineProps<{ records: StudioOperation[]; disabled: boolean }>();
const emit = defineEmits<{ apply: [id: string]; cancel: [id: string] }>();
const batches = computed(() => {
  const grouped = new Map<string, StudioOperation[]>();
  for (const record of props.records) if (record.speechBatch) grouped.set(record.speechBatch.id, [...(grouped.get(record.speechBatch.id) || []), record]);
  return [...grouped].map(([id, records]) => ({ id, records, createdAt: records[0]!.createdAt, complete: records.filter(record => record.status === 'succeeded').length, active: records.some(record => ['queued', 'submitting', 'received'].includes(record.status)), queued: records.some(record => record.status === 'queued'), problems: records.filter(record => ['failed', 'submission_unknown', 'ingest_failed', 'cancelled'].includes(record.status)).length })).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
});
</script>
<template>
  <section v-if="batches.length" class="speech-batches" aria-label="分镜批量配音记录"><article v-for="batch in batches" :key="batch.id" class="panel speech-batch-card"><div class="panel-heading"><div><h2>分镜批量配音 <span class="count">{{ batch.complete }} / {{ batch.records.length }}</span></h2><p class="form-note">{{ formatDate(batch.createdAt) }} · {{ batch.records[0]?.targetModel }}</p></div><NTag :bordered="false" :type="batch.active ? 'info' : batch.problems ? 'warning' : 'success'">{{ batch.active ? '正在配音' : batch.problems ? '部分镜头未完成' : '配音完成' }}</NTag></div><NAlert v-if="batch.problems" type="warning" :show-icon="false">{{ batch.problems }} 镜未完成。已完成的结果会保留，可先加入时间线；具体原因见下方操作记录。</NAlert><p class="form-note">按时间线中的镜头位置加入配音。图片镜头按需要延长，后续镜头与字幕顺延；视频时长不足会提示调整。</p><div class="heading-actions"><NButton v-if="batch.queued" :disabled="disabled" @click="emit('cancel', batch.id)">停止后续配音</NButton><NButton type="primary" :disabled="disabled || batch.active || !batch.complete" @click="emit('apply', batch.id)">将已完成配音加入时间线</NButton></div></article></section>
</template>
