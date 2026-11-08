import { MAX_AUDIO_TRACKS } from '../../contracts/src/index.ts';
import { invariant } from '../../contracts/src/errors.ts';
import type { AudioTrack, Caption, CaptionStyle, Ratio, TimelineDraft, TimelineClip } from '../../contracts/src/index.ts';
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
  const fps = integer(b.fps, '帧率', 1, 60);
  const totalMs = clips.reduce((sum, clip) => sum + Math.round(clip.durationMs * fps / 1000), 0) / fps * 1000;
  const captions = b.captions ?? [], audio = b.audio ?? [];
  invariant(Array.isArray(captions) && captions.length <= 1000 && Array.isArray(audio) && audio.length <= MAX_AUDIO_TRACKS, 'INVALID_TIMELINE', `字幕最多 1000 条，附加音轨最多 ${MAX_AUDIO_TRACKS} 条`);
  return { width, height, fps, clips, captions: captions.map(c => captionInput(c, totalMs, fps)), audio: audio.map(a => audioTrackInput(a, totalMs)), expectedVersion: integer(b.expectedVersion ?? 0, '时间线版本', 0, Number.MAX_SAFE_INTEGER) };
}

function overlayObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const object = record(value), prototype = Object.getPrototypeOf(object);
  invariant((prototype === Object.prototype || prototype === null) && Reflect.ownKeys(object).every(key => typeof key === 'string' && keys.includes(key)), 'INVALID_TIMELINE', '字幕或音轨包含未允许的字段');
  return object;
}
export const subtitleFamilyPattern = /^[\p{L}\p{N} ._-]{1,80}$/u;
export function captionInput(value: unknown, totalMs: number, fps: number): Caption {
  const c = overlayObject(value, ['startMs', 'endMs', 'text', 'style']);
  const startMs = integer(c.startMs, '字幕开始时间', 0, Math.floor(totalMs));
  const endMs = integer(c.endMs, '字幕结束时间', 1, Math.floor(totalMs + 0.001));
  invariant(endMs - startMs >= 1000 / fps - 0.001, 'INVALID_TIMELINE', '字幕必须在片长内，且至少显示一帧');
  invariant(typeof c.text === 'string' && c.text.trim().length > 0 && c.text.length <= 2000 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(c.text), 'INVALID_TIMELINE', '字幕不能为空、不能包含控制字符，且不能超过 2000 字符');
  let style: CaptionStyle | undefined;
  if (c.style !== undefined) {
    const s = overlayObject(c.style, ['fontFamily', 'fontSize', 'color', 'position']); style = {};
    if (s.fontFamily !== undefined) { invariant(typeof s.fontFamily === 'string' && subtitleFamilyPattern.test(s.fontFamily) && s.fontFamily.trim().length > 0, 'INVALID_TIMELINE', '字体名称只能包含文字、数字、空格、点、连字符或下划线'); style.fontFamily = s.fontFamily.trim(); }
    if (s.fontSize !== undefined) style.fontSize = integer(s.fontSize, '字幕字号', 8, 200);
    if (s.color !== undefined) { invariant(typeof s.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(s.color), 'INVALID_TIMELINE', '字幕颜色必须使用 #RRGGBB'); style.color = s.color.toUpperCase(); }
    if (s.position !== undefined) { invariant(s.position === 'top' || s.position === 'center' || s.position === 'bottom', 'INVALID_TIMELINE', '字幕位置无效'); style.position = s.position; }
  }
  return { startMs, endMs, text: c.text.replace(/\r\n?/g, '\n'), ...(style ? { style } : {}) };
}
export function audioTrackInput(value: unknown, totalMs: number): AudioTrack {
  const a = overlayObject(value, ['artifactId', 'startMs', 'sourceInMs', 'durationMs', 'gainDb', 'fadeInMs', 'fadeOutMs']);
  const result: AudioTrack = { artifactId: resourceId(a.artifactId), startMs: integer(a.startMs, '音轨开始时间', 0, Math.ceil(totalMs) - 1), sourceInMs: integer(a.sourceInMs, '音轨素材入点', 0, 86_400_000), gainDb: finiteNumber(a.gainDb, '音轨音量', -96, 24) };
  if (a.durationMs !== undefined) result.durationMs = integer(a.durationMs, '音轨时长', 1, 7_200_000);
  if (a.fadeInMs !== undefined) result.fadeInMs = integer(a.fadeInMs, '音轨淡入时长', 0, 7_200_000);
  if (a.fadeOutMs !== undefined) result.fadeOutMs = integer(a.fadeOutMs, '音轨淡出时长', 0, 7_200_000);
  const availableMs = result.durationMs ?? totalMs - result.startMs;
  invariant(result.startMs + availableMs <= totalMs + 0.001, 'INVALID_TIMELINE', '音轨超出片长，请明确调整入点或时长');
  invariant((result.fadeInMs ?? 0) + (result.fadeOutMs ?? 0) <= availableMs, 'INVALID_TIMELINE', '音轨淡入与淡出总时长不能超过音轨时长');
  return result;
}
/** An omitted duration intentionally fills the shorter of the source/timeline remainder. */
export function audioTrackDurationMs(track: AudioTrack, sourceDurationMs: number, totalMs: number): number {
  invariant(track.sourceInMs < sourceDurationMs, 'INVALID_TIMELINE', '音轨入点超出源素材时长');
  const durationMs = track.durationMs ?? Math.min(sourceDurationMs - track.sourceInMs, totalMs - track.startMs);
  invariant(durationMs > 0 && track.sourceInMs + durationMs <= sourceDurationMs + 1 && track.startMs + durationMs <= totalMs + 0.001, 'INVALID_TIMELINE', '音轨区间超出源素材或时间线时长');
  invariant((track.fadeInMs ?? 0) + (track.fadeOutMs ?? 0) <= durationMs, 'INVALID_TIMELINE', '音轨淡入与淡出总时长不能超过实际素材时长');
  return durationMs;
}
export function validateTimelineOverlays(timeline: TimelineDraft): void {
  const totalMs = timeline.clips.reduce((sum, clip) => sum + Math.round(clip.durationMs * timeline.fps / 1000), 0) / timeline.fps * 1000;
  invariant(Array.isArray(timeline.captions) && timeline.captions.length <= 1000 && Array.isArray(timeline.audio) && timeline.audio.length <= MAX_AUDIO_TRACKS, 'INVALID_TIMELINE', `字幕最多 1000 条，附加音轨最多 ${MAX_AUDIO_TRACKS} 条`);
  for (const caption of timeline.captions) captionInput(caption, totalMs, timeline.fps);
  for (const track of timeline.audio) audioTrackInput(track, totalMs);
}
