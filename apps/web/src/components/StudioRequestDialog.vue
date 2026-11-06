<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NAlert, NButton, NCheckbox, NCollapse, NCollapseItem, NForm, NFormItem, NInput, NInputNumber, NModal, NSelect, NTag } from 'naive-ui';
import type { Artifact, BoardSnapshot, CallRecord, GenerationRecord, LocalRuntimeProfile, Project, ProviderSummary, Reservation, SpeechInput, StudioCreateRequest, StudioKind, StudioOperation } from '../types.ts';
import { budgetUsed, reservationValid, unknownReservations } from '../lib/budget.ts';
import { activeShots } from '../lib/storyboard.ts';
import { speechProblems, studioKindLabels } from '../lib/studio.ts';
import BudgetReservation from './BudgetReservation.vue';
import MediaPreview from './MediaPreview.vue';

const props = defineProps<{ show: boolean; kind: StudioKind; project: Project; board: BoardSnapshot | null; artifacts: Artifact[]; providers: ProviderSummary[]; runtimes: LocalRuntimeProfile[]; calls: CallRecord[]; generations: GenerationRecord[]; studioOperations: StudioOperation[]; disabled: boolean }>();
const emit = defineEmits<{ 'update:show': [value: boolean]; submit: [input: StudioCreateRequest]; settings: []; details: [] }>();
const targetId = ref<string | null>(null);
const candidateId = ref<string | null>(null);
const speech = ref<SpeechInput>({ text: '', voice: '', speed: 1, instructions: null });
const reservation = ref<Reservation>({ currency: 'USD', amount: 0.1, singleLimit: 1, projectLimit: 5 });
const acknowledged = ref(false);
const independentAcknowledged = ref(false);
const operationId = ref('');
const shots = computed(() => props.board ? activeShots(props.board) : []);
const provider = computed(() => props.providers.find(item => item.id === targetId.value));
const runtime = computed(() => props.runtimes.find(item => item.id === targetId.value));
const target = computed(() => props.kind === 'runtime_draft' ? runtime.value : provider.value);
const targetOptions = computed(() => props.kind === 'runtime_draft'
  ? props.runtimes.filter(item => item.enabled).map(item => ({ label: `${item.label} · ${item.model}`, value: item.id }))
  : props.providers.filter(item => props.kind === 'tts' ? item.kind === 'openai-speech' && item.capabilities.speech : item.kind === 'chat-completions' && item.capabilities.frameReview).map(item => ({ label: `${item.label} · ${item.model}`, value: item.id })));
const voiceOptions = computed(() => provider.value?.capabilities.speech?.voices.map(voice => ({ label: voice, value: voice })) || []);
const candidate = computed(() => props.board?.candidates.find(item => item.id === candidateId.value));
const artifact = computed(() => props.artifacts.find(item => item.id === candidate.value?.artifactId));
const candidateOptions = computed(() => (props.board?.candidates || []).filter(item => props.artifacts.some(asset => asset.id === item.artifactId && ['image', 'video'].includes(asset.kind))).map(item => ({ value: item.id, label: `${props.board?.shots.find(shot => shot.id === item.shotId)?.title || '历史镜头'} · v${item.visualRevision} · ${props.artifacts.find(asset => asset.id === item.artifactId)?.name || item.artifactId}` })));
const frameCount = computed(() => artifact.value?.kind === 'video' ? 3 : artifact.value?.kind === 'image' ? 1 : 0);
const records = computed(() => [...props.calls, ...props.generations, ...props.studioOperations]);
const unknownCount = computed(() => unknownReservations(records.value));
const used = computed(() => budgetUsed(records.value, reservation.value.currency));
const issues = computed(() => {
  if (!targetOptions.value.some(option => option.value === targetId.value)) return ['请选择匹配并已保存的目标连接。'];
  if (props.kind === 'tts') return speechProblems(speech.value, provider.value);
  if (props.kind === 'runtime_draft') return !props.board ? ['分镜快照尚未加载，请稍后重试。'] : !props.project.brief.trim() ? ['请先填写并保存创作简报。'] : [];
  const messages: string[] = [];
  if (!candidate.value || !artifact.value || !frameCount.value) messages.push('请选择现有图片或视频候选。');
  if (frameCount.value > (provider.value?.capabilities.frameReview?.maxImages || 0)) messages.push(`此候选需要 ${frameCount.value} 张图片，连接声明的上限不足；请更换连接。`);
  return messages;
});
const valid = computed(() => Boolean(target.value && !issues.value.length && acknowledged.value && (!unknownCount.value || independentAcknowledged.value) && reservationValid(reservation.value, used.value)));
const fingerprint = computed(() => JSON.stringify({ kind: props.kind, projectId: props.project.id, targetId: targetId.value, targetUpdatedAt: target.value?.updatedAt,
  input: props.kind === 'tts' ? speech.value : props.kind === 'frame_review' ? { candidateId: candidateId.value, sha256: artifact.value?.sha256 } : { boardRevision: props.board?.revision, projectRevision: props.project.revision }, reservation: reservation.value }));
function resetReview() { acknowledged.value = false; independentAcknowledged.value = false; operationId.value = crypto.randomUUID(); }
watch(fingerprint, resetReview);
watch(() => [props.show, props.kind] as const, ([show]) => {
  if (!show) return;
  targetId.value = targetOptions.value[0]?.value || null;
  candidateId.value = candidateOptions.value[0]?.value || null;
  speech.value = { text: '', voice: provider.value?.capabilities.speech?.voices[0] || '', speed: 1, instructions: null };
  resetReview();
}, { immediate: true });
function submit() {
  if (!valid.value || props.disabled || !target.value) return;
  const input = props.kind === 'tts' ? { ...speech.value, instructions: speech.value.instructions?.trim() || null }
    : props.kind === 'frame_review' ? { candidateId: candidateId.value! }
    : { expectedBoardRevision: props.board!.revision, expectedProjectRevision: props.project.revision };
  emit('submit', { kind: props.kind, targetId: target.value.id, expectedTargetUpdatedAt: target.value.updatedAt, clientRequestId: operationId.value, reservation: { ...reservation.value }, input });
}
</script>

<template>
  <NModal :show="show" preset="card" :title="`审阅${studioKindLabels[kind]}请求`" class="studio-request-modal" :mask-closable="!disabled" :closable="!disabled" @update:show="emit('update:show', $event)">
    <NForm @submit.prevent="submit">
      <p class="dialog-intro">{{ kind === 'tts' ? '文字与风格指令将发送到所选配音连接，结果作为新的 WAV 素材保存。' : kind === 'frame_review' ? '审核指定候选的少量画面，报告保留原候选视觉版本，不替代人工复核。' : '本机 CLI 基于已保存简报与分镜返回草稿，你随后决定接受哪些变更。' }}</p>
      <NFormItem :label="kind === 'runtime_draft' ? '已启用的本机 CLI' : '模型连接'"><NSelect aria-label="目标连接" :input-props="{ 'aria-label': '目标连接' }" v-model:value="targetId" :options="targetOptions" :disabled="disabled" placeholder="选择匹配的目标" /></NFormItem>
      <NAlert v-if="!targetOptions.length" type="info" :show-icon="false" class="draft-alert">{{ kind === 'runtime_draft' ? '尚无已启用的本机 CLI。' : kind === 'tts' ? '尚无声明语音能力的配音连接。' : '尚无声明图片输入与结构化输出能力的审核连接。' }}<NButton text type="primary" @click="emit('settings')">去设置</NButton></NAlert>
      <div v-if="target" class="reasoning-target"><div class="heading-line"><strong>{{ target.model }}</strong><NTag size="small" type="warning" :bordered="false">{{ kind === 'runtime_draft' ? '认证未检查' : '能力为用户声明 · 尚未实接验证' }}</NTag></div><code>{{ kind === 'runtime_draft' ? runtime?.binaryPath : provider?.baseUrl }}</code><p>{{ target.label }} · {{ target.timeoutMs / 1000 }} 秒超时<span v-if="kind === 'frame_review' && provider"> · 最多 {{ provider.maxOutputTokens }} 输出 tokens</span></p></div>
      <template v-if="kind === 'tts'">
        <NFormItem label="配音文字"><NInput :input-props="{ 'aria-label': '配音文字' }" v-model:value="speech.text" type="textarea" :autosize="{ minRows: 5, maxRows: 12 }" :disabled="disabled" placeholder="写下希望朗读的内容。生成前会逐字使用这里的文字。" /></NFormItem>
        <p class="form-note">{{ speech.text.length }} 字符<span v-if="provider?.capabilities.speech"> / 声明上限 {{ provider.capabilities.speech.maxInputChars }}</span>。文本不会被静默截断。</p>
        <div class="shot-form-row"><NFormItem label="声音 ID"><NSelect aria-label="声音 ID" :input-props="{ 'aria-label': '声音 ID' }" v-model:value="speech.voice" :options="voiceOptions" :disabled="disabled" placeholder="选择声明支持的声音" /></NFormItem><NFormItem label="语速（倍）"><NInputNumber :input-props="{ 'aria-label': '语速（倍）' }" v-model:value="speech.speed" :min="0.25" :max="4" :step="0.05" :precision="2" :disabled="disabled" /></NFormItem></div>
        <NFormItem label="语气与风格指令（可选）"><NInput :input-props="{ 'aria-label': '语气与风格指令（可选）' }" :value="speech.instructions || ''" type="textarea" :rows="2" :disabled="disabled" placeholder="例如语气与节奏；仅支持此能力的模型可接收" @update:value="speech.instructions = $event || null" /></NFormItem>
        <p class="form-note">{{ provider?.capabilities.speech?.supportsInstructions ? '此连接声明支持独立风格指令。' : '此连接未声明支持风格指令，非空指令会阻止提交。' }} 输出格式固定为 WAV；生成后试听，再加入音轨。</p>
      </template>
      <template v-else-if="kind === 'frame_review'">
        <NFormItem label="审核候选"><NSelect aria-label="审核候选" :input-props="{ 'aria-label': '审核候选' }" v-model:value="candidateId" :options="candidateOptions" filterable :disabled="disabled" placeholder="从分镜已有的图片或视频候选中选择" /></NFormItem>
        <div v-if="artifact && candidate" class="studio-review-source"><MediaPreview :artifact="artifact" /><p class="form-note">候选来源：视觉要求 v{{ candidate.visualRevision }}。审核会对照这个版本已保存的镜头目的、画面与动作文字；不会使用后来更新的视觉要求。</p><code class="studio-source-hash">SHA-256 · {{ artifact.sha256 }}</code></div>
        <NAlert type="info" :show-icon="false" class="draft-alert">{{ artifact?.kind === 'image' ? '将发送这张图片的一份 PNG 样本。' : '视频将提取并发送片长 10%、50%、90% 位置的三张 PNG 样本。' }}报告仅覆盖这些抽样画面，不检查完整动作、时间连续性或声音。结果不会自动修改人工复核状态与候选选择。</NAlert>
      </template>
      <template v-else>
        <NAlert type="warning" :show-icon="false" class="draft-alert">已启用的可信 CLI 会使用现有本机认证，其连接目标由 CLI 自身配置决定。OwnTake 不提供操作系统沙盒；该工具会读取本次简报与分镜，结果只进入待审阅草稿。</NAlert>
        <NButton v-if="!project.brief.trim()" text type="primary" @click="emit('details')">填写创作简报</NButton>
        <NCollapse class="reasoning-context"><NCollapseItem title="查看将提供给 CLI 的简报与分镜" name="context"><div class="context-brief"><strong>创作简报 · r{{ project.revision }}</strong><p>{{ project.brief || '（简报为空）' }}</p></div><div v-if="!shots.length" class="context-shot">当前没有镜头，CLI 可以提出新的分镜。</div><article v-for="(shot, index) in shots" :key="shot.id" class="context-shot"><h3>{{ String(index + 1).padStart(2, '0') }} · {{ shot.title }}</h3><dl><div><dt>目的</dt><dd>{{ shot.purpose || '（留空）' }}</dd></div><div><dt>画面</dt><dd>{{ shot.description || '（留空）' }}</dd></div><div><dt>动作</dt><dd>{{ shot.action || '（留空）' }}</dd></div><div><dt>时长 / 方式</dt><dd>{{ shot.durationMs / 1000 }} 秒 · {{ shot.mode }}</dd></div><div><dt>字幕</dt><dd>{{ shot.caption || '（留空）' }}</dd></div><div><dt>参考素材 ID</dt><dd>{{ shot.referenceArtifactIds.join('、') || '无' }}</dd></div></dl></article><p class="panel-footnote">分镜版本 r{{ board?.revision ?? '—' }}。只提供这些已保存的文字与版本信息，不把整个项目素材目录作为输入。</p></NCollapseItem></NCollapse>
      </template>
      <NAlert v-if="issues.length" type="warning" :show-icon="false" class="draft-alert"><ul class="validation-issues"><li v-for="issue in issues" :key="issue">{{ issue }}</li></ul></NAlert>
      <BudgetReservation v-model="reservation" :calls="calls" :generations="generations" :studio-operations="studioOperations" :disabled="disabled" />
      <NCheckbox v-if="unknownCount" v-model:checked="independentAcknowledged" :disabled="disabled" class="reasoning-acknowledgement">我确认这是独立新请求，已有未知调用保留预留，等待另外核对。</NCheckbox>
      <NCheckbox v-model:checked="acknowledged" :disabled="disabled || issues.length > 0" class="reasoning-acknowledgement">我已核对输入、目标、能力范围和本地费用预留，确认提交一次操作。</NCheckbox>
      <div class="dialog-actions"><NButton :disabled="disabled" @click="emit('update:show', false)">返回编辑</NButton><NButton type="primary" attr-type="submit" :loading="disabled" :disabled="disabled || !valid">提交{{ studioKindLabels[kind] }}</NButton></div>
    </NForm>
  </NModal>
</template>
