import type { Artifact, Ratio, Timeline, TimelineClip, TimelineDraft } from '../types.ts';

export function emptyTimeline(ratio: Ratio): TimelineDraft {
  const [width, height] = ratio === '9:16' ? [720, 1280] : ratio === '1:1' ? [720, 720] : [1280, 720];
  return { width, height, fps: 24, clips: [], captions: [], audio: [] };
}

export function timelineDraft(timeline: Timeline | TimelineDraft): TimelineDraft {
  return { width: timeline.width, height: timeline.height, fps: timeline.fps,
    clips: timeline.clips.map(clip => ({ ...clip })),
    captions: timeline.captions.map(caption => ({ ...caption, ...(caption.style ? { style: { ...caption.style } } : {}) })), audio: timeline.audio.map(track => ({ ...track })) };
}

export function totalDuration(draft: TimelineDraft): number { return draft.clips.reduce((sum, clip) => sum + clip.durationMs, 0); }
export function createClip(artifact: Artifact): TimelineClip {
  return { artifactId: artifact.id, sourceInMs: 0, durationMs: artifact.kind === 'image' ? 3000 : Math.max(1, artifact.media.durationMs), fit: 'contain', muteSource: false };
}
export function moveClip(draft: TimelineDraft, index: number, direction: -1 | 1): TimelineDraft {
  const target = index + direction;
  if (index < 0 || target < 0 || target >= draft.clips.length) return draft;
  const clips = draft.clips.map(clip => ({ ...clip }));
  [clips[index], clips[target]] = [clips[target]!, clips[index]!];
  return { ...draft, clips };
}

export function timelineProblems(draft: TimelineDraft, artifacts: Artifact[]): string[] {
  const issues: string[] = [];
  const byId = new Map(artifacts.map(artifact => [artifact.id, artifact]));
  if (!draft.clips.length) issues.push('时间线还没有画面片段。');
  if (![draft.width, draft.height].every(value => Number.isInteger(value) && value >= 64 && value <= 4096 && value % 2 === 0)) issues.push('输出宽高须为 64–4096 之间的偶数。');
  if (!Number.isInteger(draft.fps) || draft.fps < 1 || draft.fps > 60) issues.push('帧率须为 1–60 之间的整数。');
  for (const [index, clip] of draft.clips.entries()) {
    const asset = byId.get(clip.artifactId);
    if (!asset) { issues.push(`片段 ${index + 1} 的素材缺失。`); continue; }
    if (asset.kind === 'audio') issues.push(`片段 ${index + 1} 仅有音频，请选择图片或视频。`);
    if (!Number.isFinite(clip.durationMs) || clip.durationMs < 1000 / draft.fps) issues.push(`片段 ${index + 1} 的时长不足一帧。`);
    if (!Number.isFinite(clip.sourceInMs) || clip.sourceInMs < 0) issues.push(`片段 ${index + 1} 的入点无效。`);
    if (asset.kind === 'video' && clip.sourceInMs + clip.durationMs > asset.media.durationMs + 1) issues.push(`片段 ${index + 1} 的使用区间超过源视频。`);
  }
  const duration = totalDuration(draft);
  if (draft.captions.length > 1000) issues.push('字幕最多支持 1000 条。');
  for (const [index, caption] of draft.captions.entries()) {
    if (!caption.text.trim() || caption.text.length > 2000) issues.push(`字幕 ${index + 1} 需要 1–2000 字的内容。`);
    if (![caption.startMs, caption.endMs].every(Number.isInteger) || caption.startMs < 0 || caption.endMs > duration || caption.endMs - caption.startMs < 1000 / draft.fps) issues.push(`字幕 ${index + 1} 的时段须在成片内，且至少持续一帧。`);
    if (caption.style?.fontSize !== undefined && (!Number.isFinite(caption.style.fontSize) || caption.style.fontSize < 8 || caption.style.fontSize > 200)) issues.push(`字幕 ${index + 1} 的字号须在 8–200 像素之间。`);
    if (caption.style?.color && !/^#[0-9a-fA-F]{6}$/.test(caption.style.color)) issues.push(`字幕 ${index + 1} 的颜色须使用 #RRGGBB 格式。`);
    if (caption.style?.fontFamily && /[,{}\x00-\x1f\x7f]/.test(caption.style.fontFamily)) issues.push(`字幕 ${index + 1} 的字体族名称包含不支持的字符。`);
  }
  if (draft.audio.length > 16) issues.push('独立音轨最多支持 16 条。');
  for (const [index, track] of draft.audio.entries()) {
    const artifact = byId.get(track.artifactId);
    if (!artifact || artifact.kind !== 'audio') { issues.push(`音轨 ${index + 1} 需要可用的音频素材。`); continue; }
    const available = Math.min(artifact.media.durationMs - track.sourceInMs, duration - track.startMs);
    const length = track.durationMs ?? available;
    if (![track.startMs, track.sourceInMs, length].every(Number.isInteger) || track.startMs < 0 || track.sourceInMs < 0 || length < 1 || length > available) issues.push(`音轨 ${index + 1} 的使用区间超过音频或成片范围。`);
    if (!Number.isFinite(track.gainDb) || track.gainDb < -96 || track.gainDb > 24) issues.push(`音轨 ${index + 1} 的增益须在 -96–24 dB 之间。`);
    const fades = [track.fadeInMs ?? 0, track.fadeOutMs ?? 0];
    if (!fades.every(value => Number.isInteger(value) && value >= 0) || fades[0]! + fades[1]! > length) issues.push(`音轨 ${index + 1} 的淡入与淡出总时长不能超过音轨使用时长。`);
  }
  return issues;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const seconds = ms / 1000;
  return seconds < 60 ? `${Number(seconds.toFixed(2))} 秒` : `${Math.floor(seconds / 60)} 分 ${Number((seconds % 60).toFixed(1))} 秒`;
}
export function formatBytes(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
export function formatDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}
