import { onMounted, ref } from 'vue';
import type { DesktopInfo } from '../types.ts';
import { errorMessage } from '../lib/api.ts';
import { desktopApi, desktopBridge } from '../lib/desktop.ts';

export function useDesktop() {
  const available = Boolean(desktopBridge());
  const info = ref<DesktopInfo | null>(null);
  const loading = ref(false);
  const error = ref('');
  async function refresh() {
    if (!available || loading.value) return;
    loading.value = true; error.value = '';
    try { info.value = await desktopApi.info(); }
    catch (failure) { error.value = errorMessage(failure); }
    finally { loading.value = false; }
  }
  onMounted(refresh);
  return { available, info, loading, error, refresh };
}
