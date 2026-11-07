<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NAlert, NButton, NCheckbox, NForm, NFormItem, NInput, NInputNumber, NModal, NSelect, NTag } from 'naive-ui';
import type { ShotCastBinding, Artifact, CallRecord, StudioOperation, GenerationPlan, GenerationRecord, PlanValidationResult, Project, ProviderSummary, Reservation, Shot } from '../types.ts';
import { artifactUrl, errorMessage } from '../lib/api.ts';
import { generationApi } from '../lib/generationApi.ts';
import type { GenerationRequest } from '../lib/generationApi.ts';
import { budgetUsed, reservationValid, unknownReservations } from '../lib/budget.ts';
import { initialGenerationPlan, inputModeOptions, ratioOptions } from '../lib/generation.ts';
import AppIcon from './AppIcon.vue';
import ShotCastPanel from './ShotCastPanel.vue';
import BudgetReservation from './BudgetReservation.vue';

const props = defineProps<{ show: boolean; shot: Shot; project: Project; providers: ProviderSummary[]; artifacts: Artifact[]; calls: CallRecord[]; generations: GenerationRecord[]; studioOperations: StudioOperation[]; disabled: boolean }>();
const emit = defineEmits<{ 'update:show': [value: boolean]; submit: [input: { shotId: string; request: GenerationRequest }]; settings: []; 'cast-bound': []; characters: [] }>();
const plan = ref<GenerationPlan>(initialGenerationPlan(props.shot, props.project.ratio));
const providerId = ref<string | null>(null);
const castBindings=ref<ShotCastBinding[]>([]);
const reservation = ref<Reservation>({ currency: 'USD', amount: 0.1, singleLimit: 1, projectLimit: 5 });
const acknowledged = ref(false);
const independentAcknowledged = ref(false);
const operationId = ref('');
const shotRevision = ref(props.shot.revision);
const validation = ref<PlanValidationResult | null>(null);
const validationError = ref('');
const validating = ref(false);
const provider = computed(() => props.providers.find(item => item.id === providerId.value));
const matches=(kind:'image'|'video',provider:ProviderSummary)=>
  kind === 'video' ? provider.kind==='ark-video' :
    provider.kind==='openai-images'||provider.kind==='openai-image-edits';
const providerOptions = computed(() => props.providers.filter(item=>matches(plan.value.kind,item)).map(item => ({ label: `${item.label} · ${item.model}`, value: item.id })));
const referenceOptions = computed(() => props.artifacts.filter(artifact => artifact.kind === 'image').map(artifact => ({ label: artifact.name, value: artifact.id })));
const artifactMap = computed(() => new Map(props.artifacts.map(artifact => [artifact.id, artifact])));
const unknownCount = computed(() => unknownReservations([...props.calls, ...props.generations, ...props.studioOperations]));
const used = computed(() => budgetUsed([...props.calls, ...props.generations, ...props.studioOperations], reservation.value.currency));
const shotChanged = computed(() => shotRevision.value !== props.shot.revision);
const fingerprint = computed(() => JSON.stringify({ providerId: providerId.value, providerRevision: provider.value?.updatedAt, shotRevision: shotRevision.value, plan: plan.value }));
const canSubmit = computed(() => !shotChanged.value && validation.value?.status === 'valid' && provider.value && acknowledged.value && (!unknownCount.value || independentAcknowledged.value) && reservationValid(reservation.value, used.value));
let validationSequence = 0;

function appendCastPrompt():void {
  const cast=castBindings.value.filter(role=>plan.value.referenceArtifactIds.includes(role.referenceArtifactId));
  if(!cast.length)return;
  const notes=cast.map(role=>{
    const slot=plan.value.referenceArtifactIds.indexOf(role.referenceArtifactId)+1;
    return `参考图 ${slot} 是「${role.characterName}」饰演「${role.roleName}」的固定人物形象 v${role.visualVersion}；请保持同一人物的脸部特征，不混合其他角色。`;
  }).join('\n');
  if(!plan.value.prompt.includes(notes))plan.value={...plan.value,prompt:[plan.value.prompt,notes].filter(Boolean).join('\n\n')};
}
function resetReview() { ++validationSequence; validation.value = null; validationError.value = ''; acknowledged.value = false; independentAcknowledged.value = false; operationId.value = crypto.randomUUID(); }
watch(() => props.show, show => {
  if (show) { castBindings.value = []; plan.value = initialGenerationPlan(props.shot, props.project.ratio); shotRevision.value = props.shot.revision; providerId.value = props.providers.find(item => matches(plan.value.kind,item) && (plan.value.referenceArtifactIds.length ? item.kind !== 'openai-images' : true))?.id || null; resetReview(); }
}, { immediate: true });
watch(fingerprint, resetReview);
watch(() => props.shot.revision, resetReview);
watch(() => JSON.stringify(reservation.value), () => { acknowledged.value = false; operationId.value = crypto.randomUUID(); });
function changeKind(kind: 'image' | 'video') {
  const next = { ...plan.value, kind };
  if (kind === 'video') next.durationSec = props.shot.durationMs / 1000;
  else delete next.durationSec;
  plan.value = next; providerId.value = props.providers.find(item => matches(kind,item) && (plan.value.referenceArtifactIds.length ? item.kind !== 'openai-images' : true))?.id || null;
}
function moveReference(index: number, direction: -1 | 1) {
  const references = [...plan.value.referenceArtifactIds]; const target = index + direction;
  if (target < 0 || target >= references.length) return;
  [references[index], references[target]] = [references[target]!, references[index]!];
  plan.value = { ...plan.value, referenceArtifactIds: references };
}
function referenceLabel(index: number): string {
  return plan.value.inputMode === 'first_last_frame' ? index === 0 ? '首帧' : index === 1 ? '尾帧' : '多余引用，请移除' : plan.value.inputMode === 'first_frame' ? index === 0 ? '首帧' : '多余引用，请移除' : `参考 ${index + 1}`;
}
async function validate() {
  if (!providerId.value || shotChanged.value) return;
  const sequence = ++validationSequence; const reviewed = fingerprint.value;
  validating.value = true; validationError.value = ''; validation.value = null;
  try { const result = await generationApi.validate(props.shot.id, providerId.value, { ...plan.value, referenceArtifactIds: [...plan.value.referenceArtifactIds] }); if (sequence === validationSequence && reviewed === fingerprint.value) validation.value = result; }
  catch (error) { if (sequence === validationSequence) validationError.value = errorMessage(error); }
  finally { validating.value = false; }
}
function submit() {
  if (!canSubmit.value || props.disabled || !provider.value) return;
  emit('submit', { shotId: props.shot.id, request: { providerId: provider.value.id, plan: { ...plan.value, referenceArtifactIds: [...plan.value.referenceArtifactIds] }, expectedShotRevision: shotRevision.value, expectedProviderUpdatedAt: provider.value.updatedAt, clientRequestId: operationId.value, reservation: { ...reservation.value } } });
}
</script>

<template>
  <NModal :show="show" preset="card" title="审阅生成候选的请求" class="generation-modal" :mask-closable="!disabled && !validating" :closable="!disabled && !validating" @update:show="emit('update:show', $event)">
    <ShotCastPanel v-if="show" :shot="shot" :project-id="project.id" :disabled="disabled||validating" @bound="emit('cast-bound')" @characters="emit('characters')" @loaded="castBindings = $event" />
    <div v-if="castBindings.length" class="generation-validation">
      <NButton size="small" :disabled="disabled || validating" @click="appendCastPrompt">加入人物与参考图序号提示</NButton>
      <span class="form-note">对应关系会显示在提示词中，生成前仍需人工审阅。</span>
    </div>
    <p class="dialog-intro">{{ shot.title }} · 镜头 r{{ shotRevision }} / 视觉要求 v{{ shot.visualRevision }}。生成结果加入候选，由你复核与选择。</p>
    <NAlert v-if="shotChanged" type="warning" :show-icon="false" class="draft-alert">镜头已经更新，当前生成输入仍保留。请核对最新要求，再重新检查能力与输入。<NButton text type="primary" :disabled="disabled" @click="shotRevision = shot.revision; resetReview()">保留输入，按最新镜头重新审阅</NButton></NAlert>
    <NForm @submit.prevent="submit">
      <div class="shot-form-row"><NFormItem label="生成类型"><NSelect :value="plan.kind" :options="[{ label: '图片候选', value: 'image' }, { label: '视频候选', value: 'video' }]" :disabled="disabled || validating" @update:value="changeKind" /></NFormItem><NFormItem label="模型连接"><NSelect v-model:value="providerId" :options="providerOptions" :disabled="disabled || validating" placeholder="选择匹配的生成连接" /></NFormItem></div>
      <NAlert v-if="!providerOptions.length" type="info" :show-icon="false" class="draft-alert">尚未配置匹配的生成连接。<NButton text type="primary" @click="emit('settings')">去配置连接</NButton></NAlert>
      <div v-if="provider" class="reasoning-target"><div class="heading-line"><strong>{{ provider.model }}</strong><NTag type="warning" size="small" :bordered="false">用户声明能力 · 尚未实接验证</NTag></div><code>{{ provider.baseUrl }}</code><p>{{ provider.timeoutMs / 1000 }} 秒单次 HTTP 超时。实际远端任务进度由本地服务持续跟踪。</p></div>
      <NFormItem label="本次生成提示词"><NInput v-model:value="plan.prompt" type="textarea" :autosize="{ minRows: 4, maxRows: 10 }" :disabled="disabled || validating" placeholder="描述希望出现的画面和动作。" /></NFormItem>
      <div class="generation-plan-fields"><NFormItem label="输入方式"><NSelect v-model:value="plan.inputMode" :options="inputModeOptions" :disabled="disabled || validating" /></NFormItem><NFormItem label="画幅"><NSelect v-model:value="plan.ratio" :options="ratioOptions" :disabled="disabled || validating" /></NFormItem><NFormItem v-if="plan.kind === 'video'" label="目标时长（秒）"><NInputNumber v-model:value="plan.durationSec" :min="0.1" :max="600" :precision="3" :disabled="disabled || validating" /></NFormItem></div>
      <p v-if="plan.kind === 'video' && provider" class="form-note">该连接声明支持：{{ provider.capabilities.durationsSec.join('、') || '尚未填写' }} 秒；不匹配的时长会被阻止。</p>
      <NFormItem label="将发送的参考图片（按下面顺序）"><NSelect v-model:value="plan.referenceArtifactIds" multiple filterable :options="referenceOptions" :disabled="disabled || validating" placeholder="纯文字方式无需图片；首尾帧必须保持两张图片的顺序" /></NFormItem>
      <NAlert v-if="plan.inputMode === 'text' && plan.referenceArtifactIds.length" type="warning" :show-icon="false" class="draft-alert">当前选择了纯文字输入，但仍保留引用。系统不会静默丢弃它们。<NButton text type="primary" :disabled="disabled || validating" @click="plan.referenceArtifactIds = []">确认清空引用，使用纯文字</NButton></NAlert>
      <div v-if="plan.referenceArtifactIds.length" class="generation-reference-list"><article v-for="(id, index) in plan.referenceArtifactIds" :key="id" class="generation-reference"><img v-if="artifactMap.get(id)?.kind === 'image'" :src="artifactUrl(id)" :alt="artifactMap.get(id)?.name" /><div v-else class="reference-unavailable">图片不可用</div><div><span>{{ referenceLabel(index) }}</span><strong>{{ artifactMap.get(id)?.name || id }}</strong></div><div class="reference-order"><NButton quaternary size="small" :disabled="disabled || validating || index === 0" :aria-label="`向前移动参考图片 ${index + 1}`" @click="moveReference(index, -1)"><AppIcon name="up" :size="15" /></NButton><NButton quaternary size="small" :disabled="disabled || validating || index === plan.referenceArtifactIds.length - 1" :aria-label="`向后移动参考图片 ${index + 1}`" @click="moveReference(index, 1)"><AppIcon name="down" :size="15" /></NButton></div></article></div>
      <div class="generation-validation"><NButton :loading="validating" :disabled="disabled || !providerId || !plan.prompt.trim() || shotChanged" @click="validate">检查能力与输入</NButton><NTag v-if="validation?.status === 'valid'" type="success" :bordered="false">当前输入通过本地能力校验</NTag></div>
      <NAlert v-if="validationError" type="error" :show-icon="false" class="draft-alert">{{ validationError }}</NAlert>
      <NAlert v-if="validation?.status === 'needs_replan'" type="warning" :show-icon="false" class="draft-alert"><strong>需要调整计划后再提交</strong><ul class="validation-issues"><li v-for="issue in validation.issues" :key="`${issue.code}:${issue.field}`">{{ issue.message }}</li></ul></NAlert>
      <div v-if="validation?.status === 'valid'" class="validated-target"><strong>已校验的实际目标</strong><span>{{ validation.compiled.model }}</span><code>{{ validation.compiled.baseUrl }}</code><p>通过本地能力校验不代表已验证真实服务、计费或画面质量。</p></div>
      <BudgetReservation v-model="reservation" :calls="calls" :generations="generations" :studio-operations="studioOperations" :disabled="disabled || validating" />
      <NCheckbox v-if="unknownCount" v-model:checked="independentAcknowledged" class="reasoning-acknowledgement" :disabled="disabled || validating">我确认这是独立新请求，旧的未知调用继续保留并待核对。</NCheckbox>
      <NCheckbox v-model:checked="acknowledged" class="reasoning-acknowledgement" :disabled="disabled || validating || validation?.status !== 'valid'">我已核对输入、所发图片、模型目标和费用预留，确认提交一次生成。</NCheckbox>
      <div class="dialog-actions"><NButton :disabled="disabled || validating" @click="emit('update:show', false)">继续编辑</NButton><NButton type="primary" attr-type="submit" :loading="disabled" :disabled="disabled || validating || !canSubmit">提交生成候选</NButton></div>
    </NForm>
  </NModal>
</template>
