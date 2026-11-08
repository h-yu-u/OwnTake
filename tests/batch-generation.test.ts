import test from 'node:test';
import assert from 'node:assert/strict';
import type { Candidate, GenerationRecord, ProviderSummary, Shot } from '../apps/web/src/types.ts';
import { batchImageRows, enqueueBatch, freezeBatchItems } from '../apps/web/src/lib/batch-generation.ts';

const provider: ProviderSummary = { id: 'provider_a', label: '图片连接', kind: 'openai-images', baseUrl: 'https://api.openai.com/v1', model: 'image-model', capabilities: { inputModes: ['text'], ratios: ['9:16'], durationsSec: [], maxReferences: 0 }, maxOutputTokens: 4096, timeoutMs: 120000, hasKey: true, verification: 'unverified', createdAt: 'now', updatedAt: 'version_a' };
function shot(id: string, fields: Partial<Shot> = {}): Shot {
  return { id, projectId: 'project_a', title: id, purpose: '', description: `画面 ${id}`, action: '静止', durationMs: 2000, caption: '', mode: 'generate_image', referenceArtifactIds: [], order: 0, revision: 3, visualRevision: 2, captionRevision: 1, editRevision: 1, selectedArtifactId: null, selectedVisualRevision: null, archived: false, createdAt: 'now', updatedAt: 'now', ...fields };
}
function generation(shotId: string, status: GenerationRecord['status'], fields: Partial<GenerationRecord> = {}): GenerationRecord {
  return { id: `generation_${shotId}`, projectId: 'project_a', shotId, shotRevision: 3, visualRevision: 2, providerId: provider.id, providerModel: provider.model, planId: 'plan_a', attemptId: 'attempt_a', jobId: 'job_a', plan: { kind: 'image', inputMode: 'text', ratio: '9:16', prompt: 'test', referenceArtifactIds: [] }, status, remoteTaskId: null, lastRemoteStatus: null, cancelRequested: false, pollingPaused: false, currency: 'USD', reservedAmount: 0.1, actualAmount: null, artifactId: null, candidateId: null, error: null, createdAt: 'now', updatedAt: 'now', ...fields };
}

test('batch defaults exclude existing candidates, active/unknown work and unresolved failures without dropping reference inputs', () => {
  const shots = [shot('ready'), shot('chosen', { selectedArtifactId: 'asset_a' }), shot('candidate'), shot('oldCandidate'), shot('unknown'), shot('active'), shot('download'), shot('failed'), shot('settled'), shot('video', { mode: 'generate_video' }), shot('import', { mode: 'import' }), shot('reference', { referenceArtifactIds: ['asset_ref'] }), shot('blank', { description: '', action: '' }), shot('archived', { archived: true })];
  const candidates: Candidate[] = ['candidate', 'oldCandidate'].map(id => ({ id, shotId: id, projectId: 'project_a', visualRevision: id === 'candidate' ? 2 : 1, artifactId: 'asset_a', planId: null, createdAt: 'now' }));
  const records = [generation('unknown', 'submission_unknown', { visualRevision: 1 }), generation('active', 'queued'), generation('download', 'download_failed'), generation('failed', 'failed'), generation('settled', 'failed', { actualAmount: 0.02 })];
  const rows = batchImageRows(shots, candidates, records, '9:16', 'low');
  assert.deepEqual(rows.filter(row => !row.skipReason).map(row => row.shot.id), ['ready', 'oldCandidate', 'settled', 'video', 'import']);
  assert.equal(rows.some(row => row.shot.id === 'archived'), false);
  assert.deepEqual(rows.find(row => row.shot.id === 'reference')!.plan.referenceArtifactIds, ['asset_ref']);
  assert.match(rows.find(row => row.shot.id === 'unknown')!.skipReason!, /不明/);
  assert.match(rows.find(row => row.shot.id === 'download')!.skipReason!, /恢复/);
  for (const id of ['video', 'import']) {
    const row = rows.find(row => row.shot.id === id)!;
    assert.equal(row.plan.kind, 'image'); assert.equal(row.plan.imageQuality, 'low');
    assert.equal(Object.hasOwn(row.plan, 'durationSec'), false);
  }
  assert.equal(shots.find(shot => shot.id === 'video')!.mode, 'generate_video');
  assert.equal(shots.find(shot => shot.id === 'import')!.mode, 'import');
});

test('batch freezes independent prompts, references, versions, provider and operation IDs before enqueue', () => {
  const shots = [shot('one'), shot('two', { order: 1 })];
  const rows = batchImageRows(shots, [], [], '9:16', 'high');
  const connection = { ...provider };
  const items = freezeBatchItems(rows, connection, ['operation_one', 'operation_two']);
  rows[0]!.plan.prompt = 'changed'; rows[0]!.plan.referenceArtifactIds.push('later_ref'); shots[0]!.revision = 9;
  connection.updatedAt = 'changed';
  assert.equal(items[0]!.request.plan.prompt, '画面 one\n静止');
  assert.deepEqual(items[0]!.request.plan.referenceArtifactIds, []);
  assert.equal(items[0]!.request.expectedShotRevision, 3);
  assert.equal(items[0]!.request.expectedProviderUpdatedAt, 'version_a');
  assert.equal(Object.hasOwn(items[0]!.request, 'reservation'), false);
  assert.equal(items[1]!.request.plan.prompt, '画面 two\n静止');
  assert.equal(items[0]!.request.plan.imageQuality, 'high');
  assert.throws(() => freezeBatchItems(rows, provider, ['same', 'same']));
  assert.equal(Object.hasOwn(batchImageRows([shot('default')], [], [], '9:16', undefined)[0]!.plan, 'imageQuality'), false);
});

test('partial enqueue stops at a lost local acknowledgement and never retries or sends remaining shots', async () => {
  const items = freezeBatchItems(batchImageRows(['one', 'two', 'three'].map(id => shot(id)), [], [], '9:16', 'low'), provider, ['op_one', 'op_two', 'op_three']);
  const sent: string[] = [], results: string[] = [];
  await enqueueBatch(items, async id => { sent.push(id); if (id === 'two') throw new Error('Connection lost after registration'); return generation(id, 'queued'); }, result => { results.push(result.record ? 'registered' : 'uncertain'); });
  assert.deepEqual(sent, ['one', 'two']); assert.deepEqual(results, ['registered', 'uncertain']);
  for (const status of ['submission_unknown', 'failed', 'download_failed'] as const) {
    const calls: string[] = [];
    await enqueueBatch(items, async id => { calls.push(id); return generation(id, status); }, () => {});
    assert.deepEqual(calls, ['one']);
  }
});
