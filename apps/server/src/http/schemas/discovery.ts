import { Type } from 'typebox';
export const SearchQuery = Type.Object({
  source: Type.Union([Type.Literal('zhihu'), Type.Literal('xiaohongshu')]),
  q: Type.String({ minLength: 1, maxLength: 100 }),
}, { additionalProperties: false });
export const DiscoverySave = Type.Object({
  platform: Type.Union([Type.Literal('zhihu'), Type.Literal('xiaohongshu'), Type.Literal('web'), Type.Literal('manual')]),
  url: Type.String({ minLength: 8, maxLength: 2048 }),
  title: Type.String({ minLength: 1, maxLength: 300 }),
  author: Type.String({ maxLength: 200 }),
  snippet: Type.String({ maxLength: 1000 }),
}, { additionalProperties: false });
