import { onBeforeUnmount, ref } from 'vue';
import type { OpenAIConnectionSummary } from '../types.ts';
import { ApiRequestError, errorMessage } from '../lib/api.ts';
import { openaiApi } from '../lib/openaiApi.ts';
import type { OpenAIConnectionSave } from '../lib/openaiApi.ts';

export function useOpenAIConnections() {
  const connections = ref<OpenAIConnectionSummary[]>([]);
  const loading = ref(false);
  const saving = ref(false);
  const error = ref('');
  const savedRevision = ref(0);
  let requestSequence = 0;
  let disposed = false;

  async function loadConnections(): Promise<void> {
    const sequence = ++requestSequence;
    loading.value = true;
    error.value = '';
    try {
      const next = await openaiApi.list();
      if (!disposed && sequence === requestSequence) connections.value = next;
    } catch (failure) {
      if (!disposed && sequence === requestSequence) error.value = errorMessage(failure);
      throw failure;
    } finally {
      if (!disposed && sequence === requestSequence) loading.value = false;
    }
  }

  async function saveConnection(value: OpenAIConnectionSave): Promise<OpenAIConnectionSummary> {
    if (saving.value) throw new ApiRequestError('OpenAI 连接正在保存，请稍候。');
    ++requestSequence;
    loading.value = false;
    saving.value = true;
    error.value = '';
    try {
      const saved = value.id === null
        ? await openaiApi.create(value.input)
        : await openaiApi.update(value.id, value.input);
      if (!disposed) {
        connections.value = [saved, ...connections.value.filter(connection => connection.id !== saved.id)];
        savedRevision.value++;
      }
      return saved;
    } catch (failure) {
      if (!disposed) error.value = errorMessage(failure);
      throw failure;
    } finally {
      if (!disposed) saving.value = false;
    }
  }

  function clearError(): void { error.value = ''; }
  onBeforeUnmount(() => { disposed = true; ++requestSequence; });
  return { connections, loading, saving, error, savedRevision, loadConnections, saveConnection, clearError };
}
