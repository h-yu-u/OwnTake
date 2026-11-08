import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { Ref } from 'vue';
import type { BoardSnapshot, CallRecord, DraftOperation, ProjectSnapshot, ProviderSummary, Reservation, Shot, ShotFields } from '../types.ts';
import { ApiRequestError, errorMessage } from '../lib/api.ts';
import { activeShots, emptyShotFields, shotFields, shotProblems } from '../lib/storyboard.ts';
import { storyboardApi } from '../lib/storyboardApi.ts';
import { providerApi } from '../lib/providerApi.ts';
import type { ProviderInput, ReasoningRequest } from '../lib/providerApi.ts';

export function useStoryboard(project: Ref<ProjectSnapshot | null>) {
  const board = ref<BoardSnapshot | null>(null);
  const calls = ref<CallRecord[]>([]);
  const providers = ref<ProviderSummary[]>([]);
  const providerSavedRevision = ref(0);
  const loading = ref(false);
  const mutating = ref(false);
  const loadError = ref('');
  const editorMode = ref<'empty' | 'new' | 'existing'>('empty');
  const selectedId = ref<string | null>(null);
  const fields = ref<ShotFields>(emptyShotFields());
  const editorBaseline = ref(JSON.stringify(fields.value));
  const editorBaseRevision = ref(0);
  const shots = computed(() => activeShots(board.value));
  const selectedShot = computed(() => board.value?.shots.find(shot => shot.id === selectedId.value) || null);
  const editorDirty = computed(() => editorMode.value !== 'empty' && JSON.stringify(fields.value) !== editorBaseline.value);
  const editorConflict = computed(() => editorMode.value === 'existing' && (!selectedShot.value || selectedShot.value.archived || selectedShot.value.revision !== editorBaseRevision.value));
  let requestSequence = 0;
  let providerRequestSequence = 0;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  function loadEditor(shot: Shot) {
    selectedId.value = shot.id; fields.value = shotFields(shot); editorBaseRevision.value = shot.revision;
    editorBaseline.value = JSON.stringify(fields.value); editorMode.value = 'existing';
  }
  function newShot() {
    selectedId.value = null; fields.value = emptyShotFields(shots.value.length); editorBaseRevision.value = 0;
    editorBaseline.value = JSON.stringify(fields.value); editorMode.value = 'new';
  }
  function selectShot(id: string) { const shot = shots.value.find(item => item.id === id); if (shot) loadEditor(shot); }
  function acceptBoard(next: BoardSnapshot) {
    if (project.value?.project.id !== next.projectId) return;
    if (board.value?.projectId === next.projectId && board.value.revision > next.revision) return;
    board.value = next;
    if (editorDirty.value || editorMode.value === 'new') return;
    const current = next.shots.find(shot => shot.id === selectedId.value && !shot.archived) || activeShots(next)[0];
    if (current) loadEditor(current);
    else { editorMode.value = 'empty'; selectedId.value = null; }
  }
  async function refresh() {
    const id = project.value?.project.id;
    if (!id) return;
    const sequence = ++requestSequence;
    try {
      const [next, records] = await Promise.all([storyboardApi.snapshot(id), providerApi.calls(id)]);
      if (disposed || sequence !== requestSequence || project.value?.project.id !== id) return;
      acceptBoard(next); calls.value = records; loadError.value = '';
    } catch (error) { if (sequence === requestSequence && !disposed) loadError.value = errorMessage(error); throw error; }
  }
  async function loadProviders() {
    const sequence = ++providerRequestSequence;
    const next = await providerApi.list();
    if (!disposed && sequence === providerRequestSequence) providers.value = next;
  }
  watch(() => [project.value?.project.id, project.value?.eventCursor] as const, async (next, previous) => {
    if (refreshTimer) clearTimeout(refreshTimer);
    if (!next[0]) return;
    if (next[0] !== previous?.[0]) {
      ++requestSequence; board.value = null; calls.value = []; selectedId.value = null; editorMode.value = 'empty';
      fields.value = emptyShotFields(); editorBaseline.value = JSON.stringify(fields.value); loading.value = true;
      try { await refresh(); } catch { /* The view presents retry controls. */ }
      finally { loading.value = false; }
    } else refreshTimer = setTimeout(() => { void refresh().catch(() => undefined); }, 350);
  }, { immediate: true });

  async function mutate<T>(action: () => Promise<T>): Promise<T> { mutating.value = true; try { return await action(); } finally { mutating.value = false; } }
  async function saveShot() {
    if (!board.value) throw new ApiRequestError('请先载入分镜。');
    const problems = shotProblems(fields.value);
    if (problems.length) throw new ApiRequestError(problems[0]!);
    const previousIds = new Set(board.value.shots.map(shot => shot.id));
    const input = shotFields(fields.value);
    const wasNew = editorMode.value !== 'existing';
    return mutate(async () => {
      const next = wasNew ? await storyboardApi.createShot(board.value!.projectId, input, board.value!.revision) : await storyboardApi.updateShot(selectedId.value!, input, editorBaseRevision.value);
      board.value = next;
      const saved = wasNew ? next.shots.find(shot => !previousIds.has(shot.id)) : next.shots.find(shot => shot.id === selectedId.value);
      if (saved) loadEditor(saved);
    });
  }
  async function archiveShot(id: string) {
    const shot = shots.value.find(item => item.id === id); if (!shot) return;
    return mutate(async () => { const next = await storyboardApi.archiveShot(id, shot.revision); if (selectedId.value === id) { editorMode.value = 'empty'; editorBaseline.value = JSON.stringify(fields.value); } acceptBoard(next); });
  }
  async function moveShot(id: string, direction: -1 | 1) {
    if (!board.value) return;
    const ordered = shots.value.map(shot => shot.id), index = ordered.indexOf(id), target = index + direction;
    if (index < 0 || target < 0 || target >= ordered.length) return;
    [ordered[index], ordered[target]] = [ordered[target]!, ordered[index]!];
    return mutate(async () => acceptBoard(await storyboardApi.reorder(board.value!.projectId, ordered, board.value!.revision)));
  }
  async function addCandidate(artifactId: string) {
    if (!selectedId.value) return;
    return mutate(async () => { await storyboardApi.candidate(selectedId.value!, artifactId); await refresh().catch(() => undefined); });
  }
  async function selectCandidate(candidateId: string) {
    if (!selectedShot.value) return;
    const shot = selectedShot.value;
    return mutate(async () => acceptBoard(await storyboardApi.selectCandidate(shot.id, candidateId, shot.revision)));
  }
  async function createDraft(operations: DraftOperation[]) {
    if (!board.value) return;
    return mutate(async () => { const saved = await storyboardApi.createDraft(board.value!.projectId, operations, board.value!.revision); board.value = { ...board.value!, drafts: [saved, ...board.value!.drafts.filter(draft => draft.id !== saved.id)] }; return saved; });
  }
  async function applyDraft(id: string, acceptedOperationIds: string[]) {
    if (!board.value) return;
    return mutate(async () => acceptBoard(await storyboardApi.applyDraft(id, acceptedOperationIds, board.value!.revision)));
  }
  async function saveProvider(id: string | null, input: ProviderInput) {
    ++providerRequestSequence;
    return mutate(async () => {
      const saved = id ? await providerApi.update(id, input) : await providerApi.create(input);
      if (!disposed) {
        ++providerRequestSequence;
        providers.value = [saved, ...providers.value.filter(provider => provider.id !== saved.id)];
        providerSavedRevision.value++;
      }
    });
  }
  async function requestReasoning(input: ReasoningRequest) {
    if (!board.value) return;
    const current = board.value;
    return mutate(async () => {
      const call = await providerApi.reason(current.projectId, input);
      calls.value = [call, ...calls.value.filter(item => item.id !== call.id)];
      return call;
    });
  }
  async function settleCall(id: string, input: { actualAmount: number; currency: Reservation['currency']; note: string }) {
    return mutate(async () => { const updated = await providerApi.settle(id, input); calls.value = calls.value.map(call => call.id === updated.id ? updated : call); });
  }
  function beforeUnload(event: BeforeUnloadEvent) { if (editorDirty.value) { event.preventDefault(); event.returnValue = ''; } }
  window.addEventListener('beforeunload', beforeUnload);
  onBeforeUnmount(() => { disposed = true; ++requestSequence; ++providerRequestSequence; if (refreshTimer) clearTimeout(refreshTimer); window.removeEventListener('beforeunload', beforeUnload); });
  return { board, calls, providers, providerSavedRevision, loading, mutating, loadError, editorMode, selectedId, selectedShot, fields, shots, editorDirty, editorBaseRevision, editorConflict,
    refresh, loadProviders, newShot, selectShot, saveShot, archiveShot, moveShot, addCandidate, selectCandidate, createDraft, applyDraft, saveProvider, requestReasoning, settleCall };
}
