import { onBeforeUnmount, ref, watch } from 'vue';
import type { Ref } from 'vue';
import type { LocalRuntimeProfile, ProjectSnapshot, StudioCreateRequest, StudioOperation } from '../types.ts';
import { errorMessage } from '../lib/api.ts';
import { studioApi } from '../lib/studioApi.ts';
import type { RuntimeSettingsInput } from '../lib/studioApi.ts';

export function useStudio(project: Ref<ProjectSnapshot | null>) {
  const operations = ref<StudioOperation[]>([]);
  const runtimes = ref<LocalRuntimeProfile[]>([]);
  const busy = ref(false);
  const error = ref('');
  let sequence = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  function accept(record: StudioOperation) {
    if (record.projectId !== project.value?.project.id) return;
    const current = operations.value.find(item => item.id === record.id);
    if (current && current.updatedAt > record.updatedAt) return;
    operations.value = [record, ...operations.value.filter(item => item.id !== record.id)];
  }
  async function refresh() {
    const id = project.value?.project.id;
    if (!id) return;
    const request = ++sequence;
    try { const next = await studioApi.list(id); if (disposed || sequence !== request || project.value?.project.id !== id) return; next.forEach(accept); error.value = ''; }
    catch (failure) { if (sequence === request && !disposed) error.value = errorMessage(failure); throw failure; }
  }
  async function loadRuntimes() { const next = await studioApi.runtimes(); if (!disposed) runtimes.value = next; }
  async function saveRuntime(id: string | null, input: RuntimeSettingsInput) {
    busy.value = true;
    try { const result = id ? await studioApi.updateRuntime(id, input) : await studioApi.createRuntime(input); runtimes.value = [result, ...runtimes.value.filter(item => item.id !== result.id)]; return result; }
    finally { busy.value = false; }
  }
  async function mutate(action: () => Promise<StudioOperation>) { busy.value = true; try { const result = await action(); accept(result); return result; } finally { busy.value = false; } }
  async function submit(input: StudioCreateRequest) {
    const id = project.value?.project.id;
    if (!id) throw new Error('请先打开项目。');
    return mutate(() => studioApi.create(id, input));
  }
  watch(() => [project.value?.project.id, project.value?.eventCursor] as const, (next, previous) => {
    if (!next[0]) { ++sequence; operations.value = []; return; }
    if (next[0] !== previous?.[0]) { ++sequence; if (timer) clearTimeout(timer); timer = null; operations.value = []; void refresh().catch(() => undefined); }
    else if (!timer) timer = setTimeout(() => { timer = null; void refresh().catch(() => undefined); }, 500);
  }, { immediate: true });
  onBeforeUnmount(() => { disposed = true; ++sequence; if (timer) clearTimeout(timer); });
  return { operations, runtimes, busy, error, refresh, loadRuntimes, saveRuntime, mutate, submit };
}
