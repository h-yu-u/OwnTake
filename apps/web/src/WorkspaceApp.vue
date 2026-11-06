<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { NAlert, NButton, NSelect, NSpin, useDialog, useMessage } from 'naive-ui';
import type { AppSettings, DraftOperation, Ratio, Reservation, ViewId } from './types.ts';
import { api, errorMessage } from './lib/api.ts';
import { renewDraftOperations } from './lib/storyboard.ts';
import { storyboardApi } from './lib/storyboardApi.ts';
import type { ProviderInput } from './lib/providerApi.ts';
import { useWorkspace } from './composables/useWorkspace.ts';
import { useStoryboard } from './composables/useStoryboard.ts';
import AppIcon from './components/AppIcon.vue';
import EmptyState from './components/EmptyState.vue';
import ProjectDialog from './components/ProjectDialog.vue';
import ProjectDetailsDialog from './components/ProjectDetailsDialog.vue';
import DraftComposer from './components/DraftComposer.vue';
import ReasoningDialog from './components/ReasoningDialog.vue';
import ProjectsView from './views/ProjectsView.vue';
import WorkbenchView from './views/WorkbenchView.vue';
import JobsView from './views/JobsView.vue';
import ExportView from './views/ExportView.vue';
import SettingsView from './views/SettingsView.vue';
import StoryboardView from './views/StoryboardView.vue';

const workspace = useWorkspace();
const { projects, snapshot, draft, draftBaseVersion, dirty, health, settings, loading, saving, creating, exporting, importing, busy, connection, connectionError, problems, runningCount } = workspace;
const storyboard = useStoryboard(snapshot);
const { board, calls, providers, loading: boardLoading, mutating: boardBusy, loadError: boardError, editorMode, selectedId, selectedShot, fields: editorFields, shots, editorDirty, editorBaseRevision, editorConflict } = storyboard;
const message = useMessage();
const dialog = useDialog();
const navigation: { id: ViewId; label: string; icon: string }[] = [{ id: 'projects', label: '作品', icon: 'projects' }, { id: 'storyboard', label: '分镜', icon: 'storyboard' }, { id: 'workbench', label: '素材剪辑', icon: 'workbench' }, { id: 'jobs', label: '任务', icon: 'jobs' }, { id: 'export', label: '导出', icon: 'export' }, { id: 'settings', label: '设置', icon: 'settings' }];
const rememberedView = window.location.hash.slice(1);
const view = ref<ViewId>(navigation.some(item => item.id === rememberedView) ? rememberedView as ViewId : 'projects');
const projectDialog = ref(false);
const projectDetailsDialog = ref(false);
const draftComposer = ref(false);
const reasoningDialog = ref(false);
const reviewRevision = ref(0);
const savingProject = ref(false);
const creatingBoardTimeline = ref(false);
const initialized = ref(false);
const actionError = ref('');
const savingSettings = ref(false);
const checkingHealth = ref(false);
const restoring = ref(false);
const previewRevision = ref(0);
const cancelling = ref<string[]>([]);
const disabled = computed(() => busy.value || boardBusy.value || savingProject.value || creatingBoardTimeline.value || restoring.value || savingSettings.value || connection.value === 'offline');
const projectOptions = computed(() => projects.value.map(project => ({ label: project.name, value: project.id })));
const connectionLabel = computed(() => connection.value === 'offline' ? '本地服务离线' : connection.value === 'connecting' ? '正在连接' : health.value?.status === 'degraded' ? '媒体工具待设置' : '本地工作台已就绪');

watch(view, next => { window.history.replaceState(null, '', `#${next}`); });
watch(() => snapshot.value?.project.name, name => { document.title = name ? `${name} · OwnTake` : 'OwnTake · 自己的片场'; });
onMounted(async () => { await workspace.initialize(); await perform(() => storyboard.loadProviders()); initialized.value = true; });

async function perform(action: () => Promise<unknown>, success?: string): Promise<boolean> {
  actionError.value = '';
  try { await action(); if (success) message.success(success); return true; }
  catch (error) { actionError.value = errorMessage(error); message.error(actionError.value, { duration: 7000 }); return false; }
}
function confirmDiscard(action: () => void, title = '离开当前项目？') {
  if (!dirty.value && !editorDirty.value) { action(); return; }
  dialog.warning({ title, content: '时间线或镜头还有未保存的修改。继续将放弃这些修改，已保存的素材和任务会保留。', positiveText: '放弃修改并继续', negativeText: '继续编辑', onPositiveClick: action });
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
function confirmEditorDiscard(action: () => void) {
  if (!editorDirty.value) { action(); return; }
  dialog.warning({ title: '离开正在编辑的镜头？', content: '镜头文字还有未保存修改。继续将放弃这些输入。', positiveText: '放弃修改并继续', negativeText: '继续编辑', onPositiveClick: action });
}
function chooseShot(id: string) { if (id !== selectedId.value) confirmEditorDiscard(() => storyboard.selectShot(id)); }
function createShot() { confirmEditorDiscard(() => storyboard.newShot()); }
function reloadShot() { confirmEditorDiscard(() => { if (selectedId.value) storyboard.selectShot(selectedId.value); }); }
function archiveShot(id: string) { const shot = shots.value.find(item => item.id === id); dialog.warning({ title: `归档「${shot?.title || '这个镜头'}」？`, content: '镜头会从当前分镜顺序移除，历史素材与候选保留。这个镜头尚未保存的输入也会放弃。', positiveText: '归档镜头', negativeText: '保留镜头', onPositiveClick: () => perform(() => storyboard.archiveShot(id), '镜头已归档') }); }
function selectCandidate(id: string) {
  const candidate = board.value?.candidates.find(item => item.id === id);
  const adopt = () => { void perform(() => storyboard.selectCandidate(id), '已更新当前选用素材'); };
  if (candidate && selectedShot.value && candidate.visualRevision !== selectedShot.value.visualRevision) dialog.warning({ title: '采用旧视觉要求的候选？', content: `这份候选来自视觉要求 v${candidate.visualRevision}，当前要求为 v${selectedShot.value.visualRevision}。采用后仍会保留旧版本提示，导出使用你明确选定的素材。`, positiveText: '确认采用旧候选', negativeText: '继续比较', onPositiveClick: adopt });
  else adopt();
}
function saveBoardTimeline() {
  const action = async () => {
    if (!snapshot.value) return;
    creatingBoardTimeline.value = true;
    try { if (await perform(async () => { const saved = await storyboardApi.timeline(snapshot.value!.project.id, snapshot.value!.timeline?.version || 0); workspace.adoptTimeline(saved); await workspace.refreshProject().catch(() => undefined); }, '已按分镜顺序保存到时间线')) view.value = 'workbench'; }
    finally { creatingBoardTimeline.value = false; }
  };
  if (dirty.value) dialog.warning({ title: '用分镜生成新的时间线？', content: '当前时间线还有未保存的调整。继续将按已保存的镜头顺序与所选素材建立新版本，并放弃这些未保存的调整。', positiveText: '使用分镜建立时间线', negativeText: '继续编辑', onPositiveClick: action });
  else void action();
}
async function createDraft(operations: DraftOperation[]) { if (await perform(() => storyboard.createDraft(operations), '草稿已保存，等待逐项审阅')) { draftComposer.value = false; reviewRevision.value++; } }
async function renewDraft(id: string) { const existing = board.value?.drafts.find(item => item.id === id); if (existing) await createDraft(renewDraftOperations(existing)); }
async function applyDraft(input: { id: string; acceptedOperationIds: string[] }) { await perform(() => storyboard.applyDraft(input.id, input.acceptedOperationIds), `已应用 ${input.acceptedOperationIds.length} 项变更`); }
async function saveProvider(input: { id: string | null; profile: ProviderInput }) { await perform(() => storyboard.saveProvider(input.id, input.profile), '连接已保存，尚未发起推理请求'); }
function openReasoning() {
  if (!snapshot.value?.project.brief.trim()) { message.info('先写下创作简报，再让模型提出分镜建议。'); projectDetailsDialog.value = true; return; }
  reasoningDialog.value = true;
}
async function requestReasoning(input: { providerId: string; reservation: Reservation; clientRequestId: string }) { if (await perform(() => storyboard.requestReasoning(input.providerId, input.reservation, input.clientRequestId), '推理请求已登记，可在调用记录中查看进度')) { reasoningDialog.value = false; reviewRevision.value++; } }
async function settleCall(input: { id: string; actualAmount: number; currency: Reservation['currency']; note: string }) { await perform(() => storyboard.settleCall(input.id, { actualAmount: input.actualAmount, currency: input.currency, note: input.note }), '费用核对结果已记录'); }
async function saveProjectDetails(input: { name: string; brief: string; ratio: Ratio; expectedRevision: number }) {
  if (!snapshot.value) return;
  savingProject.value = true;
  try { if (await perform(async () => { const project = await api.updateProject(snapshot.value!.project.id, input); snapshot.value = { ...snapshot.value!, project }; projects.value = projects.value.map(item => item.id === project.id ? project : item); await workspace.refreshProject().catch(() => undefined); }, '创作简报已保存')) projectDetailsDialog.value = false; }
  finally { savingProject.value = false; }
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
        <SettingsView v-else-if="view === 'settings'" :settings="settings" :health="health" :disabled="disabled" :saving="savingSettings" :checking="checkingHealth" :providers="providers" @save="saveSettings" @check="checkHealth" @save-provider="saveProvider" @refresh-providers="perform(() => storyboard.loadProviders())" />
        <EmptyState v-else-if="!snapshot" title="先为作品留一个位置" description="新建或打开一个项目，再开始导入素材、安排画面与导出。" icon="projects"><NButton type="primary" :disabled="disabled" @click="openCreate">新建项目</NButton><NButton @click="view = 'projects'">查看作品</NButton></EmptyState>
        <StoryboardView v-else-if="view === 'storyboard'" :snapshot="snapshot" :board="board" :shots="shots" :selected-shot="selectedShot" :selected-id="selectedId" :fields="editorFields" :editor-mode="editorMode" :editor-dirty="editorDirty" :editor-conflict="editorConflict" :editor-base-revision="editorBaseRevision" :disabled="disabled" :loading="boardLoading" :error="boardError" :calls="calls" :providers="providers" :review-revision="reviewRevision" @update:fields="editorFields = $event" @create="createShot" @select="chooseShot" @save="perform(() => storyboard.saveShot(), '镜头已保存')" @archive="archiveShot" @move="perform(() => storyboard.moveShot($event.id, $event.direction))" @add-candidate="perform(() => storyboard.addCandidate($event), '素材已加入当前视觉版本的候选')" @select-candidate="selectCandidate" @assets="view = 'workbench'" @timeline="saveBoardTimeline" @refresh="perform(() => storyboard.refresh())" @reload-editor="reloadShot" @create-draft="draftComposer = true" @apply-draft="applyDraft" @renew-draft="renewDraft" @reasoning="openReasoning" @details="projectDetailsDialog = true" @settle="settleCall" />
        <WorkbenchView v-else-if="view === 'workbench'" :snapshot="snapshot" :draft="draft" :dirty="dirty" :version="draftBaseVersion" :preview-revision="previewRevision" :disabled="disabled" :saving="saving" :importing="importing" :problems="problems" @update:draft="draft = $event" @import="importFiles" @restore="restoreAsset" @save="saveTimeline" @export="view = 'export'" @reload="reloadTimeline" />
        <JobsView v-else-if="view === 'jobs'" :jobs="snapshot.jobs" :artifacts="snapshot.artifacts" :cancelling="cancelling" :disabled="disabled" @cancel="cancelJob" @refresh="perform(() => workspace.refreshProject())" @workbench="view = 'workbench'" @export="view = 'export'" />
        <ExportView v-else-if="view === 'export'" :snapshot="snapshot" :draft="draft" :dirty="dirty" :disabled="disabled" :exporting="exporting" :health="health" :problems="problems" @update:draft="draft = $event" @export="exportTimeline" @jobs="view = 'jobs'" @settings="view = 'settings'" @workbench="view = 'workbench'" />
      </template>
    </main>
    <ProjectDialog v-model:show="projectDialog" :busy="creating" @create="createProject" />
    <template v-if="snapshot">
      <ProjectDetailsDialog v-model:show="projectDetailsDialog" :project="snapshot.project" :disabled="disabled" @save="saveProjectDetails" />
      <DraftComposer v-model:show="draftComposer" :shots="shots" :artifacts="snapshot.artifacts" :disabled="disabled" @create="createDraft" />
      <ReasoningDialog v-model:show="reasoningDialog" :project="snapshot.project" :shots="shots" :board-revision="board?.revision || 0" :providers="providers" :calls="calls" :disabled="disabled" @submit="requestReasoning" @settings="reasoningDialog = false; view = 'settings'" />
    </template>
  </div>
</template>
