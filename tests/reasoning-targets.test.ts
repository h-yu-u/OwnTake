import test from 'node:test';
import assert from 'node:assert/strict';
import { reasoningTargets } from '../apps/web/src/lib/reasoning.ts';
import { budgetUsed, unknownReservations } from '../apps/web/src/lib/budget.ts';
import type { ProviderSummary, LocalRuntimeProfile } from '../apps/web/src/types.ts';

test('reasoning targets distinguish overlapping API/CLI IDs and exclude disabled or incompatible targets', () => {
  const provider: ProviderSummary = { id: 'shared', label: '推理', kind: 'chat-completions', model: 'fixture', baseUrl: 'http://127.0.0.1/v1', capabilities: { inputModes: ['text'], ratios: [], durationsSec: [], maxReferences: 0 }, timeoutMs: 1000, maxOutputTokens: 1024, createdAt: '1', updatedAt: '2', hasKey: false, verification: 'unverified' };
  const runtime: LocalRuntimeProfile = { id: 'shared', label: '本机', kind: 'codex-cli', binaryPath: '/fixture/codex', model: 'fixture', enabled: true, reasoningEffort: 'high', timeoutMs: 1000, createdAt: '1', updatedAt: '2' };
  const targets = reasoningTargets([provider, { ...provider, id: 'image', kind: 'openai-images' }, { ...provider, id: 'no-text', capabilities: { ...provider.capabilities, inputModes: ['first_frame'] } }], [runtime, { ...runtime, id: 'disabled', enabled: false }, { ...runtime, id: 'claude', kind: 'claude-code' }]);
  assert.deepEqual(targets.map(target => target.value), ['provider:shared', 'runtime:shared', 'runtime:claude']);
  assert.equal(targets[0]!.kind, 'provider'); assert.equal(targets[1]!.kind, 'runtime');
  assert.match(targets[1]!.label, /Codex CLI/); assert.match(targets[2]!.label, /Claude Code/);
  assert.equal(targets[1]!.profile, runtime);
});

test('unreserved unknown calls do not create reservation warnings or erase legacy exposure', () => {
  const old = { currency: 'USD' as const, reservedAmount: 0.5, actualAmount: null, status: 'submission_unknown' as const };
  const unreserved = { ...old, reservedAmount: 0, budgetMode: 'none' as const };
  assert.equal(unknownReservations([old, unreserved]), 1);
  assert.equal(budgetUsed([old, unreserved], 'USD'), 0.5);
});
