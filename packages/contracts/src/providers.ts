import type { Ratio } from './index.ts';
import type { DraftOperation, Shot } from './storyboard.ts';

export type ProviderKind = 'chat-completions' | 'openai-images' | 'ark-video';
export type ProviderInputMode = 'text' | 'first_frame' | 'first_last_frame' | 'references';
export interface ProviderCapabilities {
  inputModes: ProviderInputMode[];
  ratios: Ratio[];
  durationsSec: number[];
  maxReferences: number;
}
export interface ProviderProfile {
  id: string;
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  capabilities: ProviderCapabilities;
  maxOutputTokens: number;
  timeoutMs: number;
  createdAt: string;
  updatedAt: string;
}
/** This is a user-declared capability profile, not proof of supplier verification. */
export interface ProviderSummary extends ProviderProfile { hasKey: boolean; verification: 'unverified' }
export interface GenerationPlan {
  kind: 'image' | 'video';
  inputMode: ProviderInputMode;
  prompt: string;
  ratio: Ratio;
  durationSec?: number;
  referenceArtifactIds: string[];
}
export interface CapabilityIssue { code: string; field: string; message: string }
export type CompiledGenerationInput =
  | { mode: 'text' }
  | { mode: 'first_frame'; firstFrameArtifactId: string }
  | { mode: 'first_last_frame'; firstFrameArtifactId: string; lastFrameArtifactId: string }
  | { mode: 'references'; referenceArtifactIds: string[] };
/** Pure compilation only; artifact IDs are deliberately not URLs or local paths. */
export interface CompiledGenerationPlan {
  providerId: string;
  providerKind: ProviderKind;
  baseUrl: string;
  model: string;
  plan: GenerationPlan;
  input: CompiledGenerationInput;
}
export type PlanValidationResult =
  | { status: 'valid'; issues: []; compiled: CompiledGenerationPlan }
  | { status: 'needs_replan'; issues: CapabilityIssue[]; requestedPlan: GenerationPlan };
export interface ReasoningUsage { inputTokens: number; outputTokens: number; totalTokens: number }
export interface ReasoningInput { brief: string; shots: Shot[]; signal?: AbortSignal }
export interface ReasoningResult { operations: DraftOperation[]; usage?: ReasoningUsage }
export type ProviderFailureClassification = 'submission_unknown' | 'http_rejected' | 'invalid_response' | 'cancelled';
