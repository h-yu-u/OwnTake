import type { Artifact, TimelineDraft } from '../../contracts/src/index.ts';
import type { Shot } from '../../contracts/src/storyboard.ts';
import type { StudioOperation } from '../../contracts/src/studio.ts';
import { invariant } from '../../contracts/src/errors.ts';
import { audioTrackDurationMs, timelineInput } from './validation.ts';

/** Align complete speech to shot boundaries without cutting spoken audio. No input is mutated. */
export function placeBatchSpeech(timeline: TimelineDraft, operations: StudioOperation[], artifacts: Artifact[], shots: Shot[]): { draft: TimelineDraft; added: number; extendedShots: number } {
  const byId = new Map(artifacts.map(artifact => [artifact.id, artifact]));
  const complete = operations.filter(operation => operation.kind === 'tts' && operation.speechBatch && operation.status === 'succeeded' && operation.artifactId);
  invariant(complete.length > 0, 'NO_SPEECH_RESULTS', '本批次还没有可加入的配音');
  invariant(new Set(complete.map(operation => operation.speechBatch!.id)).size === 1, 'INVALID_SPEECH_BATCH', '一次只能加入一个配音批次');
  const additions = complete.filter(operation => !timeline.audio.some(track => track.artifactId === operation.artifactId));
  if (!additions.length) return { draft: timeline, added: 0, extendedShots: 0 };
  const placements = new Map<number, { operation: StudioOperation; artifact: Artifact }>();
  for (const operation of additions) {
    const shot = shots.find(shot => shot.id === operation.source.shotId && !shot.archived);
    invariant(shot && shot.revision === operation.speechBatch!.shotRevision, 'REVISION_CONFLICT', `镜头「${operation.speechBatch!.shotTitle}」已改变，请核对配音与当前台词`);
    const indices = timeline.clips.flatMap((clip, index) => clip.shotId === shot.id ? [index] : []);
    invariant(indices.length === 1, 'SPEECH_SHOT_MISMATCH', `镜头「${shot.title}」在时间线中需要恰好出现一次，请先从分镜保存时间线`);
    invariant(!placements.has(indices[0]!), 'INVALID_SPEECH_BATCH', '同一镜头不能重复加入配音');
    invariant(!timeline.audio.some(track => byId.get(track.artifactId)?.metadata.shotId === shot.id && byId.get(track.artifactId)?.metadata.speechBatchId), 'SPEECH_ALREADY_PLACED', `镜头「${shot.title}」已有分镜配音，请先移除旧音轨后再更换`);
    const artifact = byId.get(operation.artifactId!);
    invariant(artifact && artifact.projectId === operation.projectId && artifact.kind === 'audio' && artifact.media.hasAudio && Number.isFinite(artifact.media.durationMs) && artifact.media.durationMs > 0, 'INVALID_AUDIO', '配音素材尚未载入或无效，请刷新后重试');
    placements.set(indices[0]!, { operation, artifact });
  }
  let extendedShots = 0;
  const oldFrames = [0], newFrames = [0];
  const clips = timeline.clips.map((clip, index) => {
    const frames = Math.round(clip.durationMs * timeline.fps / 1000);
    const speech = placements.get(index);
    let durationFrames = frames;
    if (speech) {
      const neededFrames = Math.ceil(speech.artifact.media.durationMs * timeline.fps / 1000);
      if (neededFrames > frames) {
        invariant(byId.get(clip.artifactId)?.kind === 'image', 'SPEECH_EXCEEDS_VIDEO', `镜头「${speech.operation.speechBatch!.shotTitle}」配音超过视频时长，请调整台词、语速或视频剪辑`);
        durationFrames = neededFrames; extendedShots++;
      }
    }
    oldFrames.push(oldFrames[index]! + frames);
    newFrames.push(newFrames[index]! + durationFrames);
    return { ...clip, durationMs: durationFrames === frames ? clip.durationMs : durationFrames / timeline.fps * 1000 };
  });
  // Boundary rounding is shared with storyboard captions. Interior offsets remain unchanged.
  const oldMs = oldFrames.map(frame => Math.floor(frame / timeline.fps * 1000 + 0.001));
  const newMs = newFrames.map(frame => Math.floor(frame / timeline.fps * 1000 + 0.001));
  function shift(time: number): number {
    let index = oldMs.findIndex(boundary => boundary > time) - 1;
    if (index === -2) index = oldMs.length - 1;
    if (index < 0) index = 0;
    return time + newMs[index]! - oldMs[index]!;
  }
  const audio = [...timeline.audio.map(track => ({ ...track, startMs: shift(track.startMs) })), ...[...placements].map(([index, { artifact }]) => ({ artifactId: artifact.id, startMs: newMs[index]!, sourceInMs: 0, durationMs: Math.ceil(artifact.media.durationMs), gainDb: 0, fadeInMs: 0, fadeOutMs: 0 }))];
  const draft = timelineInput({ ...timeline, clips, captions: timeline.captions.map(caption => ({ ...caption, startMs: shift(caption.startMs), endMs: shift(caption.endMs) })), audio, expectedVersion: 0 });
  const { expectedVersion: _, ...result } = draft;
  const totalMs = newFrames.at(-1)! / timeline.fps * 1000;
  for (const track of result.audio) {
    const artifact = byId.get(track.artifactId);
    invariant(artifact, 'INVALID_AUDIO', '原音轨素材缺失，请先恢复素材');
    audioTrackDurationMs(track, artifact.media.durationMs, totalMs);
  }
  return { draft: result, added: additions.length, extendedShots };
}
