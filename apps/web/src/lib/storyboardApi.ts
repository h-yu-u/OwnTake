import type { BoardSnapshot, Candidate, DraftOperation, ShotFields, StoryboardDraft, Timeline } from '../types.ts';
import { request } from './api.ts';

function write<T>(path: string, body: unknown, method = 'POST'): Promise<T> {
  return request<T>(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
const id = encodeURIComponent;
export const storyboardApi = {
  snapshot: (projectId: string) => request<BoardSnapshot>(`/projects/${id(projectId)}/storyboard`),
  createShot: (projectId: string, fields: ShotFields, expectedBoardRevision: number) => write<BoardSnapshot>(`/projects/${id(projectId)}/shots`, { fields, expectedBoardRevision }),
  updateShot: (shotId: string, fields: ShotFields, expectedShotRevision: number) => write<BoardSnapshot>(`/shots/${id(shotId)}`, { fields, expectedShotRevision }, 'PUT'),
  archiveShot: (shotId: string, expectedShotRevision: number) => write<BoardSnapshot>(`/shots/${id(shotId)}/archive`, { expectedShotRevision }),
  reorder: (projectId: string, shotIds: string[], expectedBoardRevision: number) => write<BoardSnapshot>(`/projects/${id(projectId)}/shots/reorder`, { shotIds, expectedBoardRevision }),
  candidate: (shotId: string, artifactId: string) => write<Candidate>(`/shots/${id(shotId)}/candidates`, { artifactId }),
  selectCandidate: (shotId: string, candidateId: string, expectedShotRevision: number) => write<BoardSnapshot>(`/shots/${id(shotId)}/select`, { candidateId, expectedShotRevision }),
  createDraft: (projectId: string, operations: DraftOperation[], baseRevision: number) => write<StoryboardDraft>(`/projects/${id(projectId)}/drafts`, { operations, baseRevision }),
  applyDraft: (draftId: string, acceptedOperationIds: string[], expectedBoardRevision: number) => write<BoardSnapshot>(`/drafts/${id(draftId)}/apply`, { acceptedOperationIds, expectedBoardRevision }),
  timeline: (projectId: string, expectedVersion: number) => write<Timeline>(`/projects/${id(projectId)}/storyboard/timeline`, { expectedVersion }),
};
