<script setup lang="ts">
import { computed } from 'vue';
import { NAlert, NFormItem, NInput, NInputNumber, NSelect } from 'naive-ui';
import type { Artifact, ShotFields } from '../types.ts';
import { shotModeLabels } from '../lib/storyboard.ts';
const props = defineProps<{ modelValue: ShotFields; artifacts: Artifact[]; disabled: boolean; compact?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: ShotFields] }>();
const modes = Object.entries(shotModeLabels).map(([value, label]) => ({ value, label }));
const references = computed(() => props.artifacts.filter(artifact => artifact.kind !== 'audio').map(artifact => ({ label: artifact.name, value: artifact.id })));
function update<K extends keyof ShotFields>(key: K, value: ShotFields[K]) { emit('update:modelValue', { ...props.modelValue, [key]: value }); }
</script>

<template>
  <div class="shot-fields" :class="{ compact }">
    <NFormItem label="镜头名称"><NInput :value="modelValue.title" :maxlength="200" :disabled="disabled" placeholder="例如：晨光穿过窗边" @update:value="update('title', $event)" /></NFormItem>
    <NFormItem label="叙事目的"><NInput :value="modelValue.purpose" :maxlength="4000" :disabled="disabled" placeholder="这个画面要带给观众什么？" @update:value="update('purpose', $event)" /></NFormItem>
    <NFormItem label="画面描述"><NInput :value="modelValue.description" type="textarea" :autosize="{ minRows: compact ? 2 : 3, maxRows: 8 }" :maxlength="12000" :disabled="disabled" placeholder="主体、环境、光线、构图与情绪…" @update:value="update('description', $event)" /></NFormItem>
    <NFormItem label="镜头与人物动作"><NInput :value="modelValue.action" type="textarea" :autosize="{ minRows: 2, maxRows: 6 }" :maxlength="8000" :disabled="disabled" placeholder="固定镜头、缓慢推进，或人物的具体动作…" @update:value="update('action', $event)" /></NFormItem>
    <div class="shot-form-row"><NFormItem label="时长（秒）"><NInputNumber :value="modelValue.durationMs / 1000" :min="0.1" :max="600" :precision="3" :step="0.5" :disabled="disabled" @update:value="value => { if (value !== null) update('durationMs', Math.round(value * 1000)); }" /></NFormItem><NFormItem label="素材方式"><NSelect :value="modelValue.mode" :options="modes" :disabled="disabled" @update:value="update('mode', $event)" /></NFormItem></div>
    <p v-if="modelValue.mode !== 'import'" class="form-note">保存镜头后，可用「生成候选」审阅模型、输入与费用预留，也可以继续使用已有素材。</p>
    <NFormItem label="字幕"><NInput :value="modelValue.caption" type="textarea" :autosize="{ minRows: 2, maxRows: 6 }" :maxlength="10000" :disabled="disabled" placeholder="为这一镜写一句话（可选）" @update:value="update('caption', $event)" /></NFormItem>
    <NAlert v-if="modelValue.caption.length > 2000" type="warning" :show-icon="false" class="draft-alert">当前字幕 {{ modelValue.caption.length }} 字，完整内容会保留在分镜中。单条字幕合成最多支持 2000 字，超过时会阻止生成时间线；请精简镜头字幕，或到素材剪辑页手工创建分段字幕。</NAlert>
    <p class="form-note">字幕会在分镜保存到时间线时按镜头时段建立，可到素材剪辑页调整样式。</p>
    <NFormItem label="参考素材"><NSelect :value="modelValue.referenceArtifactIds" multiple filterable :max-tag-count="3" :options="references" :disabled="disabled" placeholder="选择构图、角色或风格参考（可选）" @update:value="update('referenceArtifactIds', $event)" /></NFormItem>
  </div>
</template>
