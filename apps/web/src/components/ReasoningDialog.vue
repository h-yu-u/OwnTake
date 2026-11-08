<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NAlert, NButton, NCollapse, NCollapseItem, NForm, NFormItem, NModal, NSelect, NTag } from 'naive-ui';
import type { LocalRuntimeProfile, Project, ProviderSummary, Shot } from '../types.ts';
import { reasoningTargets } from '../lib/reasoning.ts';
import type { ReasoningSubmission } from '../lib/reasoning.ts';
import { reasoningEffortLabels } from '../lib/runtime.ts';
const props = defineProps<{ show: boolean; project: Project; shots: Shot[]; boardRevision: number; providers: ProviderSummary[]; runtimes: LocalRuntimeProfile[]; disabled: boolean }>();
const emit = defineEmits<{ 'update:show': [value: boolean]; submit: [input: ReasoningSubmission]; settings: [] }>();
const targetId = ref<string | null>(null), operationId = ref('');
const targets = computed(() => reasoningTargets(props.providers, props.runtimes));
const options = computed(() => targets.value.map(({ value, label }) => ({ value, label })));
const target = computed(() => targets.value.find(item => item.value === targetId.value));
const provider = computed(() => target.value?.kind === 'provider' ? target.value.profile : null);
const runtime = computed(() => target.value?.kind === 'runtime' ? target.value.profile : null);
const valid = computed(() => Boolean(target.value && props.project.brief.trim()));
watch(() => props.show, show => { if (show) { operationId.value = crypto.randomUUID(); if (!targets.value.some(item => item.value === targetId.value)) targetId.value = targets.value[0]?.value || null; } });
watch([() => props.project.id, () => props.boardRevision, () => props.project.revision, targetId, () => target.value?.profile.updatedAt], () => { operationId.value = crypto.randomUUID(); });
function submit() {
  if (!target.value || !valid.value || props.disabled) return;
  emit('submit', { kind: target.value.kind, targetId: target.value.profile.id, expectedTargetUpdatedAt: target.value.profile.updatedAt,
    clientRequestId: operationId.value, expectedBoardRevision: props.boardRevision, expectedProjectRevision: props.project.revision });
}
</script>

<template>
  <NModal :show="show" preset="card" title="生成分镜草稿" class="reasoning-modal" :mask-closable="!disabled" :closable="!disabled" :close-on-esc="!disabled" @update:show="emit('update:show', $event)"><p class="dialog-intro">根据创作简报和当前分镜提出修改建议。结果先保存为草稿，由你审阅后再应用。</p><NForm @submit.prevent="submit"><NFormItem label="推理连接"><NSelect v-model:value="targetId" aria-label="推理连接" :input-props="{ 'aria-label': '推理连接' }" :options="options" :disabled="disabled" placeholder="选择模型接口或已启用的本机 CLI" /></NFormItem><NAlert v-if="!options.length" type="info" :show-icon="false" class="draft-alert">还没有可用的推理连接或已启用的本机 CLI。<NButton text type="primary" @click="emit('settings')">去设置连接</NButton></NAlert><div v-if="target" class="reasoning-target"><div class="heading-line"><strong>{{ target.profile.model }}</strong><NTag size="small" :bordered="false">{{ runtime ? runtime.kind === 'codex-cli' ? 'Codex CLI' : 'Claude Code' : '模型 API' }}</NTag></div><code>{{ runtime ? runtime.binaryPath : provider?.baseUrl }}</code><p>{{ target.profile.timeoutMs / 1000 }} 秒超时<span v-if="provider"> · 最多 {{ provider.maxOutputTokens }} 输出 tokens</span><span v-if="runtime"> · 推理强度：{{ runtime.reasoningEffort ? reasoningEffortLabels[runtime.reasoningEffort] : '模型默认' }}</span></p></div><p class="form-note">{{ runtime ? '使用已启用的本机 CLI 与其现有登录配置。该工具是可信本机扩展，不提供操作系统沙盒。' : '简报与分镜将发送到所选模型接口。' }} 费用以对应服务或账号为准。</p><NCollapse class="reasoning-context"><NCollapseItem title="查看将发送的简报与分镜" name="context"><div class="context-brief"><strong>创作简报</strong><p>{{ project.brief || '（简报为空）' }}</p></div><div v-if="!shots.length" class="context-shot">当前没有镜头，模型可提出新分镜。</div><article v-for="(shot, index) in shots" :key="shot.id" class="context-shot"><h3>{{ String(index + 1).padStart(2, '0') }} · {{ shot.title }}</h3><dl><div><dt>目的</dt><dd>{{ shot.purpose || '（留空）' }}</dd></div><div><dt>画面</dt><dd>{{ shot.description || '（留空）' }}</dd></div><div><dt>动作</dt><dd>{{ shot.action || '（留空）' }}</dd></div><div><dt>时长 / 素材方式</dt><dd>{{ shot.durationMs / 1000 }} 秒 · {{ shot.mode }}</dd></div><div><dt>字幕</dt><dd>{{ shot.caption || '（留空）' }}</dd></div><div><dt>参考素材 ID</dt><dd>{{ shot.referenceArtifactIds.join('、') || '无' }}</dd></div></dl></article><p class="panel-footnote">分镜版本 r{{ boardRevision }}。请求包含镜头字段与版本标识，不上传本地媒体文件。</p></NCollapseItem></NCollapse><div class="dialog-actions"><NButton :disabled="disabled" @click="emit('update:show', false)">返回编辑</NButton><NButton type="primary" attr-type="submit" :loading="disabled" :disabled="disabled || !valid">生成草稿</NButton></div></NForm></NModal>
</template>
