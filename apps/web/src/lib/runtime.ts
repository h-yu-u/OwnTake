import type { DiscoveredLocalRuntime, LocalReasoningEffort, LocalRuntimeInput } from '../types.ts';

export const reasoningEffortLabels: Record<LocalReasoningEffort, string> = {
  none: '关闭', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高',
};
export function runtimeEffortOptions(form: LocalRuntimeInput, runtime?: DiscoveredLocalRuntime) {
  const model = runtime?.models.find(option => option.id === form.model);
  const levels = model?.reasoningEfforts ?? (form.kind === 'claude-code' ? runtime?.inspection.reasoningEfforts : undefined) ?? [];
  const defaultLabel = model?.defaultReasoningEffort ? `模型默认（${reasoningEffortLabels[model.defaultReasoningEffort]}）` : '模型默认';
  const options = [{ label: defaultLabel, value: 'default' }, ...levels.map(level => ({ label: `${reasoningEffortLabels[level]} · ${level}`, value: level }))];
  // Preserve an existing/custom configuration while making its uncertainty visible.
  if (form.reasoningEffort && !levels.includes(form.reasoningEffort)) options.push({ label: `${reasoningEffortLabels[form.reasoningEffort]} · ${form.reasoningEffort}（已保存，能力未确认）`, value: form.reasoningEffort });
  return options;
}
