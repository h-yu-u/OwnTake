import type { ReasoningInput } from './providers.ts';

export type LocalRuntimeKind = 'claude-code' | 'codex-cli';
export const localReasoningEfforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type LocalReasoningEffort = typeof localReasoningEfforts[number];

/** A user-enabled trusted executable, not an OwnTake operating-system sandbox. */
export interface LocalRuntimeProfile {
  id: string;
  label: string;
  kind: LocalRuntimeKind;
  enabled: boolean;
  binaryPath: string;
  model: string;
  /** Omitted for the CLI's model default; frozen with the rest of the profile. */
  reasoningEffort?: LocalReasoningEffort;
  timeoutMs: number;
  createdAt: string;
  updatedAt: string;
}

export type LocalRuntimeIdentity = Pick<LocalRuntimeProfile, 'id' | 'createdAt' | 'updatedAt'>;
export type LocalRuntimeInput = Omit<LocalRuntimeProfile, keyof LocalRuntimeIdentity>;

export interface LocalRuntimeInspection {
  available: boolean;
  path: string;
  version?: string;
  compatible: boolean;
  authentication: 'not_checked';
  error?: string;
  /** Claude's help-advertised levels; not a model entitlement check. */
  reasoningEfforts?: LocalReasoningEffort[];
}

export interface LocalRuntimeModelOption {
  id: string;
  label: string;
  reasoningEfforts?: LocalReasoningEffort[];
  defaultReasoningEffort?: LocalReasoningEffort;
}

/** Local suggestions only; discovery never verifies login or model entitlement. */
export interface DiscoveredLocalRuntime {
  kind: LocalRuntimeKind;
  label: string;
  binaryPath: string;
  inspection: LocalRuntimeInspection;
  models: LocalRuntimeModelOption[];
  modelSource: 'local-cache' | 'bundled' | 'aliases' | 'unavailable';
}

export interface LocalDraftInput extends ReasoningInput {
  taskId: string;
  /** Host-created attempt directory. Never accepted from a model response. */
  workDir: string;
}

export type RuntimeFailureClassification = 'preflight_failed' | 'submission_unknown' | 'invalid_output';
