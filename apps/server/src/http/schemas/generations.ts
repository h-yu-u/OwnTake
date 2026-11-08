import { Type } from 'typebox';
import { ExistingRevision, Ratio, Reservation, ResourceId } from './common.ts';
import { ProviderInputMode } from './providers.ts';

export const GenerationPlan = Type.Object({
  kind: Type.Union([Type.Literal('image'), Type.Literal('video')]),
  inputMode: ProviderInputMode,
  prompt: Type.String({ maxLength: 20_000 }),
  ratio: Ratio,
  durationSec: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 600 })),
  imageQuality: Type.Optional(Type.Union([Type.Literal('low'), Type.Literal('medium'), Type.Literal('high')])),
  referenceArtifactIds: Type.Array(ResourceId, { maxItems: 16, uniqueItems: true }),
}, { additionalProperties: false });

export const GenerationValidation = Type.Object({ providerId: ResourceId, plan: GenerationPlan }, { additionalProperties: true });
export const GenerationCreate = Type.Object({
  ...GenerationValidation.properties,
  clientRequestId: ResourceId,
  expectedShotRevision: ExistingRevision,
  expectedProviderUpdatedAt: Type.String({ maxLength: 100 }),
  reservation: Type.Optional(Reservation),
}, { additionalProperties: true });

export const GenerationReconcile = Type.Object({ remoteTaskId: ResourceId, note: Type.String({ maxLength: 2000 }) }, { additionalProperties: true });
export const GenerationPolling = Type.Object({ paused: Type.Boolean() }, { additionalProperties: true });

export const ReviewInput = Type.Object({
  candidateId: ResourceId,
  verdict: Type.Union([Type.Literal('pass'), Type.Literal('needs_review'), Type.Literal('reject')]),
  checked: Type.Object({ visual: Type.Boolean(), motion: Type.Boolean(), audio: Type.Boolean() }, { additionalProperties: true }),
  notes: Type.Optional(Type.Union([Type.String({ maxLength: 4000 }), Type.Null()])),
}, { additionalProperties: true });
