import { Type } from 'typebox';
import { ExistingRevision, Ratio, ResourceId, Revision } from './common.ts';
import { TIMELINE_POLICY } from '../../config/timeline.ts';

// Nullish defaults remain in the domain parsers; AJV never inserts or coerces values.
export const ProjectInput = Type.Object({
  name: Type.String({ maxLength: 100 }),
  brief: Type.Optional(Type.Union([Type.String({ maxLength: 10_000 }), Type.Null()])),
  ratio: Type.Optional(Type.Union([Ratio, Type.Null()])),
}, { additionalProperties: true });

export const ProjectUpdate = Type.Object({ ...ProjectInput.properties, expectedRevision: ExistingRevision }, { additionalProperties: true });
export const ExportInput = Type.Object({ timelineId: ResourceId, clientRequestId: ResourceId }, { additionalProperties: true });

const Clip = Type.Object({
  artifactId: ResourceId,
  sourceInMs: Type.Number({ minimum: 0, maximum: 86_400_000 }),
  durationMs: Type.Number({ minimum: 100, maximum: 600_000 }),
  fit: Type.Union([Type.Literal('contain'), Type.Literal('cover')]),
  muteSource: Type.Boolean(),
  shotId: Type.Optional(Type.Union([ResourceId, Type.Null(), Type.Literal(''), Type.Literal(false), Type.Literal(0)])),
}, { additionalProperties: true });

const CaptionStyle = Type.Object({
  fontFamily: Type.Optional(Type.String({ maxLength: 80 })),
  fontSize: Type.Optional(Type.Integer({ minimum: 8, maximum: 200 })),
  color: Type.Optional(Type.String({ pattern: '^#[0-9a-fA-F]{6}$' })),
  position: Type.Optional(Type.Union([Type.Literal('top'), Type.Literal('center'), Type.Literal('bottom')])),
}, { additionalProperties: false });

const Caption = Type.Object({
  startMs: Type.Integer({ minimum: 0 }),
  endMs: Type.Integer({ minimum: 1 }),
  text: Type.String({ maxLength: TIMELINE_POLICY.captionMaxCharacters }),
  style: Type.Optional(CaptionStyle),
}, { additionalProperties: false });

const AudioTrack = Type.Object({
  artifactId: ResourceId,
  startMs: Type.Integer({ minimum: 0 }),
  sourceInMs: Type.Integer({ minimum: 0, maximum: 86_400_000 }),
  gainDb: Type.Number({ minimum: -96, maximum: 24 }),
  durationMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 7_200_000 })),
  fadeInMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 7_200_000 })),
  fadeOutMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 7_200_000 })),
}, { additionalProperties: false });

export const TimelineInput = Type.Object({
  width: Type.Integer({ minimum: 64, maximum: 4096 }),
  height: Type.Integer({ minimum: 64, maximum: 4096 }),
  fps: Type.Integer({ minimum: 1, maximum: 60 }),
  clips: Type.Array(Clip, { minItems: 1, maxItems: 100 }),
  captions: Type.Optional(Type.Union([Type.Array(Caption, { maxItems: 1000 }), Type.Null()])),
  audio: Type.Optional(Type.Union([Type.Array(AudioTrack, { maxItems: 16 }), Type.Null()])),
  expectedVersion: Type.Optional(Type.Union([Revision, Type.Null()])),
}, { additionalProperties: true });

export const SettingsInput = Type.Object({
  ffmpegPath: Type.String({ maxLength: 1000 }),
  ffprobePath: Type.String({ maxLength: 1000 }),
  subtitleFontPath: Type.Optional(Type.String({ maxLength: 2048 })),
}, { additionalProperties: true });
