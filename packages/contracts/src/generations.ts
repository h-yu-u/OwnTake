import type { GenerationPlan } from './providers.ts';
import type { Reservation } from './calls.ts';
export type GenerationStatus = 'queued' | 'submitting' | 'submission_unknown' | 'waiting_remote' | 'remote_succeeded' | 'ingesting' | 'download_failed' | 'succeeded' | 'failed' | 'cancelled';
export interface GenerationRecord {
  id: string; projectId: string; shotId: string; shotRevision: number; visualRevision: number;
  providerId: string; providerModel: string; planId: string; attemptId: string; jobId: string;
  plan: GenerationPlan; status: GenerationStatus; remoteTaskId: string | null; lastRemoteStatus: string | null;
  cancelRequested: boolean; pollingPaused: boolean;
  currency: Reservation['currency']; reservedAmount: number; actualAmount: number | null;
  artifactId: string | null; candidateId: string | null;
  error: { code: string; message: string } | null; createdAt: string; updatedAt: string;
}
export interface ReviewRecord {
  id: string; projectId: string; shotId: string; artifactId: string; visualRevision: number; planId: string | null;
  kind: 'technical' | 'human'; ruleVersion: string; verdict: 'pass' | 'needs_review' | 'reject';
  checked: { technical: boolean; visual: boolean; motion: boolean; audio: boolean };
  notes: string; issues: string[]; createdAt: string;
}
