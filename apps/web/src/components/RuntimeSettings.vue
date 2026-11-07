<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NAlert, NButton, NCheckbox, NCollapse, NCollapseItem, NForm, NFormItem, NInput, NInputNumber, NModal, NSelect, NSpin, NTag } from 'naive-ui';
import type { DiscoveredLocalRuntime, LocalReasoningEffort, LocalRuntimeInput, LocalRuntimeInspection, LocalRuntimeProfile } from '../types.ts';
import { errorMessage } from '../lib/api.ts';
import { isAbsoluteExecutable } from '../lib/studio.ts';
import { studioApi } from '../lib/studioApi.ts';
import { reasoningEffortLabels, runtimeEffortOptions } from '../lib/runtime.ts';
import type { RuntimeSettingsInput } from '../lib/studioApi.ts';
import AppIcon from './AppIcon.vue';
import NativePathButton from './NativePathButton.vue';

const props = defineProps<{ runtimes: LocalRuntimeProfile[]; disabled: boolean }>();
const emit = defineEmits<{ save: [input: { id: string | null; profile: RuntimeSettingsInput }]; refresh: [] }>();
const show = ref(false);
const editingId = ref<string | null>(null);
const form = ref<LocalRuntimeInput>({ label: '', kind: 'codex-cli', enabled: false, binaryPath: '', model: '', timeoutMs: 120000 });
const detecting = ref(false);
const detected = ref<DiscoveredLocalRuntime[]>([]);
const detectionError = ref('');
const manual = ref(false);
const selectedPath = ref<string | null>(null);
const advanced = ref<string[]>([]);
const inspecting = ref<string | null>(null);
const inspections = ref<Record<string, { updatedAt: string; result: LocalRuntimeInspection }>>({});
const inspectionError = ref('');
const selectedRuntime = computed(() => detected.value.find(runtime => runtime.kind === form.value.kind && runtime.binaryPath === form.value.binaryPath));
const cliOptions = computed(() => detected.value.map(runtime => ({ label: `${runtime.label}${runtime.inspection.version ? ` · ${runtime.inspection.version}` : ''}${!runtime.inspection.compatible ? ' · 需检查版本' : ''}`, value: runtime.binaryPath })));
const modelOptions = computed(() => {
  const models = selectedRuntime.value?.models ?? [];
  const options = models.map(model => ({ label: model.label === model.id ? model.id : `${model.label} · ${model.id}`, value: model.id }));
  return form.value.model && !models.some(model => model.id === form.value.model) ? [{ label: form.value.model, value: form.value.model }, ...options] : options;
});
const modelHint = computed(() => ({ 'local-cache': '来自 Codex 本机模型缓存，可能尚未更新。', bundled: '来自此 Codex 版本的内置模型目录。', aliases: '使用 Claude 官方模型别名，由 CLI 解析具体版本。', unavailable: '此版本未提供离线模型列表，可直接输入模型 ID。' })[selectedRuntime.value?.modelSource ?? 'unavailable']);
const effortOptions = computed(() => runtimeEffortOptions(form.value, selectedRuntime.value));
const valid = computed(() => Boolean(form.value.label.trim() && form.value.model.trim() && !form.value.model.trim().startsWith('-') && isAbsoluteExecutable(form.value.binaryPath.trim()) && form.value.timeoutMs >= 100 && form.value.timeoutMs <= 600000));
function selectRuntime(path: string) {
  const runtime = detected.value.find(item => item.binaryPath === path);
  if (!runtime) return;
  const sameRuntime = form.value.kind === runtime.kind && form.value.binaryPath === runtime.binaryPath;
  selectedPath.value = path;
  form.value = { ...form.value, kind: runtime.kind, binaryPath: runtime.binaryPath, label: runtime.label, model: sameRuntime ? form.value.model : '', reasoningEffort: sameRuntime ? form.value.reasoningEffort : undefined, enabled: sameRuntime && form.value.enabled };
}
async function detect() {
  if (detecting.value) return;
  detecting.value = true; detectionError.value = '';
  try {
    detected.value = await studioApi.discoverRuntimes();
    if (!show.value || manual.value) return;
    const match = detected.value.find(runtime => runtime.binaryPath === form.value.binaryPath && runtime.kind === form.value.kind);
    if (match) selectedPath.value = match.binaryPath;
    else if (!editingId.value && !form.value.binaryPath && detected.value.length) selectRuntime((detected.value.find(runtime => runtime.inspection.compatible) ?? detected.value[0])!.binaryPath);
  } catch (error) { detectionError.value = errorMessage(error); }
  finally { detecting.value = false; }
}
function open(profile: LocalRuntimeProfile | null) {
  editingId.value = profile?.id || null;
  form.value = profile ? { label: profile.label, kind: profile.kind, enabled: profile.enabled, binaryPath: profile.binaryPath, model: profile.model, reasoningEffort: profile.reasoningEffort, timeoutMs: profile.timeoutMs }
    : { label: '', kind: 'codex-cli', enabled: false, binaryPath: '', model: '', timeoutMs: 120000 };
  show.value = true;
  selectedPath.value = null; manual.value = false; advanced.value = [];
  void detect();
}
function useManual() { manual.value = true; selectedPath.value = null; advanced.value = ['details']; }
function changeKind(kind: LocalRuntimeInput['kind']) { form.value = { ...form.value, kind, model: '', reasoningEffort: undefined, enabled: false }; }
function changeModel(model: string | null) { if (form.value.model !== (model || '')) form.value = { ...form.value, model: model || '', reasoningEffort: undefined }; }
function changeEffort(effort: string) { form.value.reasoningEffort = effort === 'default' ? undefined : effort as LocalReasoningEffort; }
watch(() => props.runtimes, () => { show.value = false; });
watch(() => [form.value.kind, form.value.binaryPath], () => { selectedPath.value = selectedRuntime.value?.binaryPath ?? null; });
function save() {
  if (!valid.value || props.disabled || detecting.value) return;
  emit('save', { id: editingId.value, profile: { ...form.value, label: form.value.label.trim(), binaryPath: form.value.binaryPath.trim(), model: form.value.model.trim(), trustAcknowledged: form.value.enabled } });
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
    <div class="panel-heading"><div><h2>可选本机 CLI</h2><p class="subheading">自动识别已安装的 Claude Code 或 Codex，选择模型后生成分镜草稿。</p></div><div class="heading-line"><NButton text size="small" :disabled="disabled || Boolean(inspecting)" @click="emit('refresh')">刷新</NButton><NButton :disabled="disabled" @click="open(null)"><template #icon><AppIcon name="plus" :size="16" /></template>添加本机 CLI</NButton></div></div>
    <p class="settings-description">默认禁用。启用后，它作为你信任的本机扩展运行，并读取该 CLI 已有的本机认证。OwnTake 不提供操作系统沙盒；CLI 的服务连接、文件权限与自带工具由其自身配置决定。</p>
    <NAlert v-if="inspectionError" type="error" :show-icon="false" class="draft-alert">{{ inspectionError }}</NAlert>
    <p v-if="!runtimes.length" class="draft-empty">不配置 CLI 也可以手工制作，或通过模型连接请求分镜建议。</p>
    <div class="provider-list"><article v-for="profile in runtimes" :key="profile.id" class="runtime-entry">
      <div class="provider-row"><div class="provider-symbol"><AppIcon name="terminal" :size="22" /></div><div class="provider-copy"><div class="heading-line"><strong>{{ profile.label }}</strong><NTag size="small" :bordered="false" :type="profile.enabled ? 'success' : 'default'">{{ profile.enabled ? '已显式启用' : '已禁用' }}</NTag><NTag size="small" :bordered="false">认证未检查</NTag></div><p>{{ profile.kind === 'codex-cli' ? 'Codex CLI' : 'Claude Code' }} · {{ profile.model }} · 推理：{{ profile.reasoningEffort ? reasoningEffortLabels[profile.reasoningEffort] : '模型默认' }} · {{ profile.timeoutMs / 1000 }} 秒超时</p><code>{{ profile.binaryPath }}</code></div><div class="runtime-actions"><NButton size="small" :disabled="disabled || Boolean(inspecting)" :loading="inspecting === profile.id" @click="inspect(profile)">检测版本</NButton><NButton size="small" :disabled="disabled" @click="open(profile)">编辑</NButton></div></div>
      <div v-if="inspection(profile)" class="runtime-inspection"><div class="heading-line"><NTag size="small" :bordered="false" :type="inspection(profile)!.available && inspection(profile)!.compatible ? 'success' : 'warning'">{{ inspection(profile)!.available && inspection(profile)!.compatible ? '可执行文件与参数兼容' : '需要检查' }}</NTag><span>认证仍未检查</span></div><code>{{ inspection(profile)!.path }}</code><p v-if="inspection(profile)!.version">{{ inspection(profile)!.version }}</p><p v-if="inspection(profile)!.error" class="error-details">{{ inspection(profile)!.error }}</p><p>版本和参数检测不会调用模型，也不代表账号已经登录或模型可以使用。</p></div>
    </article></div>
    <p class="panel-footnote">自动检测不会调用模型。分镜草稿先进入审阅，不会自动应用。</p>
    <NModal v-model:show="show" preset="card" :title="editingId ? '编辑本机 CLI' : '添加本机 CLI'" class="provider-modal" :mask-closable="!disabled" :closable="!disabled">
      <NForm @submit.prevent="save">
        <div class="runtime-detection-line"><span role="status"><NSpin v-if="detecting" :size="14" />{{ detecting ? '正在检测本机 CLI…' : `已发现 ${detected.length} 个本机 CLI` }}</span><NButton text size="small" :loading="detecting" :disabled="disabled || detecting" @click="detect">重新检测</NButton></div>
        <NAlert v-if="detectionError" type="error" :show-icon="false" class="draft-alert">{{ detectionError }}</NAlert>
        <template v-if="!manual">
          <NFormItem label="选择本机 CLI"><NSelect aria-label="选择本机 CLI" :input-props="{ 'aria-label': '选择本机 CLI' }" :value="selectedPath" :options="cliOptions" :loading="detecting" :disabled="disabled || detecting" placeholder="选择已检测到的 CLI" @update:value="selectRuntime" /></NFormItem>
          <p v-if="!detecting && !detected.length" class="form-note">未找到 Claude Code 或 Codex。安装后可重新检测，也可以手动指定已有安装。</p>
          <p v-else-if="editingId && !selectedPath && !detecting" class="form-note">未在常见目录找到当前安装，已保留原配置；可在高级设置中调整。</p>
          <div v-if="selectedRuntime" class="runtime-detected-summary"><NTag size="small" :bordered="false" :type="selectedRuntime.inspection.compatible ? 'success' : 'warning'">{{ selectedRuntime.inspection.compatible ? '已识别' : '版本需检查' }}</NTag><code>{{ selectedRuntime.binaryPath }}</code></div>
          <NAlert v-if="selectedRuntime?.inspection.error" type="warning" :show-icon="false" class="draft-alert">{{ selectedRuntime.inspection.error }}</NAlert>
        </template>
        <NFormItem label="选择模型"><NSelect aria-label="选择模型" :input-props="{ 'aria-label': '选择模型' }" :value="form.model || null" :options="modelOptions" filterable tag :disabled="disabled || detecting || !form.binaryPath" placeholder="选择模型，也可输入其他模型 ID" @update:value="changeModel" /></NFormItem>
        <p class="form-note">{{ modelHint }} 账号权限未验证，以实际调用结果为准。</p>
        <NFormItem label="推理强度"><NSelect aria-label="推理强度" :input-props="{ 'aria-label': '推理强度' }" :value="form.reasoningEffort ?? 'default'" :options="effortOptions" :disabled="disabled || detecting || !form.model" @update:value="changeEffort" /></NFormItem>
        <p class="form-note">{{ effortOptions.length > 1 ? '强度越高，通常耗时与用量越多。模型默认不额外指定强度。' : '未检测到可选强度，使用模型默认。' }}<span v-if="form.kind === 'claude-code' && effortOptions.length > 1">档位由 CLI 帮助提供，具体模型可能有限制。</span></p>
        <NCollapse v-model:expanded-names="advanced" class="runtime-advanced"><NCollapseItem title="高级设置" name="details">
          <NFormItem label="名称"><NInput :input-props="{ 'aria-label': '名称' }" v-model:value="form.label" :maxlength="120" :disabled="disabled" placeholder="例如 我的本机草稿助手" /></NFormItem>
          <NFormItem label="CLI 类型"><NSelect aria-label="CLI 类型" :input-props="{ 'aria-label': 'CLI 类型' }" :value="form.kind" :disabled="disabled" :options="[{ label: 'Codex CLI', value: 'codex-cli' }, { label: 'Claude Code', value: 'claude-code' }]" @update:value="changeKind" /></NFormItem>
          <NFormItem label="可执行文件绝对路径"><div class="native-path-field"><NInput :input-props="{ 'aria-label': '可执行文件绝对路径' }" v-model:value="form.binaryPath" :disabled="disabled" placeholder="填写本机真实安装路径，不接受命令或参数" /><NativePathButton kind="runtime" label="选择本机 CLI 可执行文件" :disabled="disabled" @select="form.binaryPath = $event" /></div></NFormItem>
          <NFormItem label="一次执行超时（秒）"><NInputNumber :input-props="{ 'aria-label': '一次执行超时（秒）' }" :value="form.timeoutMs / 1000" :min="0.1" :max="600" :precision="1" :disabled="disabled" @update:value="value => { if (value !== null) form.timeoutMs = Math.round(value * 1000); }" /></NFormItem>
        </NCollapseItem></NCollapse>
        <div v-if="!manual" class="runtime-manual-button"><NButton text size="small" :disabled="disabled || detecting" @click="useManual">手动添加其他安装</NButton></div>
        <NCheckbox v-model:checked="form.enabled" :disabled="disabled || detecting" class="reasoning-acknowledgement">启用为草稿工具，允许使用此 CLI 已有的本机登录与权限</NCheckbox>
        <p v-if="form.enabled" class="form-note">仅启用你信任的 CLI。它可能连接自身配置的服务，并使用本机权限；OwnTake 不提供操作系统沙盒。</p>
        <div class="dialog-actions"><NButton :disabled="disabled" @click="show = false">取消</NButton><NButton type="primary" attr-type="submit" :loading="disabled" :disabled="disabled || detecting || !valid">保存 CLI 设置</NButton></div>
      </NForm>
    </NModal>
  </section>
</template>
