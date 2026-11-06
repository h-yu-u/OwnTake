import { createHash } from 'node:crypto';
import { AppError, invariant } from '../../contracts/src/errors.ts';
import type { Artifact, MediaInfo, Ratio, TimelineDraft } from '../../contracts/src/index.ts';

export function validateId(value: unknown): asserts value is string {
  invariant(typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value), 'INVALID_ID', '无效的资源标识。');
}

export function stringValue(value: unknown, field: string, maxLength: number, allowEmpty = false): string {
  invariant(typeof value === 'string', 'INVALID_INPUT', `${field}必须是文本。`);
  invariant(value.length <= maxLength && !value.includes('\0'), 'INVALID_INPUT', `${field}过长或包含无效字符。`);
  const result = value.trim();
  invariant(allowEmpty || result.length > 0, 'INVALID_INPUT', `${field}不能为空。`);
  return result;
}

export function ratioValue(value: unknown): Ratio {
  invariant(value === '16:9' || value === '9:16' || value === '1:1', 'INVALID_INPUT', '不支持的画幅。');
  return value;
}

export function finiteNumber(value: unknown, name: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): asserts value is number {
  invariant(typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum, 'INVALID_INPUT', `${name}超出允许范围。`);
}

export function integer(value: unknown, name: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): asserts value is number {
  finiteNumber(value, name, minimum, maximum);
  invariant(Number.isSafeInteger(value), 'INVALID_INPUT', `${name}必须是整数。`);
}

function canonical(value: unknown, depth = 0, ancestors = new Set<object>()): unknown {
  invariant(depth <= 32, 'INVALID_INPUT', 'JSON 数据嵌套过深。');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    invariant(Number.isFinite(value), 'INVALID_INPUT', 'JSON 数值必须有限。');
    return value;
  }
  invariant(typeof value === 'object', 'INVALID_INPUT', '数据包含无法保存为 JSON 的值。');
  invariant(!ancestors.has(value), 'INVALID_INPUT', 'JSON 数据不能循环引用。');
  const prototype = Object.getPrototypeOf(value);
  invariant(Array.isArray(value) || prototype === Object.prototype || prototype === null, 'INVALID_INPUT', 'JSON 只能包含普通对象。');
  ancestors.add(value);
  const result = Array.isArray(value)
    ? value.map(item => canonical(item, depth + 1, ancestors))
    : Object.fromEntries(Object.keys(value).filter(key => (value as Record<string, unknown>)[key] !== undefined).sort().map(key => [key, canonical((value as Record<string, unknown>)[key], depth + 1, ancestors)]));
  ancestors.delete(value);
  return result;
}

export function json(value: unknown): string {
  const result = JSON.stringify(canonical(value));
  invariant(Buffer.byteLength(result) <= 1_048_576, 'INVALID_INPUT', '单条元数据不能超过 1 MiB。');
  return result;
}

export function objectJson(value: unknown): string {
  invariant(value !== null && typeof value === 'object' && !Array.isArray(value), 'INVALID_INPUT', '元数据必须是对象。');
  return json(value);
}

export function requestHash(value: unknown): string {
  return createHash('sha256').update(json(value)).digest('hex');
}

export function parseJson<T>(value: unknown): T {
  try {
    if (typeof value !== 'string') throw new Error('not text');
    return JSON.parse(value) as T;
  } catch {
    throw new AppError('DATA_CORRUPT', '数据库中的 JSON 数据无法读取，请从备份恢复。', 500);
  }
}

export function validateMedia(media: MediaInfo): void {
  invariant(media && ['image', 'video', 'audio'].includes(media.kind), 'INVALID_INPUT', '无效的媒体信息。');
  finiteNumber(media.durationMs, '媒体时长', 0, 86_400_000);
  invariant(typeof media.hasAudio === 'boolean', 'INVALID_INPUT', '媒体音轨标记无效。');
  stringValue(media.format, '媒体格式', 200);
  if (media.kind !== 'audio' || media.width !== undefined) integer(media.width, '媒体宽度', 1, 32768);
  if (media.kind !== 'audio' || media.height !== undefined) integer(media.height, '媒体高度', 1, 32768);
  if (media.fps !== undefined) finiteNumber(media.fps, '帧率', 0, 1000);
  if (media.codec !== undefined) stringValue(media.codec, '编码', 100);
}

export function validateTimeline(draft: TimelineDraft, resolve: (id: string) => Artifact): void {
  invariant(draft && typeof draft === 'object', 'INVALID_INPUT', '时间线不能为空。');
  integer(draft.width, '导出宽度', 2, 8192); integer(draft.height, '导出高度', 2, 8192);
  invariant(draft.width % 2 === 0 && draft.height % 2 === 0, 'INVALID_INPUT', '导出尺寸必须为偶数。');
  finiteNumber(draft.fps, '导出帧率', 1, 120);
  invariant(Array.isArray(draft.clips) && draft.clips.length <= 500, 'INVALID_INPUT', '时间线片段无效或过多。');
  invariant(Array.isArray(draft.captions) && draft.captions.length <= 10000, 'INVALID_INPUT', '字幕数据无效或过多。');
  invariant(Array.isArray(draft.audio) && draft.audio.length <= 100, 'INVALID_INPUT', '音轨数据无效或过多。');
  for (const clip of draft.clips) {
    invariant(clip && typeof clip === 'object', 'INVALID_INPUT', '时间线片段无效。');
    validateId(clip.artifactId);
    const asset = resolve(clip.artifactId);
    invariant(asset.kind !== 'audio', 'INVALID_INPUT', '画面片段不能引用纯音频。');
    finiteNumber(clip.sourceInMs, '素材入点', 0); finiteNumber(clip.durationMs, '片段时长', 1, 3_600_000);
    invariant(clip.fit === 'contain' || clip.fit === 'cover', 'INVALID_INPUT', '无效的画幅适配方式。');
    invariant(typeof clip.muteSource === 'boolean', 'INVALID_INPUT', '静音设置无效。');
    if (clip.shotId !== undefined) validateId(clip.shotId);
    if (asset.kind === 'video') invariant(clip.sourceInMs + clip.durationMs <= asset.media.durationMs + 1000 / draft.fps, 'INVALID_RANGE', '片段超出源视频时长。');
  }
  for (const caption of draft.captions) {
    invariant(caption && typeof caption === 'object', 'INVALID_INPUT', '字幕数据无效。');
    finiteNumber(caption.startMs, '字幕开始时间'); finiteNumber(caption.endMs, '字幕结束时间', caption.startMs + 1);
    stringValue(caption.text, '字幕', 10000);
  }
  for (const track of draft.audio) {
    invariant(track && typeof track === 'object', 'INVALID_INPUT', '音轨数据无效。');
    validateId(track.artifactId);
    const asset = resolve(track.artifactId);
    invariant(asset.kind === 'audio' || asset.media.hasAudio, 'INVALID_INPUT', '音轨素材没有音频流。');
    finiteNumber(track.startMs, '音轨开始时间'); finiteNumber(track.sourceInMs, '音轨入点');
    finiteNumber(track.gainDb, '音轨音量', -96, 24);
    if (track.durationMs !== undefined) finiteNumber(track.durationMs, '音轨时长', 1, 3_600_000);
    if (track.fadeInMs !== undefined) finiteNumber(track.fadeInMs, '音轨淡入时间');
    if (track.fadeOutMs !== undefined) finiteNumber(track.fadeOutMs, '音轨淡出时间');
    invariant(track.sourceInMs < asset.media.durationMs, 'INVALID_RANGE', '音轨入点超出源素材时长。');
    if (track.durationMs !== undefined) invariant(track.sourceInMs + track.durationMs <= asset.media.durationMs + 1000 / draft.fps, 'INVALID_RANGE', '音轨区间超出源素材时长。');
  }
  json(draft);
}
