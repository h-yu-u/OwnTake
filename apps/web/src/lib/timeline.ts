import type { Artifact, Ratio, Timeline, TimelineClip, TimelineDraft } from '../types.ts';

export function emptyTimeline(ratio: Ratio): TimelineDraft {
  const [width, height] = ratio === '9:16' ? [720, 1280] : ratio === '1:1' ? [720, 720] : [1280, 720];
  return { width, height, fps: 24, clips: [], captions: [], audio: [] };
}

export function timelineDraft(timeline: Timeline | TimelineDraft): TimelineDraft {
  return { width: timeline.width, height: timeline.height, fps: timeline.fps,
    clips: timeline.clips.map(clip => ({ ...clip })),
    captions: timeline.captions.map(caption => ({ ...caption })), audio: timeline.audio.map(track => ({ ...track })) };
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
