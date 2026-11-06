<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { NAlert, NButton, NSelect, NSpin, useDialog, useMessage } from 'naive-ui';
import type { AppSettings, Ratio, ViewId } from './types.ts';
import { api, errorMessage } from './lib/api.ts';
import { useWorkspace } from './composables/useWorkspace.ts';
import AppIcon from './components/AppIcon.vue';
import EmptyState from './components/EmptyState.vue';
import ProjectDialog from './components/ProjectDialog.vue';
import ProjectsView from './views/ProjectsView.vue';
import WorkbenchView from './views/WorkbenchView.vue';
import JobsView from './views/JobsView.vue';
import ExportView from './views/ExportView.vue';
import SettingsView from './views/SettingsView.vue';

const workspace = useWorkspace();
const { projects, snapshot, draft, draftBaseVersion, dirty, health, settings, loading, saving, creating, exporting, importing, busy, connection, connectionError, problems, runningCount } = workspace;
const message = useMessage();
const dialog = useDialog();
const navigation: { id: ViewId; label: string; icon: string }[] = [{ id: 'projects', label: '作品', icon: 'projects' }, { id: 'workbench', label: '工作台', icon: 'workbench' }, { id: 'jobs', label: '任务', icon: 'jobs' }, { id: 'export', label: '导出', icon: 'export' }, { id: 'settings', label: '设置', icon: 'settings' }];
const rememberedView = window.location.hash.slice(1);
const view = ref<ViewId>(navigation.some(item => item.id === rememberedView) ? rememberedView as ViewId : 'projects');
const projectDialog = ref(false);
const initialized = ref(false);
const actionError = ref('');
const savingSettings = ref(false);
const checkingHealth = ref(false);
const restoring = ref(false);
const previewRevision = ref(0);
const cancelling = ref<string[]>([]);
const disabled = computed(() => busy.value || restoring.value || savingSettings.value || connection.value === 'offline');
const projectOptions = computed(() => projects.value.map(project => ({ label: project.name, value: project.id })));
const connectionLabel = computed(() => connection.value === 'offline' ? '本地服务离线' : connection.value === 'connecting' ? '正在连接' : health.value?.status === 'degraded' ? '媒体工具待设置' : '本地工作台已就绪');

watch(view, next => { window.history.replaceState(null, '', `#${next}`); });
watch(() => snapshot.value?.project.name, name => { document.title = name ? `${name} · OwnTake` : 'OwnTake · 自己的片场'; });
onMounted(async () => { await workspace.initialize(); initialized.value = true; });

async function perform(action: () => Promise<unknown>, success?: string): Promise<boolean> {
  actionError.value = '';
  try { await action(); if (success) message.success(success); return true; }
  catch (error) { actionError.value = errorMessage(error); message.error(actionError.value, { duration: 7000 }); return false; }
}
function confirmDiscard(action: () => void, title = '离开当前项目？') {
  if (!dirty.value) { action(); return; }
  dialog.warning({ title, content: '时间线还有未保存的修改。继续将放弃这些修改，已保存的素材和任务会保留。', positiveText: '放弃修改并继续', negativeText: '继续编辑', onPositiveClick: action });
}
function openCreate() { confirmDiscard(() => { projectDialog.value = true; }, '创建另一个项目？'); }
function chooseProject(id: string) {
  if (id === snapshot.value?.project.id) { view.value = 'workbench'; return; }
  confirmDiscard(() => { void perform(() => workspace.selectProject(id)).then(ok => { if (ok) view.value = 'workbench'; }); });
}
async function createProject(input: { name: string; brief: string; ratio: Ratio }) {
  if (await perform(() => workspace.createProject(input), '项目已创建')) { projectDialog.value = false; view.value = 'workbench'; }
}
async function importFiles(files: File[]) {
  actionError.value = '';
  try {
    const result = await workspace.importFiles(files);
    if (result.imported) message.success(`已导入 ${result.imported} 个素材`);
    if (result.failures.length) { actionError.value = result.failures.join('\n'); message.warning(`${result.failures.length} 个文件未能导入，请查看错误详情。`, { duration: 7000 }); }
  } catch (error) { actionError.value = errorMessage(error); message.error(actionError.value); }
}
async function restoreAsset(input: { id: string; file: File }) {
  if (input.file.size > 256 * 1024 * 1024) { message.error('单个文件不能超过 256 MB。'); return; }
  restoring.value = true;
  try { await perform(async () => { await api.restoreAsset(input.id, input.file); previewRevision.value++; await workspace.refreshProject().catch(() => undefined); }, '原素材文件已恢复'); }
  finally { restoring.value = false; }
}
async function saveTimeline() { await perform(() => workspace.saveTimeline(), '时间线已保存'); }
async function exportTimeline() { if (await perform(() => workspace.exportTimeline(), '导出任务已创建，本地服务正在处理')) view.value = 'jobs'; }
async function cancelJob(id: string) {
  cancelling.value = [...cancelling.value, id];
  try { await perform(() => workspace.cancelJob(id), '停止请求已发送'); }
  finally { cancelling.value = cancelling.value.filter(value => value !== id); }
}
function reloadTimeline() { confirmDiscard(() => { void perform(() => workspace.refreshProject(true), '已载入最新保存版本'); }, '重新载入已存时间线？'); }
async function saveSettings(input: AppSettings) {
  savingSettings.value = true;
  try { await perform(() => workspace.saveSettings(input), '工具设置已保存'); }
  finally { savingSettings.value = false; }
}
async function checkHealth() {
  checkingHealth.value = true;
  try { await perform(() => workspace.checkHealth()); }
  finally { checkingHealth.value = false; }
}
</script>

<template>
  <a class="skip-link" href="#main-content">跳到主要内容</a>
  <div class="app-shell">
    <header class="topbar"><button class="brand" aria-label="OwnTake 项目首页" @click="view = 'projects'"><span class="brand-mark" aria-hidden="true"><span></span></span><span>Own<span class="brand-take">Take</span></span></button><div class="topbar-divider"></div><NSelect class="project-switch" :value="snapshot?.project.id || null" :options="projectOptions" placeholder="选择一个项目" :disabled="disabled || !projects.length" aria-label="当前项目" @update:value="chooseProject" /><div class="topbar-spacer"></div><span class="connection-status" :class="connection" role="status"><span class="status-dot" :class="{ unavailable: connection === 'offline', connecting: connection === 'connecting' }"></span>{{ connectionLabel }}</span><NButton size="small" :disabled="disabled" @click="openCreate"><template #icon><AppIcon name="plus" :size="16" /></template><span class="new-project-label">新建项目</span></NButton></header>
    <aside class="global-nav"><nav aria-label="主导航" class="nav-items"><button v-for="item in navigation" :key="item.id" class="nav-item" :class="{ 'is-active': view === item.id }" :aria-current="view === item.id ? 'page' : undefined" @click="view = item.id"><span class="nav-icon-wrap"><AppIcon :name="item.icon" :size="21" /><span v-if="item.id === 'jobs' && runningCount" class="nav-count">{{ runningCount }}</span></span><span>{{ item.label }}</span></button></nav><div class="local-mark"><span class="status-dot"></span><span>LOCAL<br />FIRST</span></div></aside>
    <main id="main-content" tabindex="-1">
      <NAlert v-if="connection === 'offline' || connectionError" type="error" :show-icon="false" class="connection-alert"><div class="alert-line"><div><strong>暂时无法连接本地工作台</strong><p>{{ connectionError || '请确认本地服务仍在运行。重连后会从保存的任务记录恢复状态。' }}</p></div><NButton :loading="loading" @click="workspace.initialize">重新连接</NButton></div></NAlert>
      <NAlert v-if="actionError" type="error" :show-icon="false" closable class="action-alert" @close="actionError = ''"><p class="error-details">{{ actionError }}</p></NAlert>
      <div v-if="!initialized" class="initial-loading"><NSpin size="large" /><p>正在打开你的片场…</p></div>
      <template v-else>
        <ProjectsView v-if="view === 'projects'" :projects="projects" :active-id="snapshot?.project.id" :disabled="disabled" @create="openCreate" @select="chooseProject" />
        <SettingsView v-else-if="view === 'settings'" :settings="settings" :health="health" :disabled="disabled" :saving="savingSettings" :checking="checkingHealth" @save="saveSettings" @check="checkHealth" />
        <EmptyState v-else-if="!snapshot" title="先为作品留一个位置" description="新建或打开一个项目，再开始导入素材、安排画面与导出。" icon="projects"><NButton type="primary" :disabled="disabled" @click="openCreate">新建项目</NButton><NButton @click="view = 'projects'">查看作品</NButton></EmptyState>
        <WorkbenchView v-else-if="view === 'workbench'" :snapshot="snapshot" :draft="draft" :dirty="dirty" :version="draftBaseVersion" :preview-revision="previewRevision" :disabled="disabled" :saving="saving" :importing="importing" :problems="problems" @update:draft="draft = $event" @import="importFiles" @restore="restoreAsset" @save="saveTimeline" @export="view = 'export'" @reload="reloadTimeline" />
        <JobsView v-else-if="view === 'jobs'" :jobs="snapshot.jobs" :artifacts="snapshot.artifacts" :cancelling="cancelling" :disabled="disabled" @cancel="cancelJob" @refresh="perform(() => workspace.refreshProject())" @workbench="view = 'workbench'" @export="view = 'export'" />
        <ExportView v-else-if="view === 'export'" :snapshot="snapshot" :draft="draft" :dirty="dirty" :disabled="disabled" :exporting="exporting" :health="health" :problems="problems" @update:draft="draft = $event" @export="exportTimeline" @jobs="view = 'jobs'" @settings="view = 'settings'" @workbench="view = 'workbench'" />
      </template>
    </main>
    <ProjectDialog v-model:show="projectDialog" :busy="creating" @create="createProject" />
  </div>
</template>
