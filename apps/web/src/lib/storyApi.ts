import type { Project, Ratio, StoryboardDraft, ScriptVersion, Story, StoryInput, StoryProjectLink, StoryVersion } from '../types.ts';
import { request } from './api.ts';
const json = <T>(path: string, method: string, body: unknown) =>
  request<T>(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const segment = (value: string) => encodeURIComponent(value);
export const storyApi = {
  list: (q = '') => request<Story[]>(`/stories?q=${encodeURIComponent(q)}`),
  get: (id: string) => request<Story>(`/stories/${segment(id)}`),
  create: (input: StoryInput) => json<Story>('/stories', 'POST', input),
  update: (id: string, input: StoryInput, expectedRevision: number) => json<Story>(`/stories/${segment(id)}`, 'PUT', { ...input, expectedRevision }),
  versions: (id: string) => request<StoryVersion[]>(`/stories/${segment(id)}/versions`),
  scripts: (id: string) => request<ScriptVersion[]>(`/stories/${segment(id)}/scripts`),
  projects: (id: string) => request<StoryProjectLink[]>(`/stories/${segment(id)}/projects`),
  saveScript: (id: string, sourceVersion: number, text: string) => json<ScriptVersion>(`/stories/${segment(id)}/scripts`, 'POST', { sourceVersion, text }),
  toStoryboard: (id:string,projectId:string,scriptVersion:number,expectedBoardRevision:number) =>
    json<StoryboardDraft>(`/stories/${segment(id)}/storyboard-draft`,'POST',{projectId,scriptVersion,expectedBoardRevision}),
  createProject: (id: string, storyVersion: number, scriptVersion: number | null, ratio: Ratio) =>
    json<{ project: Project; link: StoryProjectLink }>(`/stories/${segment(id)}/projects`, 'POST', { storyVersion, scriptVersion, ratio }),
};
