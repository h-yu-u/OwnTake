import { onBeforeUnmount, ref, watch } from 'vue';
import type { ProviderModelCatalog, ProviderModelDiscoveryInput } from '../types.ts';
import { errorMessage } from '../lib/api.ts';
import { providerApi } from '../lib/providerApi.ts';

/** Debounced metadata lookup; obsolete replies never replace the current credentials' catalog. */
export function useProviderModelCatalog(source: () => ProviderModelDiscoveryInput | null, enabled: () => boolean) {
  const catalog = ref<ProviderModelCatalog | null>(null), loading = ref(false), error = ref(''), attempted = ref(false);
  let sequence = 0, disposed = false;
  let controller: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  function invalidate() {
    ++sequence; controller?.abort(); controller = null;
    if (timer) clearTimeout(timer);
    timer = null; catalog.value = null; loading.value = false; error.value = ''; attempted.value = false;
  }
  async function refresh() {
    const input = source();
    if (disposed || !enabled() || !input) return;
    if (timer) clearTimeout(timer);
    timer = null;
    const request = ++sequence, pending = new AbortController();
    controller?.abort(); controller = pending; loading.value = true; error.value = ''; attempted.value = true;
    try {
      const result = await providerApi.models(input, pending.signal);
      if (!disposed && sequence === request) catalog.value = result;
    } catch (failure) {
      if (!disposed && sequence === request) { catalog.value = null; error.value = errorMessage(failure); }
    } finally {
      if (!disposed && sequence === request) { loading.value = false; controller = null; }
    }
  }
  watch([source, enabled], () => {
    invalidate();
    if (enabled() && source()) timer = setTimeout(() => { timer = null; void refresh(); }, 800);
  }, { flush: 'sync', immediate: true });
  onBeforeUnmount(() => { disposed = true; invalidate(); });
  return { catalog, loading, error, attempted, refresh };
}
