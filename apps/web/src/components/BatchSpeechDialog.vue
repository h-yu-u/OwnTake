<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NAlert, NButton, NCheckbox, NFormItem, NInput, NInputNumber, NModal, NSelect } from 'naive-ui';
import type { BatchSpeechRequest, ProviderSummary, Shot, StudioOperation } from '../types.ts';
import { errorMessage } from '../lib/api.ts';
import { speechProblems } from '../lib/studio.ts';
import { speechVoiceOptions } from '../lib/speech-voices.ts';
import { studioApi } from '../lib/studioApi.ts';

const props = defineProps<{ show: boolean; projectId: string; boardRevision: number; shots: Shot[]; providers: ProviderSummary[]; records: StudioOperation[]; disabled: boolean }>();
const emit = defineEmits<{ 'update:show': [value: boolean]; busy: [value: boolean]; registered: []; settings: [] }>();
const targetId = ref<string | null>(null), voice = ref<string | null>(null), speed = ref<number | null>(1), instructions = ref('');
const entries = ref<Array<{ shotId: string; revision: number; title: string; text: string; selected: boolean }>>([]);
const submitting = ref(false), attempted = ref(false), formError = ref('');
const frozen = ref<BatchSpeechRequest | null>(null);
const providers = computed(() => props.providers.filter(provider => provider.kind === 'openai-speech' && provider.capabilities.speech));
const provider = computed(() => providers.value.find(provider => provider.id === targetId.value));
const voices = computed(() => speechVoiceOptions(provider.value?.capabilities.speech?.voices || []));
const selected = computed(() => entries.value.filter(entry => entry.selected));
const locked = computed(() => props.disabled || submitting.value || attempted.value);
function activeReason(shotId: string): string {
  return props.records.some(record => record.kind === 'tts' && record.source.shotId === shotId && ['queued', 'submitting', 'received', 'submission_unknown', 'ingest_failed'].includes(record.status)) ? '已有进行中或待核对的配音' : '';
}
const issues = computed(() => selected.value.flatMap(entry => {
  const current = props.shots.find(shot => shot.id === entry.shotId && !shot.archived);
  if (!current || current.revision !== entry.revision) return [`${entry.title}：镜头已改变，请重新打开窗口。`];
  if (activeReason(entry.shotId)) return [`${entry.title}：${activeReason(entry.shotId)}`];
  return speechProblems({ text: entry.text, voice: voice.value || '', speed: speed.value ?? NaN, instructions: instructions.value.trim() || null }, provider.value).map(issue => `${entry.title}：${issue}`);
}));
watch(targetId, () => { voice.value = voices.value[0]?.value || null; });
watch(() => props.show, show => {
  if (!show) return;
  targetId.value = providers.value[0]?.id || null;
  voice.value = voices.value[0]?.value || null; speed.value = 1; instructions.value = ''; formError.value = ''; attempted.value = false; frozen.value = null;
  entries.value = props.shots.filter(shot => !shot.archived).sort((a, b) => a.order - b.order).map(shot => ({ shotId: shot.id, revision: shot.revision, title: shot.title, text: shot.caption, selected: Boolean(shot.caption.trim()) && !activeReason(shot.id) && !props.records.some(record => record.kind === 'tts' && record.source.shotId === shot.id && record.speechBatch?.shotRevision === shot.revision && record.status === 'succeeded') }));
});
async function submit() {
  if (submitting.value || props.disabled) return;
  if (!frozen.value) {
    if (!provider.value || !selected.value.length || issues.value.length) return;
    frozen.value = { clientRequestId: crypto.randomUUID(), targetId: provider.value.id, expectedTargetUpdatedAt: provider.value.updatedAt, expectedBoardRevision: props.boardRevision, voice: voice.value!, speed: speed.value!, instructions: instructions.value.trim() || null, entries: selected.value.map(entry => ({ shotId: entry.shotId, expectedShotRevision: entry.revision, text: entry.text })) };
  }
  attempted.value = true; submitting.value = true; formError.value = ''; emit('busy', true);
  try { await studioApi.batchSpeech(props.projectId, frozen.value); emit('registered'); emit('update:show', false); }
  catch (error) { formError.value = errorMessage(error); }
  finally { submitting.value = false; emit('busy', false); }
}
</script>

<template>
  <NModal :show="show" preset="card" title="按分镜批量配音" class="generation-modal batch-speech-modal" :closable="!submitting" :mask-closable="!submitting" :close-on-esc="!submitting" @update:show="value => emit('update:show', value)">
    <p class="dialog-intro">已从每镜字幕填入台词，只朗读下方文字。统一选择声音后即可批量生成，也可以修改个别台词；不会改动原字幕。</p>
    <NFormItem label="配音模型"><NSelect v-model:value="targetId" :options="providers.map(provider => ({ value: provider.id, label: `${provider.label} · ${provider.model}` }))" aria-label="批量配音模型" :disabled="locked" placeholder="选择配音连接" /></NFormItem>
    <NAlert v-if="!providers.length" type="info" :show-icon="false">尚未配置配音连接。<NButton text type="primary" :disabled="locked" @click="emit('settings')">去设置</NButton></NAlert>
    <div class="batch-speech-voice-fields"><NFormItem label="声音音色"><NSelect v-model:value="voice" :options="voices" filterable aria-label="批量配音声音" :disabled="locked" placeholder="搜索音色、用途或声音 ID" /></NFormItem><NFormItem label="语速"><NInputNumber v-model:value="speed" :min="provider?.capabilities.speech?.minSpeed || 0.25" :max="provider?.capabilities.speech?.maxSpeed || 4" :step="0.1" :disabled="locked" :input-props="{ 'aria-label': '批量配音语速' }" /></NFormItem></div>
    <p class="form-note">中文标签供选音参考，实际效果以试听为准；播报语气可在下方风格指令中调整。</p>
    <NFormItem label="语气与风格（可选）"><NInput v-model:value="instructions" :disabled="locked" :placeholder="provider?.capabilities.speech?.supportsInstructions ? '例如：自然讲述，语气平静，停顿清晰' : '此模型不支持风格指令，请留空'" :maxlength="4096" /></NFormItem>
    <div class="heading-line"><strong>已选 {{ selected.length }} / {{ entries.length }} 镜</strong><NButton text :disabled="locked" @click="entries.forEach(entry => { entry.selected = Boolean(entry.text.trim()) && !activeReason(entry.shotId); })">全选可配音镜头</NButton><NButton text :disabled="locked" @click="entries.forEach(entry => { entry.selected = false; })">清空选择</NButton></div>
    <p class="form-note">默认跳过空台词、已有配音和待处理任务。需要重做已完成配音时，可主动勾选。</p>
    <div class="batch-speech-entries"><article v-for="(entry, index) in entries" :key="entry.shotId" class="batch-speech-entry"><NCheckbox v-model:checked="entry.selected" :disabled="locked || Boolean(activeReason(entry.shotId))">{{ String(index + 1).padStart(2, '0') }} · {{ entry.title }}</NCheckbox><p v-if="activeReason(entry.shotId)" class="form-note">{{ activeReason(entry.shotId) }}</p><NInput v-model:value="entry.text" type="textarea" :autosize="{ minRows: 2, maxRows: 5 }" :disabled="locked || Boolean(activeReason(entry.shotId))" :input-props="{ 'aria-label': `${entry.title}配音台词` }" placeholder="此镜留空则不配音" /></article></div>
    <NAlert v-if="issues.length && !attempted" type="warning" :show-icon="false" class="draft-alert">{{ issues.slice(0, 3).join('；') }}{{ issues.length > 3 ? '…' : '' }}</NAlert>
    <NAlert v-if="formError" type="error" :show-icon="false" class="draft-alert">{{ formError }}<p>可用原批次标识再次查询登记；已登记的任务不会重复创建。</p></NAlert>
    <p class="form-note">生成会调用所选配音服务并按其规则计费。登记后关闭页面也会继续；异常时停止后续镜头，不自动重试。完成后可一键加入时间线，图片镜头会按需要延长以容纳完整配音。</p>
    <template #footer><div class="dialog-actions"><NButton :disabled="submitting" @click="emit('update:show', false)">返回</NButton><NButton type="primary" :loading="submitting" :disabled="props.disabled || submitting || (!attempted && (!selected.length || !provider || issues.length > 0))" @click="submit">{{ attempted ? '查询本次登记' : `开始配音 ${selected.length} 镜` }}</NButton></div></template>
  </NModal>
</template>
