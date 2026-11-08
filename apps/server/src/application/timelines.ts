import { invariant } from '../../../../packages/contracts/src/errors.ts';
import { resourceId, timelineInput } from '../../../../packages/domain/src/validation.ts';
import { resolveAsset } from '../assets.ts';
import { TIMELINE_POLICY } from '../config/timeline.ts';
import type { ApplicationContext } from './context.ts';

export async function saveTimeline({ store }: Pick<ApplicationContext, 'store'>, id: string, value: unknown) {
  const projectId = resourceId(id), input = timelineInput(value);
  for (const clip of input.clips) {
    const { artifact } = await resolveAsset(store, clip.artifactId);
    invariant(artifact.projectId === projectId && artifact.kind !== 'audio', 'INVALID_ASSET', '镜头必须使用当前项目的画面素材');
    invariant(artifact.kind === 'image' ? clip.sourceInMs === 0 : clip.sourceInMs + clip.durationMs <= artifact.media.durationMs + TIMELINE_POLICY.sourceDurationToleranceMs, 'INVALID_RANGE', `素材「${artifact.name}」的使用区间超出源时长`);
  }
  for (const track of input.audio) {
    const { artifact } = await resolveAsset(store, track.artifactId);
    invariant(artifact.projectId === projectId && (artifact.kind === 'audio' || artifact.kind === 'video' && artifact.media.hasAudio), 'INVALID_AUDIO', '音轨必须使用当前项目中包含声音的素材');
  }
  const { expectedVersion, ...draft } = input;
  return store.saveTimeline(projectId, draft, expectedVersion);
}
