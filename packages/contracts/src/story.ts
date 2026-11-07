/** Stories are global creative assets. Source excerpts never imply adaptation rights. */
export type StoryPlatform = 'original' | 'zhihu' | 'xiaohongshu' | 'web' | 'manual';
export type StoryRights = 'original' | 'licensed' | 'inspiration_only' | 'unknown';
export interface StorySource {
  platform: StoryPlatform;
  url: string;
  title: string;
  author: string;
  rights: StoryRights;
}
export interface Story {
  id: string;
  title: string;
  genre: string;
  summary: string;
  tags: string[];
  source: StorySource;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface StoryInput {
  title: string;
  genre: string;
  summary: string;
  tags: string[];
  beats: string[];
  source: StorySource;
}
export interface StoryVersion extends StoryInput {
  storyId: string;
  version: number;
  createdAt: string;
}
export interface ScriptVersion {
  id: string;
  storyId: string;
  version: number;
  sourceVersion: number;
  text: string;
  createdAt: string;
}
export interface StoryProjectLink {
  storyId: string;
  storyVersion: number;
  scriptVersion: number | null;
  projectId: string;
  createdAt: string;
}
