<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NAlert, NButton, NCheckbox, NForm, NFormItem, NInput, NInputNumber, NModal, NSelect, NTag } from 'naive-ui';
import type { LocalRuntimeInput, LocalRuntimeInspection, LocalRuntimeProfile } from '../types.ts';
import { errorMessage } from '../lib/api.ts';
import { isAbsoluteExecutable } from '../lib/studio.ts';
import { studioApi } from '../lib/studioApi.ts';
import type { RuntimeSettingsInput } from '../lib/studioApi.ts';
import AppIcon from './AppIcon.vue';

const props = defineProps<{ runtimes: LocalRuntimeProfile[]; disabled: boolean }>();
const emit = defineEmits<{ save: [input: { id: string | null; profile: RuntimeSettingsInput }]; refresh: [] }>();
const show = ref(false);
const editingId = ref<string | null>(null);
const form = ref<LocalRuntimeInput>({ label: '', kind: 'codex-cli', enabled: false, binaryPath: '', model: '', timeoutMs: 120000 });
const trusted = ref(false);
const inspecting = ref<string | null>(null);
const inspections = ref<Record<string, { updatedAt: string; result: LocalRuntimeInspection }>>({});
const inspectionError = ref('');
const valid = computed(() => Boolean(form.value.label.trim() && form.value.model.trim() && isAbsoluteExecutable(form.value.binaryPath.trim()) && form.value.timeoutMs >= 100 && form.value.timeoutMs <= 600000 && (!form.value.enabled || trusted.value)));
function open(profile: LocalRuntimeProfile | null) {
  editingId.value = profile?.id || null; trusted.value = false;
  form.value = profile ? { label: profile.label, kind: profile.kind, enabled: profile.enabled, binaryPath: profile.binaryPath, model: profile.model, timeoutMs: profile.timeoutMs }
    : { label: '', kind: 'codex-cli', enabled: false, binaryPath: '', model: '', timeoutMs: 120000 };
  show.value = true;
}
watch(() => props.runtimes, () => { show.value = false; trusted.value = false; });
watch(() => [form.value.binaryPath, form.value.kind, form.value.model], () => { trusted.value = false; });
function save() {
  if (!valid.value || props.disabled) return;
  emit('save', { id: editingId.value, profile: { ...form.value, label: form.value.label.trim(), binaryPath: form.value.binaryPath.trim(), model: form.value.model.trim(), trustAcknowledged: trusted.value } });
}
async function inspect(profile: LocalRuntimeProfile) {
  if (inspecting.value || props.disabled) return;
  inspecting.value = profile.id; inspectionError.value = '';
  try { const result = await studioApi.inspectRuntime(profile.id); inspections.value = { ...inspections.value, [profile.id]: { updatedAt: profile.updatedAt, result } }; }
  catch (error) { inspectionError.value = errorMessage(error); }
  finally { inspecting.value = null; }
}
function inspection(profile: LocalRuntimeProfile): LocalRuntimeInspection | undefined { const entry = inspections.value[profile.id]; return entry?.updatedAt === profile.updatedAt ? entry.result : undefined; }
</script>

<template>
  <section class="panel provider-settings runtime-settings">
    <div class="panel-heading"><div><h2>可选本机 CLI</h2><p class="subheading">用已安装的 Claude Code 或 Codex 生成分镜草稿。</p></div><div class="heading-line"><NButton text size="small" :disabled="disabled || Boolean(inspecting)" @click="emit('refresh')">刷新</NButton><NButton :disabled="disabled" @click="open(null)"><template #icon><AppIcon name="plus" :size="16" /></template>添加本机 CLI</NButton></div></div>
    <p class="settings-description">默认禁用。启用后，它作为你信任的本机扩展运行，并读取该 CLI 已有的本机认证。OwnTake 不提供操作系统沙盒；CLI 的服务连接、文件权限与自带工具由其自身配置决定。</p>
    <NAlert v-if="inspectionError" type="error" :show-icon="false" class="draft-alert">{{ inspectionError }}</NAlert>
    <p v-if="!runtimes.length" class="draft-empty">不配置 CLI 也可以手工制作，或通过模型连接请求分镜建议。</p>
    <div class="provider-list"><article v-for="profile in runtimes" :key="profile.id" class="runtime-entry">
      <div class="provider-row"><div class="provider-symbol"><AppIcon name="terminal" :size="22" /></div><div class="provider-copy"><div class="heading-line"><strong>{{ profile.label }}</strong><NTag size="small" :bordered="false" :type="profile.enabled ? 'success' : 'default'">{{ profile.enabled ? '已显式启用' : '已禁用' }}</NTag><NTag size="small" :bordered="false">认证未检查</NTag></div><p>{{ profile.kind === 'codex-cli' ? 'Codex CLI' : 'Claude Code' }} · {{ profile.model }} · {{ profile.timeoutMs / 1000 }} 秒超时</p><code>{{ profile.binaryPath }}</code></div><div class="runtime-actions"><NButton size="small" :disabled="disabled || Boolean(inspecting)" :loading="inspecting === profile.id" @click="inspect(profile)">检测版本</NButton><NButton size="small" :disabled="disabled" @click="open(profile)">编辑</NButton></div></div>
      <div v-if="inspection(profile)" class="runtime-inspection"><div class="heading-line"><NTag size="small" :bordered="false" :type="inspection(profile)!.available && inspection(profile)!.compatible ? 'success' : 'warning'">{{ inspection(profile)!.available && inspection(profile)!.compatible ? '可执行文件与参数兼容' : '需要检查' }}</NTag><span>认证仍未检查</span></div><code>{{ inspection(profile)!.path }}</code><p v-if="inspection(profile)!.version">{{ inspection(profile)!.version }}</p><p v-if="inspection(profile)!.error" class="error-details">{{ inspection(profile)!.error }}</p><p>版本和参数检测不会调用模型，也不代表账号已经登录或模型可以使用。</p></div>
    </article></div>
    <p class="panel-footnote">只接受明确的可执行文件绝对路径、模型和超时。分镜草稿先进入审阅，不会自动应用。</p>
    <NModal v-model:show="show" preset="card" :title="editingId ? '编辑本机 CLI' : '添加本机 CLI'" class="provider-modal" :mask-closable="!disabled" :closable="!disabled">
      <NForm @submit.prevent="save">
        <NFormItem label="名称"><NInput :input-props="{ 'aria-label': '名称' }" v-model:value="form.label" :maxlength="120" :disabled="disabled" placeholder="例如 我的本机草稿助手" /></NFormItem>
        <NFormItem label="CLI 类型"><NSelect aria-label="CLI 类型" :input-props="{ 'aria-label': 'CLI 类型' }" v-model:value="form.kind" :disabled="disabled" :options="[{ label: 'Codex CLI', value: 'codex-cli' }, { label: 'Claude Code', value: 'claude-code' }]" /></NFormItem>
        <NFormItem label="可执行文件绝对路径"><NInput :input-props="{ 'aria-label': '可执行文件绝对路径' }" v-model:value="form.binaryPath" :disabled="disabled" placeholder="填写本机真实安装路径，不接受命令或参数" /></NFormItem>
        <NFormItem label="模型 ID"><NInput :input-props="{ 'aria-label': '模型 ID' }" v-model:value="form.model" :maxlength="200" :disabled="disabled" placeholder="填写该 CLI 与账号实际可用的模型" /></NFormItem>
        <NFormItem label="一次执行超时（秒）"><NInputNumber :input-props="{ 'aria-label': '一次执行超时（秒）' }" :value="form.timeoutMs / 1000" :min="0.1" :max="600" :precision="1" :disabled="disabled" @update:value="value => { if (value !== null) form.timeoutMs = Math.round(value * 1000); }" /></NFormItem>
        <NCheckbox v-model:checked="form.enabled" :disabled="disabled" class="reasoning-acknowledgement">启用此本机 CLI 作为草稿工具</NCheckbox>
        <NAlert v-if="form.enabled" type="warning" :show-icon="false" class="draft-alert">此程序使用本机已有 CLI 认证，可能连接该 CLI 配置的服务。OwnTake 的任务目录和结构化结果检查不构成操作系统隔离。仅启用你信任的安装文件。</NAlert>
        <NCheckbox v-if="form.enabled" v-model:checked="trusted" :disabled="disabled" class="reasoning-acknowledgement">我认可这是可信的本机扩展，允许使用现有 CLI 认证，并了解它不在 OwnTake 操作系统沙盒中。</NCheckbox>
        <div class="dialog-actions"><NButton :disabled="disabled" @click="show = false">取消</NButton><NButton type="primary" attr-type="submit" :loading="disabled" :disabled="disabled || !valid">保存 CLI 设置</NButton></div>
      </NForm>
    </NModal>
  </section>
</template>
