<script setup lang="ts">
import { computed } from 'vue';
import { NButton, NTag } from 'naive-ui';
import type { LocalRuntimeProfile, ProviderSummary, StudioKind } from '../types.ts';
import AppIcon from '../components/AppIcon.vue';
const props = defineProps<{ providers: ProviderSummary[]; runtimes: LocalRuntimeProfile[]; disabled: boolean }>();
const emit = defineEmits<{ batchSpeech: []; request: [kind: StudioKind]; settings: []; tasks: [] }>();
const tools = computed(() => [
  { kind: 'tts' as StudioKind, index: '01', icon: 'audio', title: '为作品配音', description: '输入文字与声音要求，生成新的配音素材。试听后再加入独立音轨。', available: props.providers.filter(provider => provider.kind === 'openai-speech' && provider.capabilities.speech).length, unit: '个配音连接', action: '创建配音' },
  { kind: 'frame_review' as StudioKind, index: '02', icon: 'review', title: '看看抽样画面', description: '对照候选原视觉要求查看少量画面，保留样本与问题报告，帮助你人工复核。', available: props.providers.filter(provider => provider.kind === 'chat-completions' && provider.capabilities.frameReview).length, unit: '个审核连接', action: '审核候选' },
  { kind: 'runtime_draft' as StudioKind, index: '03', icon: 'terminal', title: '本机 CLI 草稿', description: '让已启用的可信本机工具阅读简报并提出分镜建议，每项变更仍由你接受。', available: props.runtimes.filter(runtime => runtime.enabled).length, unit: '个已启用 CLI', action: '准备草稿请求' },
]);
</script>
<template>
  <div class="studio-view readable-view"><header class="page-heading"><div><p class="eyebrow">YOUR CREATIVE TOOLS</p><h1>创作工具</h1><p class="subheading">按作品需要补充声音、检查画面与推敲分镜。进度与结果统一在任务中心查看。</p></div><div class="heading-actions"><NButton @click="emit('tasks')">查看任务</NButton><NButton :disabled="disabled" @click="emit('settings')"><template #icon><AppIcon name="settings" :size="16" /></template>配置连接与 CLI</NButton></div></header>
    <div class="studio-tool-grid"><section v-for="tool in tools" :key="tool.kind" class="panel studio-tool-card"><div class="studio-tool-heading"><div class="studio-tool-icon"><AppIcon :name="tool.icon" :size="25" /></div><span>{{ tool.index }}</span></div><h2>{{ tool.title }}</h2><p>{{ tool.description }}</p><div class="studio-tool-footer"><NTag size="small" :bordered="false" :type="tool.available ? 'default' : 'warning'">{{ tool.available }} {{ tool.unit }}</NTag><NButton v-if="tool.kind === 'tts'" type="primary" :disabled="disabled" @click="emit('batchSpeech')">按分镜批量配音</NButton><NButton :type="tool.kind === 'tts' ? 'default' : 'primary'" secondary :disabled="disabled" @click="emit('request', tool.kind)">{{ tool.action }}</NButton></div></section></div>
  </div>
</template>
