import { invariant } from '../../../../packages/contracts/src/errors.ts';
import type { TimelineDraft } from '../../../../packages/contracts/src/index.ts';
import { audioTrackDurationMs, integer, record, resourceId, timelineInput } from '../../../../packages/domain/src/validation.ts';
import { resolveAsset } from '../assets.ts';
import { TIMELINE_DEFAULTS, TIMELINE_POLICY } from '../config/timeline.ts';
import type { ApplicationContext } from './context.ts';

/** Build a new immutable timeline from explicitly selected, versioned candidates. */
export async function saveStoryboardTimeline({ store, board }: Pick<ApplicationContext, 'store' | 'board'>, id: string, value: unknown) {
  const projectId = resourceId(id), body = record(value);
  const snapshot = board.snapshot(projectId), project = store.getProject(projectId);
  const expectedVersion = integer(body.expectedVersion, '时间线版本', 0, Number.MAX_SAFE_INTEGER);
  const previous = store.getLatestTimeline(projectId);
  invariant((previous?.version ?? 0) === expectedVersion, 'REVISION_CONFLICT', '时间线已被更新，请重新读取后合并修改。', 409);
  const shots = snapshot.shots.filter(shot => !shot.archived).sort((a, b) => a.order - b.order);
  invariant(shots.length > 0, 'EMPTY_STORYBOARD', '请先创建镜头');
  const size = TIMELINE_DEFAULTS.sizes[project.ratio];
  const fps = previous?.fps ?? TIMELINE_DEFAULTS.fps, clips: TimelineDraft['clips'] = [], captions: TimelineDraft['captions'] = [];
  let frames = 0;
  for (const shot of shots) {
    invariant(shot.caption.length <= TIMELINE_POLICY.captionMaxCharacters, 'STORYBOARD_CAPTION_TOO_LONG', `镜头「${shot.title}」的字幕超过单条合成的 ${TIMELINE_POLICY.captionMaxCharacters} 字限制，请精简或分段处理；原文未截断。`, 409);
    invariant(shot.selectedArtifactId, 'MISSING_SELECTION', `镜头「${shot.title}」尚未选择素材`, 409);
    const { artifact } = await resolveAsset(store, shot.selectedArtifactId);
    invariant(artifact.kind !== 'audio' && artifact.projectId === projectId, 'INVALID_ASSET', '所选画面素材不合法');
    invariant(artifact.kind === 'image' || shot.durationMs <= artifact.media.durationMs + TIMELINE_POLICY.sourceDurationToleranceMs, 'INVALID_RANGE', `镜头「${shot.title}」时长超过素材，请先调整镜头时长`, 409);
    clips.push({ artifactId: artifact.id, sourceInMs: 0, durationMs: shot.durationMs, fit: 'contain', muteSource: false, shotId: shot.id });
    const startMs = Math.floor(frames / fps * 1000 + TIMELINE_POLICY.frameBoundaryEpsilonMs), count = Math.round(shot.durationMs * fps / 1000);
    invariant(count >= 1, 'INVALID_TIMELINE', `镜头「${shot.title}」在 ${fps} fps 下不足一帧，请延长时长。`);
    frames += count;
    if (shot.caption.trim()) {
      const endMs = Math.floor(frames / fps * 1000 + TIMELINE_POLICY.frameBoundaryEpsilonMs);
      invariant(endMs - startMs >= 1000 / fps - TIMELINE_POLICY.frameBoundaryEpsilonMs, 'INVALID_TIMELINE', `镜头「${shot.title}」的字幕显示不足一帧，请延长时长。`);
      captions.push({ startMs, endMs, text: shot.caption });
    }
  }
  const input = timelineInput({ width: previous?.width ?? size[0]!, height: previous?.height ?? size[1]!, fps, clips, captions, audio: previous?.audio ?? [], expectedVersion });
  for (const track of input.audio) {
    const { artifact } = await resolveAsset(store, track.artifactId);
    invariant(artifact.projectId === projectId && (artifact.kind === 'audio' || artifact.kind === 'video' && artifact.media.hasAudio), 'INVALID_AUDIO', '保留音轨必须使用当前项目中包含声音的素材');
    audioTrackDurationMs(track, artifact.media.durationMs, frames / fps * 1000);
  }
  invariant(board.snapshot(projectId).revision === snapshot.revision, 'REVISION_CONFLICT', '分镜在保存期间已改变，请重试', 409);
  const { expectedVersion: _expectedVersion, ...draft } = input;
  return store.saveTimeline(projectId, draft, expectedVersion);
}
