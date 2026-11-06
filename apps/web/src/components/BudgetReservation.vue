<script setup lang="ts">
import { computed } from 'vue';
import { NAlert, NFormItem, NInputNumber, NSelect } from 'naive-ui';
import type { CallRecord, GenerationRecord, Reservation } from '../types.ts';
import { budgetUsed, reservationValid, unknownReservations } from '../lib/budget.ts';
const props = defineProps<{ modelValue: Reservation; calls: CallRecord[]; generations: GenerationRecord[]; disabled: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: Reservation] }>();
const records = computed(() => [...props.calls, ...props.generations]);
const used = computed(() => budgetUsed(records.value, props.modelValue.currency));
const unknownCount = computed(() => unknownReservations(records.value));
function update<K extends keyof Reservation>(key: K, value: Reservation[K]) { emit('update:modelValue', { ...props.modelValue, [key]: value }); }
</script>
<template>
  <div class="budget-reservation">
    <h3 class="reservation-title">本地费用预留</h3>
    <div class="reservation-fields">
      <NFormItem label="币种"><NSelect :value="modelValue.currency" :options="[{ label: 'USD', value: 'USD' }, { label: 'CNY', value: 'CNY' }]" :disabled="disabled" @update:value="update('currency', $event)" /></NFormItem>
      <NFormItem label="本次预留"><NInputNumber :value="modelValue.amount" :min="0" :precision="4" :step="0.1" :disabled="disabled" @update:value="value => { if (value !== null) update('amount', value); }" /></NFormItem>
      <NFormItem label="单次上限"><NInputNumber :value="modelValue.singleLimit" :min="0" :precision="4" :step="1" :disabled="disabled" @update:value="value => { if (value !== null) update('singleLimit', value); }" /></NFormItem>
      <NFormItem label="项目上限"><NInputNumber :value="modelValue.projectLimit" :min="0" :precision="4" :step="1" :disabled="disabled" @update:value="value => { if (value !== null) update('projectLimit', value); }" /></NFormItem>
    </div>
    <p class="form-note">项目的推理、图片和视频调用合计已记录或仍预留 {{ used.toFixed(4) }} {{ modelValue.currency }}。金额由你填写，用于本地限额校验；供应商结算以实际账单为准。免费服务可填写 0。</p>
    <NAlert v-if="!reservationValid(modelValue, used)" type="warning" :show-icon="false" class="draft-alert">本次预留超过单次或项目上限，请调整后再提交。</NAlert>
    <NAlert v-if="unknownCount" type="warning" :show-icon="false" class="draft-alert">有 {{ unknownCount }} 次提交结果不明，原预留继续计入用量。新的请求不会恢复或重发旧调用；未知费用可保持待核对。</NAlert>
  </div>
</template>
