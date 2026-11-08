import type { LocalRuntimeProfile, ProviderSummary } from '../types.ts';

export type ReasoningTarget =
  | { kind: 'provider'; value: string; label: string; profile: ProviderSummary }
  | { kind: 'runtime'; value: string; label: string; profile: LocalRuntimeProfile };
export interface ReasoningSubmission {
  kind: ReasoningTarget['kind']; targetId: string; expectedTargetUpdatedAt: string;
  clientRequestId: string; expectedBoardRevision: number; expectedProjectRevision: number;
}
export function reasoningTargets(providers: ProviderSummary[], runtimes: LocalRuntimeProfile[]): ReasoningTarget[] {
  return [
    ...providers.filter(profile => profile.kind === 'chat-completions' && profile.capabilities.inputModes.includes('text'))
      .map(profile => ({ kind: 'provider' as const, value: `provider:${profile.id}`, label: `${profile.label} · ${profile.model}（API）`, profile })),
    ...runtimes.filter(profile => profile.enabled)
      .map(profile => ({ kind: 'runtime' as const, value: `runtime:${profile.id}`, label: `${profile.label} · ${profile.model}（${profile.kind === 'codex-cli' ? 'Codex CLI' : 'Claude Code'}）`, profile })),
  ];
}
