import type { BatchSpeechRequest, DiscoveredLocalRuntime, LocalRuntimeInput, LocalRuntimeInspection, LocalRuntimeProfile, Reservation, StudioCreateRequest, StudioOperation } from '../types.ts';
import { request } from './api.ts';

export type RuntimeSettingsInput = LocalRuntimeInput & { trustAcknowledged: boolean };
export interface SettlementInput { id: string; actualAmount: number; currency: Reservation['currency']; note: string }
function write<T>(path: string, body: unknown, method = 'POST'): Promise<T> { return request<T>(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
export const studioApi = {
  runtimes: () => request<LocalRuntimeProfile[]>('/runtimes'),
  discoverRuntimes: () => write<DiscoveredLocalRuntime[]>('/runtimes/discover', {}),
  createRuntime: (input: RuntimeSettingsInput) => write<LocalRuntimeProfile>('/runtimes', input),
  updateRuntime: (id: string, input: RuntimeSettingsInput) => write<LocalRuntimeProfile>(`/runtimes/${encodeURIComponent(id)}`, input, 'PUT'),
  inspectRuntime: (id: string) => write<LocalRuntimeInspection>(`/runtimes/${encodeURIComponent(id)}/inspect`, {}),
  list: (projectId: string) => request<StudioOperation[]>(`/projects/${encodeURIComponent(projectId)}/studio-operations`),
  create: (projectId: string, input: StudioCreateRequest) => write<StudioOperation>(`/projects/${encodeURIComponent(projectId)}/studio-operations`, input),
  batchSpeech: (projectId: string, input: BatchSpeechRequest) => write<StudioOperation[]>(`/projects/${encodeURIComponent(projectId)}/speech-batches`, input),
  cancelBatch: (projectId: string, batchId: string) => write<StudioOperation[]>(`/projects/${encodeURIComponent(projectId)}/speech-batches/${encodeURIComponent(batchId)}/cancel`, {}),
  cancel: (id: string) => write<StudioOperation>(`/studio-operations/${encodeURIComponent(id)}/cancel`, {}),
  retryIngest: (id: string) => write<StudioOperation>(`/studio-operations/${encodeURIComponent(id)}/retry-ingest`, {}),
  settle: ({ id, ...input }: SettlementInput) => write<StudioOperation>(`/studio-operations/${encodeURIComponent(id)}/settle`, input),
};

export function reviewFrameUrl(operationId: string, frameId: string): string { return `/api/studio-operations/${encodeURIComponent(operationId)}/frames/${encodeURIComponent(frameId)}`; }
