import type { ReasoningInput } from './providers.ts';

export type LocalRuntimeKind = 'claude-code' | 'codex-cli';

/** A user-enabled trusted executable, not an OwnTake operating-system sandbox. */
export interface LocalRuntimeProfile {
  id: string;
  label: string;
  kind: LocalRuntimeKind;
  enabled: boolean;
  binaryPath: string;
  model: string;
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
}

export interface LocalDraftInput extends ReasoningInput {
  taskId: string;
  /** Host-created attempt directory. Never accepted from a model response. */
  workDir: string;
}

export type RuntimeFailureClassification = 'preflight_failed' | 'submission_unknown' | 'invalid_output';
