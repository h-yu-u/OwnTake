import type { JobStatus } from '../types.ts';

export const jobLabels: Record<JobStatus, string> = {
  queued: '排队中', running: '正在处理', waiting_external: '等待外部结果', blocked: '需要处理',
  succeeded: '已完成', failed: '失败', cancel_requested: '正在停止', cancelled: '已停止',
};
export function jobTone(status: JobStatus): 'default' | 'success' | 'warning' | 'error' | 'info' {
  return status === 'succeeded' ? 'success' : status === 'failed' ? 'error' : ['running', 'queued', 'waiting_external', 'cancel_requested'].includes(status) ? 'warning' : 'default';
}
export function progressPercent(progress: number): number { return Number.isFinite(progress) ? Math.min(100, Math.max(0, Math.round(progress * 100))) : 0; }
export function canCancel(status: JobStatus): boolean { return ['queued', 'running', 'waiting_external', 'blocked'].includes(status); }
