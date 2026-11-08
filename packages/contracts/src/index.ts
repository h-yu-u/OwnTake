/** Up to 100 per-shot speech segments plus 16 music/effect tracks. */
export const MAX_AUDIO_TRACKS = 116;
export type Ratio = '16:9' | '9:16' | '1:1';
export type MediaKind = 'video' | 'image' | 'audio';
export interface Project {
  id: string; name: string; brief: string; ratio: Ratio;
  revision: number; createdAt: string; updatedAt: string;
}
export interface MediaInfo {
  kind: MediaKind; durationMs: number; width?: number; height?: number;
  fps?: number; hasAudio: boolean; format: string; codec?: string;
}
export interface Artifact {
  id: string; projectId: string; name: string; kind: MediaKind;
  relativePath: string; sha256: string; sizeBytes: number; media: MediaInfo;
  source: 'import' | 'generated' | 'render' | 'composite'; createdAt: string;
  metadata: Record<string, unknown>;
}
export interface TimelineClip {
  artifactId: string; sourceInMs: number; durationMs: number;
  fit: 'contain' | 'cover'; muteSource: boolean;
  shotId?: string;
}
export interface CaptionStyle {
  fontFamily?: string; fontSize?: number; color?: string;
  position?: 'top' | 'center' | 'bottom';
}
export interface Caption {
  startMs: number; endMs: number; text: string; style?: CaptionStyle;
}
export interface AudioTrack {
  artifactId: string; startMs: number; sourceInMs: number; durationMs?: number;
  gainDb: number; fadeInMs?: number; fadeOutMs?: number;
}
export interface TimelineDraft {
  width: number; height: number; fps: number; clips: TimelineClip[];
  captions: Caption[]; audio: AudioTrack[];
}
export interface Timeline extends TimelineDraft {
  id: string; projectId: string; version: number; createdAt: string;
}
export type JobStatus = 'queued' | 'running' | 'waiting_external' | 'blocked' | 'succeeded' | 'failed' | 'cancel_requested' | 'cancelled';
export interface Job {
  id: string; projectId: string; type: string; status: JobStatus;
  payload: Record<string, unknown>; result: Record<string, unknown> | null;
  progress: number; error: { code: string; message: string } | null;
  dedupeKey: string; createdAt: string; updatedAt: string;
}
export interface AppEvent {
  seq: number; projectId: string; type: string; data: Record<string, unknown>; createdAt: string;
}
export interface ProjectSnapshot {
  project: Project; artifacts: Artifact[]; timeline: Timeline | null; jobs: Job[]; eventCursor: number;
}
export interface ToolHealth { available: boolean; path: string; version?: string; error?: string; capabilities?: { subtitles: boolean } }
export interface Health {
  status: 'ok' | 'degraded'; version: string; schemaVersion: number;
  ffmpeg: ToolHealth; ffprobe: ToolHealth; dataDir: string; projectsDir: string;
}
export interface AppSettings { ffmpegPath: string; ffprobePath: string; subtitleFontPath?: string }
export interface ApiError { error: { code: string; message: string; details?: unknown } }
