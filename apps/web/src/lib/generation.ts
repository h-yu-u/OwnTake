import type { GenerationPlan, GenerationStatus, ProviderInputMode, Ratio, Shot } from '../types.ts';
export const inputModeOptions: { label: string; value: ProviderInputMode }[] = [
  { label: '纯文字', value: 'text' }, { label: '首帧图片', value: 'first_frame' }, { label: '首帧 + 尾帧', value: 'first_last_frame' }, { label: '参考图片', value: 'references' },
];
export const ratioOptions = [{ label: '16:9 · 横屏', value: '16:9' }, { label: '9:16 · 竖屏', value: '9:16' }, { label: '1:1 · 方形', value: '1:1' }];
export const generationLabels: Record<GenerationStatus, string> = {
  queued: '等待提交', submitting: '正在提交', submission_unknown: '提交结果不明', waiting_remote: '远端处理中',
  remote_succeeded: '远端已完成', ingesting: '结果入库中', download_failed: '结果下载失败', succeeded: '候选已入库', failed: '失败', cancelled: '已确认取消',
};
export function generationTone(status: GenerationStatus): 'success' | 'error' | 'warning' | 'default' {
  return status === 'succeeded' ? 'success' : ['failed', 'download_failed'].includes(status) ? 'error' : status === 'cancelled' ? 'default' : 'warning';
}
export function initialGenerationPlan(shot: Shot, ratio: Ratio): GenerationPlan {
  const kind = shot.mode === 'generate_image' ? 'image' : 'video';
  return { kind, inputMode: shot.referenceArtifactIds.length ? 'references' : 'text', prompt: [shot.description, shot.action].filter(Boolean).join('\n'), ratio,
    ...(kind === 'video' ? { durationSec: shot.durationMs / 1000 } : {}), referenceArtifactIds: [...shot.referenceArtifactIds] };
}
export function parseDurationChoices(input: string): number[] | null {
  if (!input.trim()) return [];
  const values = input.trim().split(/[\s,，、]+/).map(Number);
  return values.every(value => Number.isFinite(value) && value > 0 && value <= 600) ? [...new Set(values)].sort((a, b) => a - b) : null;
}
