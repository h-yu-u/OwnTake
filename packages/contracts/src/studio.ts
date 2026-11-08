import type { Reservation } from './calls.ts';
import type { SpeechInput, ReviewFrame, FrameReviewResult } from './studio-provider.ts';

export type StudioKind = 'tts' | 'frame_review' | 'runtime_draft';
export type StudioStatus = 'queued' | 'submitting' | 'received' | 'ingest_failed' | 'submission_unknown' | 'succeeded' | 'failed' | 'cancelled';
export type StudioInput = SpeechInput | { candidateId: string } | { expectedBoardRevision: number; expectedProjectRevision: number };
export interface SampledReview {
  ruleVersion: 'sampled-visual-v1'; samplingVersion: 'fixed-three-v1';
  frames: ReviewFrame[]; report: FrameReviewResult;
  coverage: { visual: 'sampled_frames'; motion: 'not_checked'; audio: 'not_checked' };
}
export interface SpeechBatchSource {
  id: string; index: number; total: number; shotTitle: string; shotRevision: number;
}
export interface BatchSpeechRequest {
  clientRequestId: string; targetId: string; expectedTargetUpdatedAt: string; expectedBoardRevision: number;
  voice: string; speed: number; instructions: string | null;
  entries: Array<{ shotId: string; expectedShotRevision: number; text: string }>;
}
export interface StudioOperation {
  id: string; projectId: string; kind: StudioKind; status: StudioStatus; jobId: string;
  targetId: string; targetLabel: string; targetModel: string; input: StudioInput;
  speechBatch?: SpeechBatchSource; budgetMode?: 'none';
  source: { artifactId?: string; sha256?: string; shotId?: string; visualRevision?: number; boardRevision?: number; projectRevision?: number };
  currency: Reservation['currency']; reservedAmount: number; actualAmount: number | null;
  artifactId: string | null; draftId: string | null; review: SampledReview | null;
  error: { code: string; message: string } | null; createdAt: string; updatedAt: string;
}
export interface StudioCreateRequest {
  kind: StudioKind; targetId: string; expectedTargetUpdatedAt: string;
  /** Studio operations may omit a local reservation; charges remain unknown. */
  clientRequestId: string; reservation?: Reservation; input: StudioInput;
}
