import type { Artifact } from './index.ts';
import type { GenerationPlan, PlanValidationResult, ProviderProfile } from './providers.ts';

/** A relative API path, always sent to the configured provider base URL. */
export interface GenerationRequest {
  endpoint: string;
  body: Record<string, unknown>;
}

export interface GenerationRequestOptions { signal?: AbortSignal }
export type GenerationReferenceData = Record<string, string>;
export type GenerationSubmissionResult =
  | { kind: 'inline'; bytes: Uint8Array; mime: 'image/png' }
  | { kind: 'remote'; remoteTaskId: string };

export type GenerationRemoteStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'expired';
export interface GenerationPollResult {
  status: GenerationRemoteStatus;
  outputUrl?: string;
  errorCode?: string;
}

/** Acknowledges the DELETE request only; a later poll must confirm a terminal status. */
export interface GenerationCancellationResult { acknowledged: boolean }

export interface GenerationProviderAdapter {
  validateGeneration(profile: ProviderProfile, plan: GenerationPlan, referenceArtifacts: Artifact[]): PlanValidationResult;
  compileGenerationRequest(profile: ProviderProfile, plan: GenerationPlan, referenceData: GenerationReferenceData): GenerationRequest;
  submitGeneration(profile: ProviderProfile, key: string, plan: GenerationPlan, referenceData: GenerationReferenceData, options?: GenerationRequestOptions): Promise<GenerationSubmissionResult>;
  pollGeneration(profile: ProviderProfile, key: string, remoteTaskId: string, options?: GenerationRequestOptions): Promise<GenerationPollResult>;
  cancelGeneration(profile: ProviderProfile, key: string, remoteTaskId: string, options?: GenerationRequestOptions): Promise<GenerationCancellationResult>;
}
