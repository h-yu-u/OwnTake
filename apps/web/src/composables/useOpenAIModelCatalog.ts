import { onBeforeUnmount, ref, watch } from 'vue';
import type { OpenAIModelCatalog, OpenAIModelDiscoveryInput } from '../types.ts';
import { errorMessage } from '../lib/api.ts';
import { openaiApi } from '../lib/openaiApi.ts';

/** A directory belongs to the current dialog credentials, never to the saved form state. */
export function useOpenAIModelCatalog(source: () => OpenAIModelDiscoveryInput | null, enabled: () => boolean) {
  const catalog = ref<OpenAIModelCatalog | null>(null);
  const loading = ref(false);
  const error = ref('');
  const attempted = ref(false);
  let sequence = 0;
  let controller: AbortController | null = null;
  let disposed = false;

  function invalidate(): void {
    ++sequence;
    controller?.abort();
    controller = null;
    catalog.value = null;
    loading.value = false;
    error.value = '';
    attempted.value = false;
  }
  watch([source, enabled], invalidate, { flush: 'sync' });

  async function refresh(): Promise<void> {
    const input = source();
    if (disposed || !enabled() || !input) return;
    const request = ++sequence;
    controller?.abort();
    const pending = new AbortController();
    controller = pending;
    loading.value = true;
    error.value = '';
    attempted.value = true;
    try {
      const result = await openaiApi.models(input, pending.signal);
      if (!disposed && request === sequence) catalog.value = result;
    } catch (failure) {
      if (!disposed && request === sequence) {
        catalog.value = null;
        error.value = errorMessage(failure);
      }
    } finally {
      if (!disposed && request === sequence) {
        loading.value = false;
        controller = null;
      }
    }
  }

  onBeforeUnmount(() => { disposed = true; invalidate(); });
  return { catalog, loading, error, attempted, refresh };
}
