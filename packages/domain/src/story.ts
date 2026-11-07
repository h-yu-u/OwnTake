import { invariant } from '../../contracts/src/errors.ts';
import type { StoryInput, StoryPlatform, StoryRights, StorySource } from '../../contracts/src/story.ts';
import { record, text } from './validation.ts';

const platforms: StoryPlatform[] = ['original', 'zhihu', 'xiaohongshu', 'web', 'manual'];
const rights: StoryRights[] = ['original', 'licensed', 'inspiration_only', 'unknown'];
const allowed = (value: Record<string, unknown>, names: readonly string[]) =>
  invariant(Object.keys(value).every(key => names.includes(key)), 'INVALID_INPUT', '故事包含未允许的字段');

export function validateSource(input: unknown): StorySource {
  const source = record(input);
  allowed(source, ['platform', 'url', 'title', 'author', 'rights']);
  invariant(platforms.includes(source.platform as StoryPlatform), 'INVALID_INPUT', '故事来源类型无效');
  invariant(rights.includes(source.rights as StoryRights), 'INVALID_INPUT', '故事授权状态无效');
  const platform = source.platform as StoryPlatform;
  const url = text(source.url ?? '', '来源链接', 2048, true);
  if (url) {
    let parsed: URL;
    try { parsed = new URL(url); }
    catch { throw new Error('INVALID_STORY_SOURCE_URL'); }
    invariant(parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.hash && !/[\u0000-\u001f\u007f]/.test(url), 'INVALID_INPUT', '来源仅接受安全的 HTTPS 链接');
  }
  invariant(platform === 'original' ? !url && source.rights === 'original' : source.rights !== 'original', 'INVALID_INPUT', '来源与授权状态不匹配');
  return { platform, url, title: text(source.title ?? '', '来源标题', 300, true), author: text(source.author ?? '', '来源作者', 200, true), rights: source.rights as StoryRights };
}

export function validateStory(input: unknown): StoryInput {
  const value = record(input);
  allowed(value, ['title', 'genre', 'summary', 'tags', 'beats', 'source']);
  invariant(Array.isArray(value.tags) && value.tags.length <= 12, 'INVALID_INPUT', '最多 12 个标签');
  invariant(Array.isArray(value.beats) && value.beats.length <= 20, 'INVALID_INPUT', '故事结构最多 20 个节点');
  const tags = value.tags.map(tag => text(tag, '标签', 40));
  invariant(new Set(tags).size === tags.length, 'INVALID_INPUT', '标签不可重复');
  return {
    title: text(value.title, '故事标题', 200),
    genre: text(value.genre ?? '', '故事类型', 80, true),
    summary: text(value.summary ?? '', '故事摘要', 10000, true),
    tags,
    beats: value.beats.map(beat => text(beat, '故事节点', 2000)),
    source: validateSource(value.source),
  };
}
