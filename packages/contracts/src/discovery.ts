import type { StoryPlatform } from './story.ts';
export type DiscoverySource = 'zhihu' | 'xiaohongshu';
export interface DiscoveryResult {
  platform: DiscoverySource;
  title: string;
  url: string;
  author: string;
  snippet: string;
  contentType: string;
}
export interface DiscoveryImport {
  platform: Exclude<StoryPlatform, 'original'>;
  title: string;
  url: string;
  author: string;
  snippet: string;
}
