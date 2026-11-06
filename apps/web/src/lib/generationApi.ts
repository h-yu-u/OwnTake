import type { GenerationPlan, GenerationRecord, PlanValidationResult, Reservation, ReviewRecord } from '../types.ts';
import { request } from './api.ts';

export interface GenerationRequest {
  providerId: string; plan: GenerationPlan; expectedShotRevision: number; expectedProviderUpdatedAt: string;
  clientRequestId: string; reservation: Reservation;
}
export interface HumanReviewInput {
  candidateId: string; verdict: 'pass' | 'needs_review' | 'reject';
  checked: { visual: boolean; motion: boolean; audio: boolean }; notes: string;
}
function write<T>(path: string, body: unknown): Promise<T> { return request<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
const id = encodeURIComponent;
export const generationApi = {
  list: (projectId: string) => request<GenerationRecord[]>(`/projects/${id(projectId)}/generations`),
  reviews: (projectId: string) => request<ReviewRecord[]>(`/projects/${id(projectId)}/reviews`),
  validate: (shotId: string, providerId: string, plan: GenerationPlan) => write<PlanValidationResult>(`/shots/${id(shotId)}/generations/validate`, { providerId, plan }),
  submit: (shotId: string, input: GenerationRequest) => write<GenerationRecord>(`/shots/${id(shotId)}/generations`, input),
  reconcile: (generationId: string, remoteTaskId: string, note: string) => write<GenerationRecord>(`/generations/${id(generationId)}/reconcile`, { remoteTaskId, note }),
  retryDownload: (generationId: string) => write<GenerationRecord>(`/generations/${id(generationId)}/retry-download`, {}),
  cancel: (generationId: string) => write<GenerationRecord>(`/generations/${id(generationId)}/cancel`, {}),
  polling: (generationId: string, paused: boolean) => write<GenerationRecord>(`/generations/${id(generationId)}/polling`, { paused }),
  settle: (generationId: string, input: { actualAmount: number; currency: Reservation['currency']; note: string }) => write<GenerationRecord>(`/generations/${id(generationId)}/settle`, input),
  review: (shotId: string, input: HumanReviewInput) => write<ReviewRecord>(`/shots/${id(shotId)}/reviews`, input),
};
