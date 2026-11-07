import { Type } from 'typebox';
import { ExistingRevision, ResourceId, Revision } from './common.ts';
import { MAX_DRAFT_OPERATIONS } from '../../../../../packages/domain/src/storyboard.ts';

export const ShotFields = Type.Object({
  title: Type.String({ maxLength: 200 }),
  purpose: Type.String({ maxLength: 4000 }),
  description: Type.String({ maxLength: 12_000 }),
  action: Type.String({ maxLength: 8000 }),
  durationMs: Type.Integer({ minimum: 100, maximum: 600_000 }),
  caption: Type.String({ maxLength: 10_000 }),
  mode: Type.Union([Type.Literal('import'), Type.Literal('generate_image'), Type.Literal('generate_video')]),
  referenceArtifactIds: Type.Array(ResourceId, { maxItems: 20, uniqueItems: true }),
}, { additionalProperties: false });

export const ShotCreate = Type.Object({ fields: ShotFields, expectedBoardRevision: Revision }, { additionalProperties: true });
export const ShotUpdate = Type.Object({ fields: ShotFields, expectedShotRevision: ExistingRevision }, { additionalProperties: true });
export const ShotArchive = Type.Object({ expectedShotRevision: ExistingRevision }, { additionalProperties: true });
export const ShotReorder = Type.Object({ shotIds: Type.Array(ResourceId), expectedBoardRevision: Revision }, { additionalProperties: true });
export const CandidateCreate = Type.Object({ artifactId: ResourceId }, { additionalProperties: true });
export const CandidateSelect = Type.Object({ candidateId: ResourceId, expectedShotRevision: ExistingRevision }, { additionalProperties: true });

const DraftOperation = Type.Union([
  Type.Object({ id: ResourceId, kind: Type.Literal('add'), fields: ShotFields }, { additionalProperties: false }),
  Type.Object({ id: ResourceId, kind: Type.Literal('update'), shotId: ResourceId, fields: ShotFields }, { additionalProperties: false }),
  Type.Object({ id: ResourceId, kind: Type.Literal('delete'), shotId: ResourceId }, { additionalProperties: false }),
]);

export const DraftCreate = Type.Object({
  operations: Type.Array(DraftOperation, { minItems: 1, maxItems: MAX_DRAFT_OPERATIONS }), baseRevision: Revision,
}, { additionalProperties: true });
export const DraftApply = Type.Object({ acceptedOperationIds: Type.Array(ResourceId), expectedBoardRevision: Revision }, { additionalProperties: true });
export const StoryboardTimeline = Type.Object({ expectedVersion: Revision }, { additionalProperties: true });
