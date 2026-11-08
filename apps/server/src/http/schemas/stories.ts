import { Type } from 'typebox';
import { IdParams, Ratio } from './common.ts';
export { IdParams };
export const StorySource = Type.Object({
  platform: Type.Union(['original','zhihu','xiaohongshu','web','manual'].map(value => Type.Literal(value))),
  url: Type.String({ maxLength: 2048 }),
  title: Type.String({ maxLength: 300 }),
  author: Type.String({ maxLength: 200 }),
  rights: Type.Union(['original','licensed','inspiration_only','unknown'].map(value => Type.Literal(value))),
}, { additionalProperties: false });
export const StoryInput = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 200 }),
  genre: Type.String({ maxLength: 80 }),
  summary: Type.String({ maxLength: 10000 }),
  tags: Type.Array(Type.String({ minLength: 1, maxLength: 40 }), { maxItems: 12 }),
  beats: Type.Array(Type.String({ minLength: 1, maxLength: 2000 }), { maxItems: 20 }),
  source: StorySource,
}, { additionalProperties: false });
export const StoryUpdate = Type.Object({ ...StoryInput.properties, expectedRevision: Type.Integer({ minimum: 1 }) }, { additionalProperties: false });
export const StorySearch = Type.Object({ q: Type.Optional(Type.String({ maxLength: 100 })) });
export const ScriptInput = Type.Object({
  sourceVersion: Type.Integer({ minimum: 1 }),
  text: Type.String({ minLength: 1, maxLength: 20000 }),
}, { additionalProperties: false });
export const ProjectFromStory = Type.Object({
  storyVersion: Type.Integer({ minimum: 1 }),
  scriptVersion: Type.Union([Type.Integer({ minimum: 1 }),Type.Null()]),
  ratio: Ratio,
}, { additionalProperties: false });
