import { Type } from 'typebox';
import { localReasoningEfforts } from '../../../../../packages/contracts/src/runtimes.ts';
import { ExistingRevision, Reservation, ResourceId, Revision } from './common.ts';

export const RuntimeInput = Type.Object({
  label: Type.String({ maxLength: 120 }),
  kind: Type.Union([Type.Literal('claude-code'), Type.Literal('codex-cli')]),
  binaryPath: Type.String({ maxLength: 4096 }),
  model: Type.String({ maxLength: 200 }),
  reasoningEffort: Type.Optional(Type.Union(localReasoningEfforts.map(effort => Type.Literal(effort)))),
  enabled: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
  timeoutMs: Type.Optional(Type.Union([Type.Integer({ minimum: 100, maximum: 600_000 }), Type.Null()])),
  // This acknowledgement is only interpreted when enabling the runtime.
  trustAcknowledged: Type.Optional(Type.Unknown()),
  id: Type.Optional(ResourceId),
  createdAt: Type.Optional(Type.String({ maxLength: 64 })),
  updatedAt: Type.Optional(Type.String({ maxLength: 64 })),
}, { additionalProperties: false });

const RequestFields = {
  targetId: ResourceId,
  expectedTargetUpdatedAt: Type.String({ maxLength: 100 }),
  clientRequestId: ResourceId,
  reservation: Reservation,
};

export const SpeechInput = Type.Object({
  text: Type.String(),
  voice: Type.String({ maxLength: 128 }),
  speed: Type.Number(),
  instructions: Type.Union([Type.String({ maxLength: 4096 }), Type.Null()]),
}, { additionalProperties: false });

export const StudioCreate = Type.Union([
  Type.Object({ ...RequestFields, kind: Type.Literal('tts'), input: SpeechInput }, { additionalProperties: false }),
  Type.Object({ ...RequestFields, kind: Type.Literal('frame_review'), input: Type.Object({ candidateId: ResourceId }, { additionalProperties: false }) }, { additionalProperties: false }),
  Type.Object({
    ...RequestFields, kind: Type.Literal('runtime_draft'),
    input: Type.Object({ expectedBoardRevision: Revision, expectedProjectRevision: ExistingRevision }, { additionalProperties: false }),
  }, { additionalProperties: false }),
]);
