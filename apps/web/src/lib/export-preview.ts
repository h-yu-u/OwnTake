import type { Artifact, Timeline } from '../types.ts';

export type ExportPreviewStatus = 'missing' | 'draft_changed' | 'outdated' | 'current' | 'unverified';

/** A playable file is not evidence that it contains the current timeline's changes. */
export function exportPreviewStatus(output: Pick<Artifact, 'metadata'> | undefined, timeline: Pick<Timeline, 'id'> | null, dirty: boolean): ExportPreviewStatus {
  if (!output) return 'missing';
  if (dirty) return 'draft_changed';
  const source = output.metadata.timelineId;
  if (!timeline || typeof source !== 'string') return 'unverified';
  return source === timeline.id ? 'current' : 'outdated';
}
