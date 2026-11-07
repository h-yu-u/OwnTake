<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { NAlert, NButton, NSelect, NSpin, useDialog, useMessage } from 'naive-ui';
import type { AppSettings, DraftOperation, Ratio, Reservation, StudioCreateRequest, StudioKind, ViewId } from './types.ts';
import { api, errorMessage } from './lib/api.ts';
import { renewDraftOperations } from './lib/storyboard.ts';
import { storyboardApi } from './lib/storyboardApi.ts';
import type { ProviderInput } from './lib/providerApi.ts';
import { useWorkspace } from './composables/useWorkspace.ts';
import { useStoryboard } from './composables/useStoryboard.ts';
import { useGenerations } from './composables/useGenerations.ts';
import { useStudio } from './composables/useStudio.ts';
import { useDesktop } from './composables/useDesktop.ts';
import { desktopApi } from './lib/desktop.ts';
import { studioApi } from './lib/studioApi.ts';
import type { RuntimeSettingsInput, SettlementInput } from './lib/studioApi.ts';
import { generationApi } from './lib/generationApi.ts';
import type { GenerationRequest, HumanReviewInput } from './lib/generationApi.ts';
import AppIcon from './components/AppIcon.vue';
import EmptyState from './components/EmptyState.vue';
import ProjectDialog from './components/ProjectDialog.vue';
import ProjectDetailsDialog from './components/ProjectDetailsDialog.vue';
import DraftComposer from './components/DraftComposer.vue';
import ReasoningDialog from './components/ReasoningDialog.vue';
import GenerationDialog from './components/GenerationDialog.vue';
import StudioRequestDialog from './components/StudioRequestDialog.vue';
import StudioView from './views/StudioView.vue';
import ProjectsView from './views/ProjectsView.vue';
import CharacterLibraryView from './views/CharacterLibraryView.vue';
import StoryLibraryView from './views/StoryLibraryView.vue';
import WorkbenchView from './views/WorkbenchView.vue';
import JobsView from './views/JobsView.vue';
import ExportView from './views/ExportView.vue';
import SettingsView from './views/SettingsView.vue';
import StoryboardView from './views/StoryboardView.vue';

const desktop = useDesktop();
const { available: desktopAvailable, info: desktopInfo, loading: desktopLoading, error: desktopError } = desktop;
const openingProjectFolder = ref(false);
const revealingArtifact = ref<string | null>(null);
const workspace = useWorkspace();
const { projects, snapshot, draft, draftBaseVersion, dirty, health, settings, loading, saving, creating, exporting, importing, busy, connection, connectionError, problems, runningCount } = workspace;
const storyboard = useStoryboard(snapshot);
const { board, calls, providers, loading: boardLoading, mutating: boardBusy, loadError: boardError, editorMode, selectedId, selectedShot, fields: editorFields, shots, editorDirty, editorBaseRevision, editorConflict } = storyboard;
const generation = useGenerations(snapshot);
const { records: generationRecords, reviews, busy: generationBusy, error: generationError } = generation;
const studio = useStudio(snapshot);
const { operations: studioOperations, runtimes, busy: studioBusy, error: studioError } = studio;
const message = useMessage();
const dialog = useDialog();
const navigation: { id: ViewId; label: string; icon: string }[] = [{ id: 'characters', label: '人物库', icon: 'projects' }, { id: 'stories', label: '故事库', icon: 'storyboard' }, { id: 'projects', label: '作品', icon: 'projects' }, { id: 'storyboard', label: '分镜', icon: 'storyboard' }, { id: 'workbench', label: '素材剪辑', icon: 'workbench' }, { id: 'studio', label: '创作工具', icon: 'studio' }, { id: 'jobs', label: '任务', icon: 'jobs' }, { id: 'export', label: '导出', icon: 'export' }, { id: 'settings', label: '设置', icon: 'settings' }];
const rememberedView = window.location.hash.slice(1);
const view = ref<ViewId>(navigation.some(item => item.id === rememberedView) ? rememberedView as ViewId : 'projects');
const projectDialog = ref(false);
const projectDetailsDialog = ref(false);
const draftComposer = ref(false);
const reasoningDialog = ref(false);
const generationDialog = ref(false);
const studioDialog = ref(false);
const studioKind = ref<StudioKind>('tts');
const generationShotId = ref<string | null>(null);
const generationShot = computed(() => board.value?.shots.find(shot => shot.id === generationShotId.value) || null);
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
const disabled = computed(() => busy.value || boardBusy.value || generationBusy.value || studioBusy.value || savingProject.value || creatingBoardTimeline.value || restoring.value || savingSettings.value || connection.value === 'offline');
const projectOptions = computed(() => projects.value.map(project => ({ label: project.name, value: project.id })));
const connectionLabel = computed(() => connection.value === 'offline' ? '本地服务离线' : connection.value === 'connecting' ? '正在连接' : health.value?.status === 'degraded' ? '媒体工具待设置' : '本地工作台已就绪');

watch(view, next => { window.history.replaceState(null, '', `#${next}`); });
watch(() => snapshot.value?.project.name, name => { document.title = name ? `${name} · OwnTake` : 'OwnTake · 自己的片场'; });
onMounted(async () => { await workspace.initialize(); await perform(async () => { await Promise.all([storyboard.loadProviders(), studio.loadRuntimes()]); }); initialized.value = true; });

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
  if (dirty.value) dialog.warning({ title: '用分镜生成新的时间线？', content: '继续将重建镜头与镜头字幕，并保留最近已保存时间线的音轨和输出设置。当前未保存的调整将放弃；若新时长放不下原音轨，操作会明确报错。', positiveText: '使用分镜建立时间线', negativeText: '继续编辑', onPositiveClick: action });
  else void action();
}
async function createDraft(operations: DraftOperation[]) { if (await perform(() => storyboard.createDraft(operations), '草稿已保存，等待逐项审阅')) { draftComposer.value = false; reviewRevision.value++; } }
async function renewDraft(id: string) { const existing = board.value?.drafts.find(item => item.id === id); if (existing) await createDraft(renewDraftOperations(existing)); }
async function applyDraft(input: { id: string; acceptedOperationIds: string[] }) { await perform(() => storyboard.applyDraft(input.id, input.acceptedOperationIds), `已应用 ${input.acceptedOperationIds.length} 项变更`); }
async function saveProvider(input: { id: string | null; profile: ProviderInput }) { await perform(() => storyboard.saveProvider(input.id, input.profile), '连接已保存，尚未发起模型请求'); }
function openReasoning() {
  if (!snapshot.value?.project.brief.trim()) { message.info('先写下创作简报，再让模型提出分镜建议。'); projectDetailsDialog.value = true; return; }
  reasoningDialog.value = true;
}
async function requestReasoning(input: { providerId: string; reservation: Reservation; clientRequestId: string; expectedProviderUpdatedAt: string }) { if (await perform(() => storyboard.requestReasoning(input.providerId, input.reservation, input.clientRequestId, input.expectedProviderUpdatedAt), '推理请求已登记，可在调用记录中查看进度')) { reasoningDialog.value = false; reviewRevision.value++; } }
async function settleCall(input: { id: string; actualAmount: number; currency: Reservation['currency']; note: string }) { await perform(() => storyboard.settleCall(input.id, { actualAmount: input.actualAmount, currency: input.currency, note: input.note }), '费用核对结果已记录'); }
async function saveProjectDetails(input: { name: string; brief: string; ratio: Ratio; expectedRevision: number }) {
  if (!snapshot.value) return;
  savingProject.value = true;
  try { if (await perform(async () => { const project = await api.updateProject(snapshot.value!.project.id, input); snapshot.value = { ...snapshot.value!, project }; projects.value = projects.value.map(item => item.id === project.id ? project : item); await workspace.refreshProject().catch(() => undefined); }, '创作简报已保存')) projectDetailsDialog.value = false; }
  finally { savingProject.value = false; }
}
async function openGeneration(id: string) {
  if (!await perform(() => storyboard.loadProviders())) return;
  generationShotId.value = id; generationDialog.value = true;
}
async function submitGeneration(input: { shotId: string; request: GenerationRequest }) {
  if (await perform(() => generation.submit(input.shotId, input.request), '生成请求已登记，结果将保存为候选')) { generationDialog.value = false; view.value = 'jobs'; }
}
async function saveHumanReview(input: { shotId: string; review: HumanReviewInput }) { await perform(() => generation.review(input.shotId, input.review), '人工复核记录已保存'); }
function viewGenerationCandidate(id: string) {
  if (!shots.value.some(shot => shot.id === id)) { message.info('这个镜头已归档，生成文件仍可从任务记录下载。'); return; }
  confirmEditorDiscard(() => { storyboard.selectShot(id); view.value = 'storyboard'; });
}
async function reconcileGeneration(input: { id: string; remoteTaskId: string; note: string }) { await perform(() => generation.mutate(() => generationApi.reconcile(input.id, input.remoteTaskId, input.note)), '已关联原任务，后续只查询原任务状态'); }
async function settleGeneration(input: { id: string; actualAmount: number; currency: Reservation['currency']; note: string }) { await perform(() => generation.mutate(() => generationApi.settle(input.id, { actualAmount: input.actualAmount, currency: input.currency, note: input.note })), '生成费用核对已记录'); }

async function saveRuntime(input: { id: string | null; profile: RuntimeSettingsInput }) { await perform(() => studio.saveRuntime(input.id, input.profile), '本机 CLI 设置已保存，尚未调用模型'); }
async function openStudio(kind: StudioKind) {
  if (!await perform(async () => { await Promise.all([storyboard.loadProviders(), studio.loadRuntimes(), storyboard.refresh(), generation.refresh(), studio.refresh()]); })) return;
  studioKind.value = kind; studioDialog.value = true;
}
async function submitStudio(input: StudioCreateRequest) {
  if (await perform(() => studio.submit(input), '创作操作已登记，结果会保存在操作台账')) { studioDialog.value = false; view.value = 'studio'; }
}
async function settleStudio(input: SettlementInput) { await perform(() => studio.mutate(() => studioApi.settle(input)), '实际费用核对已记录'); }
function cancelStudio(id: string) {
  dialog.warning({ title: '请求停止本地处理？', content: '如果外部服务或 CLI 已收到请求，它仍可能继续处理并产生费用。停止后将保留操作记录与费用预留。', positiveText: '请求停止', negativeText: '继续处理', onPositiveClick: () => perform(() => studio.mutate(() => studioApi.cancel(id)), '停止请求已记录；外部处理状态以操作台账为准') });
}
async function viewStudioDraft(id: string) {
  if (!await perform(() => storyboard.refresh())) return;
  if (!board.value?.drafts.some(item => item.id === id)) { message.info('草稿暂未载入，请刷新操作与分镜记录。'); return; }
  view.value = 'storyboard'; await nextTick(); reviewRevision.value++;
}
async function addStudioAudio(id: string) {
  const asset = snapshot.value?.artifacts.find(item => item.id === id && item.kind === 'audio');
  if (!asset) { message.info('音频素材快照尚未载入，请稍后刷新。'); return; }
  view.value = 'workbench';
  if (!draft.value.clips.length) { message.info('先在时间线安排画面，再从独立音轨选择这份配音。'); return; }
  if (draft.value.audio.length >= 16) { message.warning('独立音轨已达到 16 条，请先移除不需要的音轨。'); return; }
  draft.value = { ...draft.value, audio: [...draft.value.audio, { artifactId: asset.id, startMs: 0, sourceInMs: 0, gainDb: 0, fadeInMs: 0, fadeOutMs: 0 }] };
  message.success('配音已加入时间线草稿；请调整入点、音量并保存。');
  await nextTick(); document.getElementById('audio-tracks')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function onStoryDraftCreated(projectId: string) {
  const ok=await perform(async()=>{
    await workspace.initialize();
    await workspace.selectProject(projectId);
    await storyboard.refresh();
    reviewRevision.value++;
    view.value='storyboard';
  }, '分镜草稿已建立，等待逐项审阅');
  if (!ok) view.value='stories';
}
async function onShotCastBound() {
  generationDialog.value=false;
  await perform(async()=>{
    await storyboard.refresh();
    await workspace.refreshProject();
  }, '已更新镜头出场人物，请重新审阅生成计划');
}
async function onStoryProjectCreated(id: string) {
  await perform(async () => { await workspace.initialize(); await workspace.selectProject(id); view.value = 'storyboard'; }, '项目已建立，可开始制作分镜');
}

async function openProjectFolder() {
  const projectId = snapshot.value?.project.id;
  if (!desktopAvailable || !projectId || openingProjectFolder.value) return;
  openingProjectFolder.value = true;
  try { await perform(() => desktopApi.openProject(projectId)); }
  finally { openingProjectFolder.value = false; }
}
async function revealArtifact(id: string) {
  if (!desktopAvailable || revealingArtifact.value) return;
  revealingArtifact.value = id;
  try { await perform(() => desktopApi.revealArtifact(id)); }
  finally { revealingArtifact.value = null; }
}
</script>

<template>
  <a class="skip-link" href="#main-content">跳到主要内容</a>
  <div class="app-shell">
    <header class="topbar"><button class="brand" aria-label="OwnTake 项目首页" @click="view = 'projects'"><span class="brand-mark" aria-hidden="true"><span></span></span><span>Own<span class="brand-take">Take</span></span></button><div class="topbar-divider"></div><NSelect class="project-switch" :value="snapshot?.project.id || null" :options="projectOptions" placeholder="选择一个项目" :disabled="disabled || !projects.length" aria-label="当前项目" @update:value="chooseProject" /><NButton v-if="desktopAvailable && snapshot" quaternary size="small" class="open-project-folder" :loading="openingProjectFolder" :disabled="disabled || openingProjectFolder" aria-label="打开当前项目目录" @click="openProjectFolder"><template #icon><AppIcon name="folder" :size="17" /></template><span class="desktop-project-label">项目目录</span></NButton><div class="topbar-spacer"></div><span class="connection-status" :class="connection" role="status"><span class="status-dot" :class="{ unavailable: connection === 'offline', connecting: connection === 'connecting' }"></span>{{ connectionLabel }}</span><NButton size="small" :disabled="disabled" @click="openCreate"><template #icon><AppIcon name="plus" :size="16" /></template><span class="new-project-label">新建项目</span></NButton></header>
    <aside class="global-nav"><nav aria-label="主导航" class="nav-items"><button v-for="item in navigation" :key="item.id" class="nav-item" :class="{ 'is-active': view === item.id }" :aria-current="view === item.id ? 'page' : undefined" @click="view = item.id"><span class="nav-icon-wrap"><AppIcon :name="item.icon" :size="21" /><span v-if="item.id === 'jobs' && runningCount" class="nav-count">{{ runningCount }}</span></span><span>{{ item.label }}</span></button></nav><div class="local-mark"><span class="status-dot"></span><span>LOCAL<br />FIRST</span></div></aside>
    <main id="main-content" tabindex="-1">
      <NAlert v-if="connection === 'offline' || connectionError" type="error" :show-icon="false" class="connection-alert"><div class="alert-line"><div><strong>暂时无法连接本地工作台</strong><p>{{ connectionError || '请确认本地服务仍在运行。重连后会从保存的任务记录恢复状态。' }}</p></div><NButton :loading="loading" @click="workspace.initialize">重新连接</NButton></div></NAlert>
      <NAlert v-if="actionError" type="error" :show-icon="false" closable class="action-alert" @close="actionError = ''"><p class="error-details">{{ actionError }}</p></NAlert>
      <div v-if="!initialized" class="initial-loading"><NSpin size="large" /><p>正在打开你的片场…</p></div>
      <template v-else>
        <CharacterLibraryView v-if="view === 'characters'" :projects="projects" :current-project-id="snapshot?.project.id" />
        <StoryLibraryView v-else-if="view === 'stories'" :projects="projects" @project-created="onStoryProjectCreated" @storyboard-draft="onStoryDraftCreated" />
        <ProjectsView v-else-if="view === 'projects'" :projects="projects" :active-id="snapshot?.project.id" :disabled="disabled" @create="openCreate" @select="chooseProject" />
        <SettingsView v-else-if="view === 'settings'" :settings="settings" :health="health" :disabled="disabled" :saving="savingSettings" :checking="checkingHealth" :providers="providers" :runtimes="runtimes" :desktop-available="desktopAvailable" :desktop-info="desktopInfo" :desktop-loading="desktopLoading" :desktop-error="desktopError" @refresh-desktop="desktop.refresh" @save="saveSettings" @check="checkHealth" @save-provider="saveProvider" @refresh-providers="perform(() => storyboard.loadProviders())" @save-runtime="saveRuntime" @refresh-runtimes="perform(() => studio.loadRuntimes())" />
        <EmptyState v-else-if="!snapshot" title="先为作品留一个位置" description="新建或打开一个项目，再开始导入素材、安排画面与导出。" icon="projects"><NButton type="primary" :disabled="disabled" @click="openCreate">新建项目</NButton><NButton @click="view = 'projects'">查看作品</NButton></EmptyState>
        <StoryboardView v-else-if="view === 'storyboard'" :snapshot="snapshot" :board="board" :shots="shots" :selected-shot="selectedShot" :selected-id="selectedId" :fields="editorFields" :editor-mode="editorMode" :editor-dirty="editorDirty" :editor-conflict="editorConflict" :editor-base-revision="editorBaseRevision" :disabled="disabled" :loading="boardLoading" :error="boardError" :calls="calls" :providers="providers" :reviews="reviews" :review-revision="reviewRevision" @update:fields="editorFields = $event" @create="createShot" @select="chooseShot" @save="perform(() => storyboard.saveShot(), '镜头已保存')" @archive="archiveShot" @move="perform(() => storyboard.moveShot($event.id, $event.direction))" @add-candidate="perform(() => storyboard.addCandidate($event), '素材已加入当前视觉版本的候选')" @select-candidate="selectCandidate" @assets="view = 'workbench'" @timeline="saveBoardTimeline" @refresh="perform(() => storyboard.refresh())" @reload-editor="reloadShot" @create-draft="draftComposer = true" @apply-draft="applyDraft" @renew-draft="renewDraft" @reasoning="openReasoning" @generate="openGeneration" @review="saveHumanReview" @details="projectDetailsDialog = true" @settle="settleCall" />
        <WorkbenchView v-else-if="view === 'workbench'" :snapshot="snapshot" :draft="draft" :dirty="dirty" :version="draftBaseVersion" :preview-revision="previewRevision" :disabled="disabled" :saving="saving" :importing="importing" :problems="problems" @update:draft="draft = $event" @import="importFiles" @restore="restoreAsset" @save="saveTimeline" @export="view = 'export'" @reload="reloadTimeline" @settings="view = 'settings'" />
        <StudioView v-else-if="view === 'studio'" :records="studioOperations" :artifacts="snapshot.artifacts" :providers="providers" :runtimes="runtimes" :disabled="disabled" :error="studioError" @request="openStudio" @settings="view = 'settings'" @refresh="perform(() => studio.refresh())" @cancel="cancelStudio" @retry="perform(() => studio.mutate(() => studioApi.retryIngest($event)), '已请求恢复原回复入库，不会重新调用模型')" @settle="settleStudio" @draft="viewStudioDraft" @audio="addStudioAudio" @candidate="viewGenerationCandidate" />
        <JobsView v-else-if="view === 'jobs'" :jobs="snapshot.jobs" :artifacts="snapshot.artifacts" :cancelling="cancelling" :generations="generationRecords" :providers="providers" :shots="shots" :studio-operations="studioOperations" @studio="view = 'studio'" :generation-error="generationError" :disabled="disabled" @cancel="cancelJob" @refresh="perform(() => workspace.refreshProject())" @workbench="view = 'workbench'" @export="view = 'export'" @refresh-generations="perform(() => generation.refresh())" @candidate="viewGenerationCandidate" @cancel-generation="perform(() => generation.mutate(() => generationApi.cancel($event)), '取消请求已记录，等待确认')" @polling="perform(() => generation.mutate(() => generationApi.polling($event.id, $event.paused)))" @retry-download="perform(() => generation.mutate(() => generationApi.retryDownload($event)), '已请求重试原任务结果下载')" @reconcile="reconcileGeneration" @settle-generation="settleGeneration" />
        <ExportView v-else-if="view === 'export'" :snapshot="snapshot" :draft="draft" :dirty="dirty" :disabled="disabled" :exporting="exporting" :health="health" :problems="problems" :desktop-available="desktopAvailable" :revealing-artifact="revealingArtifact" @reveal="revealArtifact" @update:draft="draft = $event" @export="exportTimeline" @jobs="view = 'jobs'" @settings="view = 'settings'" @workbench="view = 'workbench'" />
      </template>
    </main>
    <ProjectDialog v-model:show="projectDialog" :busy="creating" @create="createProject" />
    <template v-if="snapshot">
      <ProjectDetailsDialog v-model:show="projectDetailsDialog" :project="snapshot.project" :disabled="disabled" @save="saveProjectDetails" />
      <DraftComposer v-model:show="draftComposer" :shots="shots" :artifacts="snapshot.artifacts" :disabled="disabled" @create="createDraft" />
      <ReasoningDialog v-model:show="reasoningDialog" :project="snapshot.project" :shots="shots" :board-revision="board?.revision || 0" :providers="providers" :calls="calls" :generations="generationRecords" :studio-operations="studioOperations" :disabled="disabled" @submit="requestReasoning" @settings="reasoningDialog = false; view = 'settings'" />
      <GenerationDialog v-if="generationShot" v-model:show="generationDialog" :shot="generationShot" :project="snapshot.project" :providers="providers" :artifacts="snapshot.artifacts" :calls="calls" :generations="generationRecords" :studio-operations="studioOperations" :disabled="disabled" @submit="submitGeneration" @cast-bound="onShotCastBound" @characters="generationDialog = false; view = 'characters'" @settings="generationDialog = false; view = 'settings'" />
      <StudioRequestDialog v-model:show="studioDialog" :kind="studioKind" :project="snapshot.project" :board="board" :artifacts="snapshot.artifacts" :providers="providers" :runtimes="runtimes" :calls="calls" :generations="generationRecords" :studio-operations="studioOperations" :disabled="disabled" @submit="submitStudio" @settings="studioDialog = false; view = 'settings'" @details="studioDialog = false; projectDetailsDialog = true" />
    </template>
  </div>
</template>
