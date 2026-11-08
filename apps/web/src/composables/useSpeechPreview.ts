import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { Ref } from 'vue';
import type { ProviderSummary, SpeechInput, StudioCreateRequest, StudioOperation } from '../types.ts';
import { errorMessage } from '../lib/api.ts';
import { studioApi } from '../lib/studioApi.ts';

interface Attempt { projectId: string; request: StudioCreateRequest; operation: StudioOperation | null }
const pending = (record: StudioOperation) => ['queued', 'submitting', 'received'].includes(record.status);

/** Replays audio and queries durable local intents; never retries a supplier submission. */
export function useSpeechPreview(projectId: Ref<string>, provider: Ref<ProviderSummary | undefined>, input: Ref<SpeechInput>, active: Ref<boolean>, records: Ref<StudioOperation[]>) {
  const attempts = ref<Record<string, Attempt>>({});
  const busy = ref(false), error = ref('');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const key = computed(() => JSON.stringify([projectId.value, provider.value?.id, provider.value?.updatedAt, input.value]));
  const attempt = computed(() => attempts.value[key.value]);
  const operation = computed(() => {
    const saved = attempt.value?.operation;
    if (saved) {
      const latest = records.value.find(record => record.id === saved.id);
      return latest && latest.updatedAt >= saved.updatedAt ? latest : saved;
    }
    // Reopening the dialog or refreshing the page reuses the same known result.
    return records.value.find(record => record.projectId === projectId.value && record.kind === 'tts' && !record.speechBatch
      && record.targetId === provider.value?.id && record.targetModel === provider.value?.model
      && record.createdAt >= provider.value.updatedAt && JSON.stringify(record.input) === JSON.stringify(input.value)) ?? null;
  });
  const waiting = computed(() => Boolean(operation.value && pending(operation.value)));
  const registrationUnknown = computed(() => Boolean(attempt.value && !attempt.value.operation));
  function stopPolling() { if (timer) clearTimeout(timer); timer = undefined; }
  async function refresh() {
    const entry = attempt.value, id = operation.value?.id;
    if (!entry || !id) return;
    try {
      const record = (await studioApi.list(entry.projectId)).find(record => record.id === id);
      if (!disposed && record) { entry.operation = record; error.value = ''; }
    } catch (failure) { if (!disposed) error.value = errorMessage(failure); }
    finally { schedule(); }
  }
  function schedule() {
    stopPolling();
    if (!disposed && active.value && waiting.value) timer = setTimeout(() => { void refresh(); }, 1500);
  }
  watch([key, active, waiting], () => { error.value = ''; schedule(); });
  async function generate() {
    if (busy.value || !provider.value || operation.value) return;
    const requestKey = key.value;
    const entry = attempts.value[requestKey] ??= { projectId: projectId.value, operation: null,
      request: { kind: 'tts', targetId: provider.value.id, expectedTargetUpdatedAt: provider.value.updatedAt,
        clientRequestId: crypto.randomUUID(), input: { ...input.value } } };
    busy.value = true; error.value = '';
    try {
      // If the local response was lost, an explicit query resends this SAME intent.
      // The server returns its persisted operation without a second supplier POST.
      const record = await studioApi.create(entry.projectId, entry.request);
      if (!disposed) attempts.value[requestKey]!.operation = record;
    } catch (failure) { if (!disposed) error.value = errorMessage(failure); }
    finally { busy.value = false; schedule(); }
  }
  onBeforeUnmount(() => { disposed = true; stopPolling(); });
  return { operation, busy, waiting, registrationUnknown, error, generate };
}
