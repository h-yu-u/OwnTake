import { Type } from 'typebox';
import { ExistingRevision, Ratio, Reservation, ResourceId, Revision } from './common.ts';

export const ProviderInputMode = Type.Union([Type.Literal('text'), Type.Literal('first_frame'), Type.Literal('first_last_frame'), Type.Literal('references')]);

const SpeechCapabilities = Type.Object({
  voices: Type.Array(Type.String({ maxLength: 128 }), { minItems: 1, maxItems: 100 }),
  supportsInstructions: Type.Boolean(),
  minSpeed: Type.Number({ minimum: 0.25, maximum: 4 }),
  maxSpeed: Type.Number({ minimum: 0.25, maximum: 4 }),
  maxInputChars: Type.Integer({ minimum: 1, maximum: 4096 }),
}, { additionalProperties: false });

const ProviderCapabilities = Type.Object({
  inputModes: Type.Array(ProviderInputMode, { minItems: 1, maxItems: 4, uniqueItems: true }),
  ratios: Type.Array(Ratio, { maxItems: 3, uniqueItems: true }),
  durationsSec: Type.Array(Type.Number({ exclusiveMinimum: 0, maximum: 600 }), { maxItems: 100, uniqueItems: true }),
  maxReferences: Type.Integer({ minimum: 0, maximum: 16 }),
  speech: Type.Optional(SpeechCapabilities),
  frameReview: Type.Optional(Type.Object({ maxImages: Type.Integer({ minimum: 1, maximum: 16 }) }, { additionalProperties: false })),
}, { additionalProperties: false });

export const ProviderInput = Type.Object({
  label: Type.String({ maxLength: 120 }),
  kind: Type.Union([Type.Literal('chat-completions'), Type.Literal('openai-images'), Type.Literal('ark-video'), Type.Literal('openai-speech')]),
  baseUrl: Type.String({ maxLength: 2048 }),
  model: Type.String({ maxLength: 200 }),
  capabilities: ProviderCapabilities,
  maxOutputTokens: Type.Optional(Type.Union([Type.Integer({ minimum: 1, maximum: 8192 }), Type.Null()])),
  timeoutMs: Type.Optional(Type.Union([Type.Integer({ minimum: 1, maximum: 120_000 }), Type.Null()])),
  key: Type.Optional(Type.String()),
  // Existing API callers may echo these fields; the repository replaces them.
  id: Type.Optional(Type.Unknown()),
  createdAt: Type.Optional(Type.Unknown()),
  updatedAt: Type.Optional(Type.Unknown()),
}, { additionalProperties: false });

export const ReasoningInput = Type.Object({
  providerId: ResourceId,
  clientRequestId: ResourceId,
  expectedBoardRevision: Revision,
  expectedProjectRevision: ExistingRevision,
  expectedProviderUpdatedAt: Type.String({ maxLength: 100 }),
  reservation: Reservation,
}, { additionalProperties: true });
