import type { Artifact, AudioTrack, TimelineDraft } from '../../contracts/src/index.ts';
import type { Shot } from '../../contracts/src/storyboard.ts';
import type { StudioOperation } from '../../contracts/src/studio.ts';
import { invariant } from '../../contracts/src/errors.ts';
import { audioTrackDurationMs, integer, timelineInput } from './validation.ts';
import { placeBatchSpeech } from './batch-speech.ts';

export type BatchAudioMode = 'shots' | 'sequence' | 'parallel';
export interface BatchAudioContext {
  projectId: string; mode: BatchAudioMode; startMs: number;
  shots: Shot[]; operations: StudioOperation[];
}
export interface BatchAudioRow { artifact: Artifact; operation?: StudioOperation; reason: string }

/** A saved speech operation, rather than its filename, identifies the target shot. */
export function batchAudioRows(timeline: TimelineDraft, artifacts: Artifact[], context: BatchAudioContext): BatchAudioRow[] {
  const operations = new Map(context.operations.filter(operation => operation.projectId === context.projectId && operation.kind === 'tts' && operation.speechBatch && operation.status === 'succeeded' && operation.artifactId).map(operation => [operation.artifactId!, operation]));
  return artifacts.filter(artifact => artifact.kind === 'audio' && artifact.projectId === context.projectId)
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }) || a.id.localeCompare(b.id))
    .map(artifact => {
      const operation = operations.get(artifact.id);
      let reason = '';
      if (timeline.audio.some(track => track.artifactId === artifact.id)) reason = '已在时间线中';
      else if (!artifact.media.hasAudio || !Number.isSafeInteger(artifact.media.durationMs) || artifact.media.durationMs <= 0) reason = '音频时长无效';
      else if (context.mode === 'shots') {
        const shot = context.shots.find(shot => shot.id === operation?.source.shotId && shot.projectId === context.projectId && !shot.archived);
        if (!operation) reason = '无分镜配音来源，可切换为依次接入或同时播放';
        else if (!shot || shot.revision !== operation.speechBatch!.shotRevision) reason = '来源分镜已改变，请先核对配音';
        else if (timeline.clips.filter(clip => clip.shotId === shot.id).length !== 1) reason = '对应镜头须在时间线中出现一次';
        else if (timeline.audio.some(track => artifacts.some(asset => asset.id === track.artifactId && asset.metadata.shotId === shot.id && asset.metadata.speechBatchId))) reason = '该镜已有配音，请先移除旧音轨后再更换';
      }
      return { artifact, operation, reason };
    });
}

/** Default to one newest eligible version per shot; every selected version remains visible. */
export function defaultBatchAudioIds(rows: BatchAudioRow[], mode: BatchAudioMode): string[] {
  const eligible = rows.filter(row => !row.reason);
  if (mode !== 'shots') return eligible.map(row => row.artifact.id);
  const chosen = new Map<string, BatchAudioRow>();
  for (const row of eligible) {
    const id = row.operation!.source.shotId!;
    const previous = chosen.get(id);
    if (!previous || row.artifact.createdAt > previous.artifact.createdAt) chosen.set(id, row);
  }
  return eligible.filter(row => chosen.get(row.operation!.source.shotId!) === row).map(row => row.artifact.id);
}

/** Preview and apply use the same pure plan. Any invalid selection rejects the whole change. */
export function planBatchAudio(timeline: TimelineDraft, selectedIds: string[], artifacts: Artifact[], context: BatchAudioContext): { draft: TimelineDraft; added: number; extendedShots: number; tracks: AudioTrack[] } {
  invariant(['shots', 'sequence', 'parallel'].includes(context.mode), 'INVALID_AUDIO_MODE', '音轨排列方式无效');
  const ids = [...new Set(selectedIds)];
  invariant(ids.length > 0, 'NO_AUDIO_SELECTED', '请选择要添加的音频');
  const rows = batchAudioRows(timeline, artifacts, context);
  const selected = ids.map(id => {
    const row = rows.find(row => row.artifact.id === id);
    invariant(row, 'INVALID_AUDIO', '所选音频已不存在或不属于当前项目');
    invariant(!row.reason, 'INVALID_AUDIO', `「${row.artifact.name}」：${row.reason}`);
    return row;
  });
  let draft = timeline, extendedShots = 0;
  if (context.mode === 'shots') {
    invariant(new Set(selected.map(row => row.operation!.source.shotId)).size === selected.length, 'DUPLICATE_SHOT_AUDIO', '同一镜头请选择一份配音');
    const batches = new Map<string, StudioOperation[]>();
    for (const row of selected) {
      const operation = row.operation!;
      batches.set(operation.speechBatch!.id, [...(batches.get(operation.speechBatch!.id) || []), operation]);
    }
    for (const operations of batches.values()) {
      const placed = placeBatchSpeech(draft, operations, artifacts, context.shots);
      draft = placed.draft; extendedShots += placed.extendedShots;
    }
  } else {
    let position = integer(context.startMs, '音轨起点', 0, 1_800_000);
    const tracks = selected.map(({ artifact }) => {
      const track = { artifactId: artifact.id, startMs: position, sourceInMs: 0, durationMs: artifact.media.durationMs, gainDb: 0, fadeInMs: 0, fadeOutMs: 0 };
      if (context.mode === 'sequence') position += track.durationMs;
      return track;
    });
    const totalMs = timeline.clips.reduce((frames, clip) => frames + Math.round(clip.durationMs * timeline.fps / 1000), 0) / timeline.fps * 1000;
    const overflow = tracks.find(track => track.startMs + track.durationMs > totalMs + 0.001);
    invariant(!overflow, 'AUDIO_EXCEEDS_TIMELINE', '所选音频超出成片时长，请减少选择、调整起点或先延长时间线；未截断音频');
    const { expectedVersion: _, ...validated } = timelineInput({ ...timeline, audio: [...timeline.audio, ...tracks], expectedVersion: 0 });
    for (const track of validated.audio) {
      const artifact = artifacts.find(artifact => artifact.id === track.artifactId && artifact.projectId === context.projectId);
      invariant(artifact, 'INVALID_AUDIO', '原音轨素材缺失，请先恢复素材');
      audioTrackDurationMs(track, artifact.media.durationMs, totalMs);
    }
    draft = validated;
  }
  return { draft, added: selected.length, extendedShots, tracks: ids.map(id => draft.audio.find(track => track.artifactId === id)!) };
}
