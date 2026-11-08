<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NAlert, NButton, NCheckbox, NCollapse, NCollapseItem, NFormItem, NModal, NSelect, NTag } from 'naive-ui';
import type { Candidate, GenerationPlan, GenerationRecord, Project, ProviderSummary, Shot } from '../types.ts';
import { errorMessage } from '../lib/api.ts';
import { generationApi } from '../lib/generationApi.ts';
import { batchImageRows, enqueueBatch, freezeBatchItems } from '../lib/batch-generation.ts';
import type { BatchSubmissionResult } from '../lib/batch-generation.ts';

const props = defineProps<{ show: boolean; project: Project; shots: Shot[]; candidates: Candidate[]; providers: ProviderSummary[]; generations: GenerationRecord[]; disabled: boolean }>();
const emit = defineEmits<{ 'update:show': [show: boolean]; busy: [busy: boolean]; refresh: []; jobs: []; settings: [] }>();
const providerId = ref<string | null>(null);
const quality = ref<GenerationPlan['imageQuality']>('low');
const checkedIds = ref<string[]>([]);
const phase = ref<'checking' | 'registering' | null>(null);
const submitting = computed(() => phase.value !== null);
const attempted = ref(false);
const formError = ref('');
const validations = ref<Record<string, string>>({});
const results = ref<BatchSubmissionResult[]>([]);
const batchSize = ref(0);
const rows = computed(() => batchImageRows(props.shots, props.candidates, props.generations, props.project.ratio, quality.value));
const selectedRows = computed(() => rows.value.filter(row => checkedIds.value.includes(row.shot.id)));
const eligible = computed(() => rows.value.filter(row => !row.skipReason));
const options = computed(() => props.providers.filter(provider => provider.kind === 'openai-images').map(provider => ({ label: `${provider.label} · ${provider.model}`, value: provider.id })));
const provider = computed(() => props.providers.find(item => item.id === providerId.value));
const fingerprint = computed(() => JSON.stringify({ project: props.project.id, provider: provider.value, rows: selectedRows.value.map(row => ({ id: row.shot.id, revision: row.shot.revision, plan: row.plan, skipReason: row.skipReason })) }));
const locked = computed(() => props.disabled || submitting.value || attempted.value);
const canSubmit = computed(() => !locked.value && provider.value && selectedRows.value.length > 0 && selectedRows.value.every(row => !row.skipReason));
const acceptedCount = computed(() => results.value.filter(result => result.record).length);
const stopped = computed(() => attempted.value && !submitting.value && (results.value.some(result => !result.record || result.record.error || ['failed', 'submission_unknown', 'download_failed', 'cancelled'].includes(result.record.status))));
watch(fingerprint, () => { if (!attempted.value) { validations.value = {}; formError.value = ''; } });
watch(() => props.show, show => {
  if (!show) return;
  attempted.value = false; results.value = []; batchSize.value = 0; quality.value = 'low'; providerId.value = options.value[0]?.value || null;
  checkedIds.value = eligible.value.map(row => row.shot.id); validations.value = {}; formError.value = '';
}, { immediate: true });
function toggle(id: string, checked: boolean) { checkedIds.value = checked ? [...new Set([...checkedIds.value, id])] : checkedIds.value.filter(value => value !== id); }
async function submit() {
  if (!canSubmit.value || !provider.value) return;
  const reviewed = fingerprint.value;
  const items = freezeBatchItems(selectedRows.value, provider.value, selectedRows.value.map(() => crypto.randomUUID()));
  phase.value = 'checking'; formError.value = ''; validations.value = {}; emit('busy', true);
  try {
    const failures: Record<string, string> = {};
    for (const item of items) {
      try { const result = await generationApi.validate(item.shotId, item.request.providerId, item.request.plan); if (result.status !== 'valid') failures[item.shotId] = result.issues.map(issue => issue.message).join('；'); }
      catch (error) { failures[item.shotId] = errorMessage(error); }
    }
    if (reviewed !== fingerprint.value) { formError.value = '镜头或连接已有更新，请核对后重新点击生成。'; return; }
    if (Object.keys(failures).length) { validations.value = failures; formError.value = '部分镜头需要调整，请查看下方原因；本批尚未提交生成。'; return; }
    batchSize.value = items.length; attempted.value = true; phase.value = 'registering';
    await enqueueBatch(items, generationApi.submit, result => { results.value = [...results.value, result]; });
  } finally { phase.value = null; emit('busy', false); if (attempted.value) emit('refresh'); }
}
function close() { if (!submitting.value) emit('update:show', false); }
</script>

<template>
  <NModal :show="show" preset="card" title="批量生成图片候选" class="generation-modal batch-generation-modal" :closable="!submitting" :mask-closable="!submitting" :close-on-esc="!submitting" @update:show="close">
    <p class="dialog-intro">统一设置，每镜独立生成一张图片。原计划导入素材或生成视频的镜头也可先生成图片候选。默认跳过已有素材、当前候选和待处理任务；结果仍需你复核采用。</p>
    <NFormItem label="图片模型连接"><NSelect v-model:value="providerId" aria-label="批量图片模型连接" :options="options" :disabled="locked" placeholder="选择已保存的图片连接" /></NFormItem>
    <NAlert v-if="!options.length" type="info" :show-icon="false" class="draft-alert">尚未配置图片连接。<NButton text type="primary" :disabled="locked" @click="emit('settings')">去配置连接</NButton></NAlert>
    <div v-if="provider" class="reasoning-target"><strong>{{ provider.model }}</strong><p>{{ project.ratio }} · 每镜使用自己的画面描述与人物动作。</p></div>
    <NFormItem label="图片质量"><NSelect :value="quality || 'default'" aria-label="批量图片质量" :options="[{ label: '低 · 预览', value: 'low' }, { label: '中 · 标准', value: 'medium' }, { label: '高 · 精细', value: 'high' }, { label: '模型默认', value: 'default' }]" :disabled="locked" @update:value="quality = $event === 'default' ? undefined : $event" /></NFormItem>
    <div class="batch-selection-actions"><strong>已选 {{ selectedRows.length }} / {{ rows.length }} 镜</strong><NButton text :disabled="locked" @click="checkedIds = eligible.map(row => row.shot.id)">全选可生成镜头</NButton><NButton text :disabled="locked" @click="checkedIds = []">清空选择</NButton></div>
    <div class="batch-shot-list">
      <article v-for="row in rows" :key="row.shot.id" class="batch-shot-row">
        <NCheckbox :checked="checkedIds.includes(row.shot.id)" :disabled="locked || !!row.skipReason" :aria-disabled="locked || !!row.skipReason" @update:checked="toggle(row.shot.id, $event)">{{ String(row.shot.order + 1).padStart(2, '0') }} · {{ row.shot.title }}</NCheckbox>
        <span v-if="row.skipReason" class="form-note">跳过：{{ row.skipReason }}</span>
        <span v-else-if="validations[row.shot.id]" class="batch-row-error">{{ validations[row.shot.id] }}</span>
      </article>
    </div>
    <p v-if="!eligible.length && !attempted" class="form-note">当前没有可批量生图的镜头，请查看各镜的跳过原因。已有候选请先复核，参考图请逐镜设置；空白画面描述需先补充。</p>
    <NCollapse v-if="selectedRows.length && !attempted" class="reasoning-context"><NCollapseItem title="查看本批各镜提示词" name="prompts"><article v-for="row in selectedRows" :key="row.shot.id" class="context-shot"><h3>{{ row.shot.title }} · r{{ row.shot.revision }} / 视觉 v{{ row.shot.visualRevision }}</h3><p class="batch-prompt">{{ row.plan.prompt }}</p></article></NCollapseItem></NCollapse>
    <NAlert v-if="formError" type="error" :show-icon="false" class="draft-alert">{{ formError }}</NAlert>
    <p v-if="!attempted" class="form-note">生成后可到任务页查看进度，完成的图片将加入各镜候选。</p>
    <NAlert v-if="attempted" :type="stopped ? 'warning' : 'info'" :show-icon="false" class="draft-alert">已确认登记 {{ acceptedCount }} 镜{{ submitting ? '，正在登记后续镜头…' : stopped ? '，本批已停止，请先核对任务记录。' : '，请到任务页查看生成进度。' }}<span v-if="stopped && batchSize > results.length">另 {{ batchSize - results.length }} 镜尚未登记。</span>登记完成不代表图片已生成。</NAlert>
    <div v-if="results.length" class="batch-results"><article v-for="result in results" :key="result.item.request.clientRequestId"><strong>{{ result.item.title }}</strong><NTag size="small" :bordered="false" :type="result.record ? 'default' : 'warning'">{{ result.record ? '已登记' : '登记未确认' }}</NTag><p v-if="result.error || result.record?.error" class="batch-row-error">{{ result.record?.error?.message || errorMessage(result.error) }} 请核对该镜原任务；本批不会再次发送。</p></article></div>
    <div class="dialog-actions"><NButton :disabled="submitting" @click="close">{{ attempted ? '关闭' : '返回编辑' }}</NButton><NButton v-if="attempted" type="primary" :disabled="submitting" @click="emit('jobs')">查看任务</NButton><NButton v-else type="primary" :disabled="!canSubmit" :loading="submitting" @click="submit">{{ phase === 'checking' ? '正在准备…' : `开始生成 ${selectedRows.length} 镜` }}</NButton></div>
  </NModal>
</template>
