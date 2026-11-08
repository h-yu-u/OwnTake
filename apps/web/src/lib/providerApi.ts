import type { CallRecord, ProviderModelCatalog, ProviderModelDiscoveryInput, ProviderProfile, ProviderSummary, Reservation } from '../types.ts';
import { request } from './api.ts';

export type ProviderInput = Omit<ProviderProfile, 'id' | 'createdAt' | 'updatedAt'> & { key?: string };
export interface ReasoningRequest { providerId: string; clientRequestId: string; expectedBoardRevision: number; expectedProjectRevision: number; expectedProviderUpdatedAt: string; reservation?: Reservation }
function write<T>(path: string, body: unknown, method = 'POST'): Promise<T> { return request<T>(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
export const providerApi = {
  list: () => request<ProviderSummary[]>('/providers'),
  models: (input: ProviderModelDiscoveryInput, signal?: AbortSignal) => request<ProviderModelCatalog>('/providers/models', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal,
  }),
  create: (input: ProviderInput) => write<ProviderSummary>('/providers', input),
  update: (id: string, input: ProviderInput) => write<ProviderSummary>(`/providers/${encodeURIComponent(id)}`, input, 'PUT'),
  calls: (projectId: string) => request<CallRecord[]>(`/projects/${encodeURIComponent(projectId)}/calls`),
  reason: (projectId: string, input: ReasoningRequest) => write<CallRecord>(`/projects/${encodeURIComponent(projectId)}/reasoning`, input),
  settle: (id: string, input: { actualAmount: number; currency: Reservation['currency']; note: string }) => write<CallRecord>(`/calls/${encodeURIComponent(id)}/settle`, input),
};
