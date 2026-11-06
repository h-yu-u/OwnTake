import { computed, onBeforeUnmount, ref } from 'vue';
import type { AppEvent, AppSettings, Health, Project, ProjectSnapshot, Ratio, TimelineDraft } from '../types.ts';
import { api, ApiRequestError, errorMessage, openSession } from '../lib/api.ts';
import { emptyTimeline, timelineDraft, timelineProblems } from '../lib/timeline.ts';

const LAST_PROJECT_KEY = 'owntake.last-project';
const MAX_FILE_BYTES = 256 * 1024 * 1024;

export function useWorkspace() {
  const projects = ref<Project[]>([]);
  const snapshot = ref<ProjectSnapshot | null>(null);
  const draft = ref<TimelineDraft>(emptyTimeline('16:9'));
  const draftBaseVersion = ref(0);
  const savedDraft = ref(JSON.stringify(draft.value));
  const health = ref<Health | null>(null);
  const settings = ref<AppSettings>({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' });
  const loading = ref(false);
  const saving = ref(false);
  const creating = ref(false);
  const exporting = ref(false);
  const importing = ref<{ current: number; total: number; name: string } | null>(null);
  const connection = ref<'connecting' | 'online' | 'offline'>('connecting');
  const connectionError = ref('');
  const dirty = computed(() => JSON.stringify(draft.value) !== savedDraft.value);
  const busy = computed(() => loading.value || saving.value || creating.value || exporting.value || Boolean(importing.value));
  const problems = computed(() => timelineProblems(draft.value, snapshot.value?.artifacts || []));
  const runningCount = computed(() => (snapshot.value?.jobs || []).filter(job => !['succeeded', 'failed', 'cancelled'].includes(job.status)).length);
  const exportRequests = new Map<string, string>();
  let selectionRequest = 0;
  let refreshRequest = 0;
  let source: EventSource | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  function acceptSnapshot(next: ProjectSnapshot, resetDraft = false) {
    const shouldReplace = resetDraft || !dirty.value;
    snapshot.value = next;
    projects.value = projects.value.map(project => project.id === next.project.id ? next.project : project);
    if (shouldReplace) {
      draft.value = next.timeline ? timelineDraft(next.timeline) : emptyTimeline(next.project.ratio);
      savedDraft.value = JSON.stringify(draft.value);
      draftBaseVersion.value = next.timeline?.version || 0;
    }
  }

  function closeEvents() {
    source?.close(); source = null;
    if (refreshTimer) clearTimeout(refreshTimer);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    refreshTimer = null; reconnectTimer = null;
  }

  async function refreshProject(resetDraft = false): Promise<void> {
    const id = snapshot.value?.project.id;
    if (!id) return;
    const requestId = ++refreshRequest;
    try {
      const next = await api.project(id);
      if (disposed || requestId !== refreshRequest || snapshot.value?.project.id !== id) return;
      acceptSnapshot(next, resetDraft);
      connection.value = 'online'; connectionError.value = '';
    } catch (error) {
      if (disposed || requestId !== refreshRequest) return;
      connection.value = 'offline'; connectionError.value = errorMessage(error);
      throw error;
    }
  }

  function connectEvents() {
    closeEvents();
    const current = snapshot.value;
    if (!current || disposed) return;
    const id = current.project.id;
    source = new EventSource(`/api/events?projectId=${encodeURIComponent(id)}&after=${current.eventCursor}`);
    source.onopen = () => { connection.value = 'online'; connectionError.value = ''; void refreshProject().catch(() => undefined); };
    source.addEventListener('change', event => {
      try {
        const update = JSON.parse((event as MessageEvent<string>).data) as AppEvent;
        if (update.projectId !== id || !snapshot.value || update.seq <= snapshot.value.eventCursor) return;
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => { void refreshProject().catch(() => undefined); }, 160);
      } catch { /* A malformed notification cannot replace persisted application state. */ }
    });
    source.addEventListener('snapshot_required', () => { void refreshProject().then(connectEvents).catch(() => undefined); });
    source.onerror = () => {
      connection.value = 'connecting';
      source?.close(); source = null;
      if (reconnectTimer) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void openSession(true).then(() => refreshProject()).then(connectEvents).catch(() => {
          connection.value = 'offline';
          if (!disposed) reconnectTimer = setTimeout(() => { reconnectTimer = null; connectEvents(); }, 5000);
        });
      }, 3000);
    };
  }

  async function selectProject(id: string): Promise<void> {
    const requestId = ++selectionRequest;
    loading.value = true;
    closeEvents(); ++refreshRequest;
    try {
      const next = await api.project(id);
      if (requestId !== selectionRequest || disposed) return;
      acceptSnapshot(next, true);
      try { localStorage.setItem(LAST_PROJECT_KEY, id); } catch { /* Selection preference is optional. */ }
      connection.value = 'online'; connectionError.value = '';
      connectEvents();
    } finally { if (requestId === selectionRequest) loading.value = false; }
  }

  async function initialize(): Promise<void> {
    loading.value = true; connection.value = 'connecting'; connectionError.value = '';
    try {
      await openSession(true);
      const [projectList, localHealth, localSettings] = await Promise.all([api.projects(), api.health(), api.settings()]);
      projects.value = projectList; health.value = localHealth; settings.value = localSettings;
      connection.value = 'online';
      let remembered = snapshot.value?.project.id;
      try { remembered ||= localStorage.getItem(LAST_PROJECT_KEY) || undefined; } catch { /* Optional preference. */ }
      const target = projectList.find(project => project.id === remembered) || projectList[0];
      if (target) {
        if (snapshot.value?.project.id === target.id) { await refreshProject(); connectEvents(); }
        else await selectProject(target.id);
      }
    } catch (error) { connection.value = 'offline'; connectionError.value = errorMessage(error); }
    finally { loading.value = false; }
  }

  async function createProject(input: { name: string; brief: string; ratio: Ratio }): Promise<void> {
    creating.value = true;
    try {
      const created = await api.createProject(input);
      projects.value = [created, ...projects.value];
      await selectProject(created.id);
    } finally { creating.value = false; }
  }

  async function importFiles(files: File[]): Promise<{ imported: number; failures: string[] }> {
    const id = snapshot.value?.project.id;
    if (!id || !files.length || importing.value) return { imported: 0, failures: [] };
    const failures: string[] = [];
    let imported = 0;
    try {
      for (const [index, file] of files.entries()) {
        importing.value = { current: index + 1, total: files.length, name: file.name };
        if (file.size > MAX_FILE_BYTES) { failures.push(`${file.name}：超过 256 MB。`); continue; }
        try { await api.importAsset(id, file); imported++; }
        catch (error) { failures.push(`${file.name}：${errorMessage(error)}`); }
      }
      await refreshProject().catch(() => undefined);
      return { imported, failures };
    } finally { importing.value = null; }
  }

  async function saveTimeline() {
    const current = snapshot.value;
    if (!current) throw new ApiRequestError('请先打开一个项目。', 'PROJECT_REQUIRED');
    const issues = timelineProblems(draft.value, current.artifacts);
    if (issues.length) throw new ApiRequestError(issues[0]!, 'TIMELINE_INVALID');
    const submitted = timelineDraft(draft.value);
    saving.value = true;
    try {
      const saved = await api.saveTimeline(current.project.id, submitted, draftBaseVersion.value);
      if (snapshot.value?.project.id === current.project.id) {
        savedDraft.value = JSON.stringify(submitted);
        draftBaseVersion.value = saved.version;
        snapshot.value = { ...snapshot.value, timeline: saved };
        await refreshProject().catch(() => undefined);
      }
      return saved;
    } finally { saving.value = false; }
  }

  async function exportTimeline() {
    const current = snapshot.value;
    if (!current || exporting.value) return;
    if (problems.value.length) throw new ApiRequestError(problems.value[0]!, 'TIMELINE_INVALID');
    exporting.value = true;
    try {
      const saved = dirty.value || !current.timeline ? await saveTimeline() : current.timeline;
      const key = `${current.project.id}:${saved.id}`;
      const operationId = exportRequests.get(key) || crypto.randomUUID();
      exportRequests.set(key, operationId);
      const job = await api.export(current.project.id, saved.id, operationId);
      exportRequests.delete(key);
      if (snapshot.value?.project.id === current.project.id) snapshot.value = { ...snapshot.value, jobs: [job, ...snapshot.value.jobs.filter(item => item.id !== job.id)] };
      await refreshProject().catch(() => undefined);
      return job;
    } finally { exporting.value = false; }
  }

  async function cancelJob(id: string): Promise<void> {
    const job = await api.cancelJob(id);
    if (snapshot.value) snapshot.value = { ...snapshot.value, jobs: snapshot.value.jobs.map(item => item.id === job.id ? job : item) };
    await refreshProject().catch(() => undefined);
  }
  async function checkHealth(): Promise<void> { health.value = await api.health(); }
  async function saveSettings(input: AppSettings): Promise<void> { settings.value = await api.saveSettings(input); await checkHealth(); }
  function beforeUnload(event: BeforeUnloadEvent) { if (dirty.value) { event.preventDefault(); event.returnValue = ''; } }
  window.addEventListener('beforeunload', beforeUnload);
  onBeforeUnmount(() => { disposed = true; closeEvents(); window.removeEventListener('beforeunload', beforeUnload); });

  return { projects, snapshot, draft, draftBaseVersion, dirty, health, settings, loading, saving, creating, exporting,
    importing, busy, connection, connectionError, problems, runningCount,
    initialize, selectProject, createProject, importFiles, saveTimeline, exportTimeline, cancelJob,
    refreshProject, checkHealth, saveSettings };
}
