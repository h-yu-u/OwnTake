import { Type } from 'typebox';

export const ResourceId = Type.String({ pattern: '^[a-zA-Z0-9_-]{1,128}$' });
export const IdParams = Type.Object({ id: ResourceId });
export const FrameParams = Type.Object({ id: ResourceId, frameId: ResourceId });
export const Revision = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const ExistingRevision = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
export const Ratio = Type.Union([Type.Literal('16:9'), Type.Literal('9:16'), Type.Literal('1:1')]);
export const Currency = Type.Union([Type.Literal('USD'), Type.Literal('CNY')]);
export const Reservation = Type.Object({
  currency: Currency,
  amount: Type.Number({ minimum: 0, maximum: 1_000_000 }),
  singleLimit: Type.Number({ minimum: 0, maximum: 1_000_000 }),
  projectLimit: Type.Number({ minimum: 0, maximum: 1_000_000 }),
}, { additionalProperties: true });

export const Settlement = Type.Object({
  actualAmount: Type.Number({ minimum: 0, maximum: 100_000_000 }),
  currency: Currency,
  note: Type.String({ maxLength: 2000 }),
}, { additionalProperties: true });

export const StudioSettlement = Type.Object({
  ...Settlement.properties,
  note: Type.String({ maxLength: 4000 }),
}, { additionalProperties: true });
