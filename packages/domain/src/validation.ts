import { AppError, invariant } from '../../contracts/src/errors.ts';
import type { Ratio, TimelineDraft, TimelineClip } from '../../contracts/src/index.ts';
export const idPattern = /^[a-zA-Z0-9_-]{1,128}$/;
export function resourceId(value: unknown): string {
  invariant(typeof value === 'string' && idPattern.test(value), 'INVALID_ID', '资源标识不合法');
  return value;
}
export function record(value: unknown): Record<string, unknown> {
  invariant(value !== null && typeof value === 'object' && !Array.isArray(value), 'INVALID_INPUT', '需要 JSON 对象');
  return value as Record<string, unknown>;
}
export function text(value: unknown, field: string, max = 10000, allowEmpty = false): string {
  invariant(typeof value === 'string' && value.length <= max && (allowEmpty || value.trim().length > 0), 'INVALID_INPUT', `${field}不合法`);
  return value.trim();
}
export function finiteNumber(value: unknown, field: string, min: number, max: number): number {
  invariant(typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max, 'INVALID_INPUT', `${field}必须介于 ${min} 和 ${max}`);
  return value;
}
export function integer(value: unknown, field: string, min: number, max: number): number {
  const n = finiteNumber(value, field, min, max);
  invariant(Number.isInteger(n), 'INVALID_INPUT', `${field}必须为整数`); return n;
}
export function projectInput(value: unknown): { name: string; brief: string; ratio: Ratio } {
  const body = record(value); const ratio = body.ratio ?? '16:9';
  invariant(['16:9', '9:16', '1:1'].includes(String(ratio)), 'INVALID_INPUT', '不支持的画幅');
  return { name: text(body.name, '项目名称', 100), brief: text(body.brief ?? '', '创作简报', 10000, true), ratio: ratio as Ratio };
}
export function timelineInput(value: unknown): TimelineDraft & { expectedVersion: number } {
  const b = record(value);
  const width = integer(b.width, '宽度', 64, 4096), height = integer(b.height, '高度', 64, 4096);
  invariant(width % 2 === 0 && height % 2 === 0, 'INVALID_INPUT', '输出宽高需为偶数');
  invariant(Array.isArray(b.clips) && b.clips.length > 0 && b.clips.length <= 100, 'INVALID_INPUT', '时间线需包含 1–100 个镜头');
  const clips: TimelineClip[] = b.clips.map((value): TimelineClip => {
    const c = record(value); invariant(c.fit === 'contain' || c.fit === 'cover', 'INVALID_INPUT', '无效的画面适配方式');
    invariant(typeof c.muteSource === 'boolean', 'INVALID_INPUT', '需要明确是否静音');
    return { artifactId: resourceId(c.artifactId), sourceInMs: finiteNumber(c.sourceInMs, '入点', 0, 86400000), durationMs: finiteNumber(c.durationMs, '时长', 100, 600000), fit: c.fit, muteSource: c.muteSource, ...(c.shotId ? { shotId: resourceId(c.shotId) } : {}) };
  });
  invariant(clips.reduce((sum, c) => sum + c.durationMs, 0) <= 1800000, 'INVALID_INPUT', '当前导出最长支持 30 分钟');
  invariant(Array.isArray(b.captions ?? []) && Array.isArray(b.audio ?? []), 'INVALID_INPUT', '字幕与音轨需为数组');
  if ((b.captions as unknown[] | undefined)?.length || (b.audio as unknown[] | undefined)?.length) throw new AppError('NOT_SUPPORTED', '本阶段暂未启用字幕或附加音轨');
  return { width, height, fps: integer(b.fps, '帧率', 1, 60), clips, captions: [], audio: [], expectedVersion: integer(b.expectedVersion ?? 0, '时间线版本', 0, Number.MAX_SAFE_INTEGER) };
}
