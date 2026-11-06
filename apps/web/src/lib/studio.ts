import type { ProviderSummary, SpeechInput, StudioKind, StudioOperation, StudioStatus } from '../types.ts';

export const studioKindLabels: Record<StudioKind, string> = { tts: '配音', frame_review: '抽样帧审核', runtime_draft: '本机 CLI 草稿' };
export const studioStatusLabels: Record<StudioStatus, string> = { queued: '等待执行', submitting: '正在请求', received: '已接收，等待入库', ingest_failed: '本地入库失败', submission_unknown: '提交结果不明', succeeded: '已完成', failed: '已失败', cancelled: '本地已停止' };
export function studioTone(status: StudioStatus): 'default' | 'info' | 'success' | 'warning' | 'error' {
  return status === 'succeeded' ? 'success' : status === 'failed' ? 'error' : ['submission_unknown', 'ingest_failed'].includes(status) ? 'warning' : ['queued', 'submitting', 'received'].includes(status) ? 'info' : 'default';
}
export function studioCanSettle(record: StudioOperation): boolean { return ['succeeded', 'failed', 'cancelled', 'submission_unknown', 'ingest_failed'].includes(record.status); }
export function studioCanRetryIngest(record: StudioOperation): boolean { return record.status === 'ingest_failed'; }
export function speechProblems(input: SpeechInput, provider?: ProviderSummary): string[] {
  const capabilities = provider?.capabilities.speech;
  if (provider?.kind !== 'openai-speech' || !capabilities) return ['请选择已声明语音能力的配音连接。'];
  const issues: string[] = [];
  if (!input.text.trim()) issues.push('请填写要朗读的文字。');
  if (input.text.length > capabilities.maxInputChars) issues.push(`文字超过此连接声明的 ${capabilities.maxInputChars} 字符上限。`);
  if (!capabilities.voices.includes(input.voice)) issues.push('请选择此连接声明支持的声音。');
  if (!Number.isFinite(input.speed) || input.speed < capabilities.minSpeed || input.speed > capabilities.maxSpeed) issues.push(`语速须在 ${capabilities.minSpeed}–${capabilities.maxSpeed} 倍之间。`);
  if ((input.instructions?.length || 0) > 4096) issues.push('风格指令超过 4096 字符上限。');
  if (input.instructions?.trim() && !capabilities.supportsInstructions) issues.push('此连接未声明支持风格指令；请明确移除指令或更换连接。');
  return issues;
}
export function parseVoiceChoices(value: string): string[] { return [...new Set(value.split(/[,，\n]/).map(item => item.trim()).filter(Boolean))]; }
export function isAbsoluteExecutable(value: string): boolean { return value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value); }
