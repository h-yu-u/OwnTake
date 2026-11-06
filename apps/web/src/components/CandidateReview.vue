<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { NAlert, NButton, NCheckbox, NInput, NSelect, NTag } from 'naive-ui';
import type { Artifact, Candidate, ReviewRecord } from '../types.ts';
import type { HumanReviewInput } from '../lib/generationApi.ts';
import { formatDate } from '../lib/timeline.ts';
const props = defineProps<{ candidate: Candidate; artifact: Artifact; reviews: ReviewRecord[]; disabled: boolean }>();
const emit = defineEmits<{ save: [input: HumanReviewInput] }>();
const checked = reactive({ visual: false, motion: false, audio: false });
const verdict = ref<'pass' | 'needs_review' | 'reject'>('needs_review');
const notes = ref('');
const relevant = computed(() => props.reviews.filter(review => review.shotId === props.candidate.shotId && review.artifactId === props.candidate.artifactId && review.visualRevision === props.candidate.visualRevision).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
const human = computed(() => relevant.value.find(review => review.kind === 'human'));
const technical = computed(() => relevant.value.find(review => review.kind === 'technical'));
const enoughForPass = computed(() => checked.visual && (props.artifact.kind === 'image' || checked.motion && (!props.artifact.media.hasAudio || checked.audio)));
watch(() => props.candidate.id, () => { Object.assign(checked, { visual: false, motion: false, audio: false }); verdict.value = 'needs_review'; notes.value = ''; }, { immediate: true });
function save() { if (!props.disabled && (verdict.value !== 'pass' || enoughForPass.value)) emit('save', { candidateId: props.candidate.id, verdict: verdict.value, checked: { visual: checked.visual, motion: props.artifact.kind === 'video' && checked.motion, audio: props.artifact.kind === 'video' && props.artifact.media.hasAudio && checked.audio }, notes: notes.value.trim() }); }
</script>
<template>
  <section class="candidate-review">
    <div class="panel-heading"><h2>当前预览 · 人工复核</h2><NTag size="small" :bordered="false">视觉要求 v{{ candidate.visualRevision }}</NTag></div>
    <p class="form-note">请观看上方真实素材后记录判断。文件技术检查不能代替画面、完整动作与声音检查。</p>
    <div v-if="technical" class="technical-review"><NTag size="small" :bordered="false" :type="technical.verdict === 'pass' ? 'success' : 'warning'">{{ technical.verdict === 'pass' ? '技术检查通过' : '技术检查需关注' }}</NTag><span>{{ technical.issues.join('；') || technical.notes || '媒体已完成基础探测。' }}</span></div>
    <div class="review-checks"><NCheckbox v-model:checked="checked.visual" :disabled="disabled">已查看画面与细节</NCheckbox><NCheckbox v-model:checked="checked.motion" :disabled="disabled || artifact.kind !== 'video'">{{ artifact.kind === 'video' ? '已完整观看动作与运动' : '动作检查不适用于图片' }}</NCheckbox><NCheckbox v-model:checked="checked.audio" :disabled="disabled || artifact.kind !== 'video' || !artifact.media.hasAudio">{{ artifact.kind === 'video' && artifact.media.hasAudio ? '已试听素材声音' : '此素材无可检查的音轨' }}</NCheckbox></div>
    <NSelect v-model:value="verdict" :options="[{ label: '需要继续复核', value: 'needs_review' }, { label: '人工复核通过', value: 'pass' }, { label: '不采用这一版本', value: 'reject' }]" :disabled="disabled" aria-label="人工复核结论" />
    <NInput v-model:value="notes" type="textarea" :autosize="{ minRows: 2, maxRows: 5 }" :maxlength="4000" :disabled="disabled" placeholder="记录瑕疵、动作、声音或采用理由…" class="review-notes" />
    <NAlert v-if="verdict === 'pass' && !enoughForPass" type="warning" :show-icon="false" class="draft-alert">请完成适用于这份素材的检查，再记录通过；尚未检查的项目可保留为需要复核。</NAlert>
    <NButton :disabled="disabled || verdict === 'pass' && !enoughForPass" @click="save">记录复核结果</NButton>
    <div v-if="human" class="human-review-record"><strong>最近人工记录：{{ human.verdict === 'pass' ? '通过' : human.verdict === 'reject' ? '不采用' : '需要复核' }}</strong><span>{{ formatDate(human.createdAt) }}</span><p>{{ human.notes || '未填写备注' }}</p></div>
  </section>
</template>
