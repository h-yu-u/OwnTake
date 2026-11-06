import { onBeforeUnmount, ref, watch } from 'vue';
import type { Ref } from 'vue';
import type { GenerationRecord, ProjectSnapshot, ReviewRecord } from '../types.ts';
import { generationApi } from '../lib/generationApi.ts';
import type { GenerationRequest, HumanReviewInput } from '../lib/generationApi.ts';
import { errorMessage } from '../lib/api.ts';

export function useGenerations(project: Ref<ProjectSnapshot | null>) {
  const records = ref<GenerationRecord[]>([]);
  const reviews = ref<ReviewRecord[]>([]);
  const busy = ref(false);
  const error = ref('');
  let sequence = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  function accept(record: GenerationRecord) {
    if (record.projectId !== project.value?.project.id) return;
    const current = records.value.find(item => item.id === record.id);
    if (current && current.updatedAt > record.updatedAt) return;
    records.value = [record, ...records.value.filter(item => item.id !== record.id)];
  }
  async function refresh() {
    const id = project.value?.project.id;
    if (!id) return;
    const request = ++sequence;
    try {
      const [next, checks] = await Promise.all([generationApi.list(id), generationApi.reviews(id)]);
      if (disposed || sequence !== request || project.value?.project.id !== id) return;
      next.forEach(accept); reviews.value = [...new Map([...reviews.value, ...checks].map(review => [review.id, review])).values()]; error.value = '';
    } catch (failure) { if (sequence === request && !disposed) error.value = errorMessage(failure); throw failure; }
  }
  watch(() => [project.value?.project.id, project.value?.eventCursor] as const, (next, previous) => {
    if (!next[0]) return;
    if (next[0] !== previous?.[0]) { ++sequence; if (timer) clearTimeout(timer); timer = null; records.value = []; reviews.value = []; void refresh().catch(() => undefined); }
    else if (!timer) timer = setTimeout(() => { timer = null; void refresh().catch(() => undefined); }, 500);
  }, { immediate: true });
  async function mutate(action: () => Promise<GenerationRecord>) { busy.value = true; try { const result = await action(); accept(result); return result; } finally { busy.value = false; } }
  async function submit(shotId: string, input: GenerationRequest) { return mutate(() => generationApi.submit(shotId, input)); }
  async function review(shotId: string, input: HumanReviewInput) {
    busy.value = true;
    try { const result = await generationApi.review(shotId, input); reviews.value = [result, ...reviews.value.filter(item => item.id !== result.id)]; return result; }
    finally { busy.value = false; }
  }
  onBeforeUnmount(() => { disposed = true; ++sequence; if (timer) clearTimeout(timer); });
  return { records, reviews, busy, error, refresh, mutate, submit, review };
}
