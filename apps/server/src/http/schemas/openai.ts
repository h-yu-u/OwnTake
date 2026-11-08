import { Type } from 'typebox';
import { ExistingRevision } from './common.ts';

const fields = {
  label: Type.String({ minLength: 1, maxLength: 100 }),
  models: Type.Object({
    reasoning: Type.String({ minLength: 1, maxLength: 200 }),
    image: Type.String({ minLength: 1, maxLength: 200 }),
    speech: Type.String({ minLength: 1, maxLength: 200 }),
  }, { additionalProperties: false }),
  key: Type.Optional(Type.String({ maxLength: 8192 })),
};

export const OpenAIConnectionInput = Type.Object(fields, { additionalProperties: false });
export const OpenAIConnectionUpdate = Type.Object({ ...fields, expectedRevision: ExistingRevision }, { additionalProperties: false });
