<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NAlert, NButton, NSelect, NTag } from 'naive-ui';
import type { Artifact, Candidate, Shot } from '../types.ts';
import { artifactUrl } from '../lib/api.ts';
import { formatDuration } from '../lib/timeline.ts';
import AppIcon from './AppIcon.vue';
import MediaPreview from './MediaPreview.vue';

const props = defineProps<{ shot: Shot; candidates: Candidate[]; artifacts: Artifact[]; disabled: boolean }>();
const emit = defineEmits<{ add: [artifactId: string]; select: [candidateId: string]; assets: [] }>();
const assetId = ref<string | null>(null);
const previewId = ref<string | null>(null);
const options = computed(() => props.artifacts.filter(asset => asset.kind !== 'audio').map(asset => ({ label: asset.name, value: asset.id })));
const candidatesForShot = computed(() => props.candidates.filter(candidate => candidate.shotId === props.shot.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
const assetMap = computed(() => new Map(props.artifacts.map(asset => [asset.id, asset])));
const preview = computed(() => assetMap.value.get(previewId.value || props.shot.selectedArtifactId || candidatesForShot.value[0]?.artifactId || '') || null);
const selectedIsOld = computed(() => props.shot.selectedArtifactId && props.shot.selectedVisualRevision !== props.shot.visualRevision);
watch(() => props.shot.id, () => { assetId.value = null; previewId.value = null; });
</script>

<template>
  <section class="panel candidate-panel"><div class="panel-heading"><h2>候选画面</h2><NTag size="small" :bordered="false">视觉要求 v{{ shot.visualRevision }}</NTag></div><MediaPreview :artifact="preview" compact /><NAlert v-if="selectedIsOld" type="warning" :show-icon="false" class="candidate-warning">当前选用素材来自视觉要求 v{{ shot.selectedVisualRevision }}。修改后的要求为 v{{ shot.visualRevision }}，请复核后决定是否继续使用。</NAlert><div class="candidate-adder"><NSelect v-model:value="assetId" :options="options" filterable :disabled="disabled" placeholder="选择已有图片或视频" aria-label="候选素材" /><NButton :disabled="disabled || !assetId" @click="emit('add', assetId!)">加入候选</NButton></div><p class="form-note">添加素材会记录当前视觉要求版本。<NButton text type="primary" size="small" @click="emit('assets')">去导入素材</NButton></p><div v-if="!candidatesForShot.length" class="candidate-empty">为这一镜添加第一份候选画面。</div><div v-else class="candidate-list"><article v-for="candidate in candidatesForShot" :key="candidate.id" class="candidate-card" :class="{ chosen: candidate.artifactId === shot.selectedArtifactId && candidate.visualRevision === shot.selectedVisualRevision }"><button class="candidate-preview-button" :aria-label="`预览 ${assetMap.get(candidate.artifactId)?.name || '素材缺失'}`" @click="previewId = candidate.artifactId"><div class="candidate-thumb"><img v-if="assetMap.get(candidate.artifactId)?.kind === 'image'" :src="artifactUrl(candidate.artifactId)" alt="" loading="lazy" /><AppIcon v-else name="film" :size="24" /></div><div class="candidate-copy"><strong>{{ assetMap.get(candidate.artifactId)?.name || '素材缺失' }}</strong><span>视觉 v{{ candidate.visualRevision }}<span v-if="assetMap.get(candidate.artifactId)?.kind === 'video'"> · {{ formatDuration(assetMap.get(candidate.artifactId)!.media.durationMs) }}</span></span></div></button><div class="candidate-choice"><NTag v-if="candidate.artifactId === shot.selectedArtifactId && candidate.visualRevision === shot.selectedVisualRevision" size="small" :bordered="false" :type="candidate.visualRevision === shot.visualRevision ? 'success' : 'warning'">{{ candidate.visualRevision === shot.visualRevision ? '当前选用' : '选用旧要求结果' }}</NTag><NButton v-else size="small" :disabled="disabled || !assetMap.has(candidate.artifactId)" @click="emit('select', candidate.id)">{{ candidate.visualRevision === shot.visualRevision ? '采用此候选' : '采用旧版本 · 需复核' }}</NButton></div></article></div></section>
</template>
