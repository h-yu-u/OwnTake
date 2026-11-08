import test from 'node:test';
import assert from 'node:assert/strict';
import { automaticModelCapabilities } from '../packages/providers/src/ark-model-capabilities.ts';
import { validateGenerationShape } from '../packages/providers/src/generation-validation.ts';
import type { GenerationPlan, ProviderProfile } from '../packages/contracts/src/providers.ts';

test('Seedance fast auto configuration is the documented adapter subset, with no tail-frame or reference-image claim', () => {
  const automatic = automaticModelCapabilities('ark-video', 'doubao-seedance-1-0-pro-fast-251015')!;
  assert.deepEqual(automatic.capabilities, { inputModes: ['text', 'first_frame'], ratios: ['16:9', '9:16', '1:1'], durationsSec: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], maxReferences: 1 });
  const profile: ProviderProfile = { id: 'fixture', label: 'fixture', kind: 'ark-video', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-seedance-1-0-pro-fast-251015', capabilities: automatic.capabilities, timeoutMs: 1000, maxOutputTokens: 4096, createdAt: '2026-11-08T00:00:00.000Z', updatedAt: '2026-11-08T00:00:00.000Z' };
  const plan: GenerationPlan = { kind: 'video', inputMode: 'first_frame', prompt: '缓慢推进', ratio: '9:16', durationSec: 12, referenceArtifactIds: ['first'] };
  assert.equal(validateGenerationShape(profile, plan).status, 'valid');
  assert.equal(validateGenerationShape(profile, { ...plan, durationSec: 13 }).status, 'needs_replan');
  assert.equal(validateGenerationShape(profile, { ...plan, inputMode: 'first_last_frame', referenceArtifactIds: ['first', 'last'] }).status, 'needs_replan');
  assert.equal(validateGenerationShape(profile, { ...plan, inputMode: 'references' }).status, 'needs_replan');
});

test('documented versions differ and automatic capabilities do not expose unsupported adapter features', () => {
  const pro = automaticModelCapabilities('ark-video', 'doubao-seedance-1-0-pro-250528')!.capabilities;
  assert(pro.inputModes.includes('first_last_frame')); assert.equal(pro.maxReferences, 2);
  const two = automaticModelCapabilities('ark-video', 'doubao-seedance-2-0-fast-260128')!.capabilities;
  assert.equal(two.durationsSec[0], 4); assert.equal(two.durationsSec.at(-1), 15); assert.equal(two.maxReferences, 9); assert(two.inputModes.includes('references'));
  const newer = automaticModelCapabilities('ark-video', 'doubao-seedance-2-5-260628')!;
  assert.equal(newer.capabilities.durationsSec.at(-1), 30); assert.equal(newer.capabilities.maxReferences, 16);
  assert(!newer.capabilities.inputModes.includes('first_frame')); assert(newer.notes.some(note => note.includes('自适应画幅')));
  assert.equal(automaticModelCapabilities('ark-video', 'doubao-seedance-future'), null);
  assert.equal(automaticModelCapabilities('ark-video', 'doubao-seedance-1-0-pro-fast-991231'), null);
  assert.equal(automaticModelCapabilities('ark-video', 'ep-custom-endpoint'), null);
  assert.equal(automaticModelCapabilities('openai-images', 'doubao-seedance-1-0-pro-fast-251015'), null);
  const changed = automaticModelCapabilities('ark-video', 'doubao-seedance-1.0-pro-fast')!; changed.capabilities.ratios.length = 0; changed.capabilities.inputModes.push('references');
  assert.equal(automaticModelCapabilities('ark-video', 'doubao-seedance-1.0-pro-fast')!.capabilities.ratios.length, 3);
  assert.deepEqual(automaticModelCapabilities('ark-video', 'doubao-seedance-1.0-pro-fast')!.capabilities.inputModes, ['text', 'first_frame']);
});
