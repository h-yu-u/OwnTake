import test from 'node:test';
import assert from 'node:assert/strict';
import type { Artifact, TimelineDraft } from '../packages/contracts/src/index.ts';
import type { Shot } from '../packages/contracts/src/storyboard.ts';
import type { StudioOperation } from '../packages/contracts/src/studio.ts';
import { batchAudioRows, defaultBatchAudioIds, planBatchAudio } from '../packages/domain/src/batch-audio.ts';
import type { BatchAudioContext } from '../packages/domain/src/batch-audio.ts';

function asset(id: string, durationMs = 1000): Artifact {
  return { id, name: `${id}.wav`, projectId: 'project', kind: 'audio', relativePath: id, sha256: '0'.repeat(64), sizeBytes: 100, media: { kind: 'audio', durationMs, hasAudio: true, format: 'wav' }, source: 'generated', metadata: {}, createdAt: '2026-11-08T00:00:00Z' };
}
function shot(id: string): Shot { return { id, projectId: 'project', title: id, purpose: '', description: '', action: '', caption: id, durationMs: 1000, mode: 'import', referenceArtifactIds: [], order: 0, revision: 1, visualRevision: 1, captionRevision: 1, editRevision: 1, selectedArtifactId: 'image', selectedVisualRevision: 1, archived: false, createdAt: '', updatedAt: '' }; }
function operation(id: string, shotId: string, batch = id): StudioOperation {
  return { id: `op-${id}`, projectId: 'project', kind: 'tts', status: 'succeeded', jobId: `job-${id}`, targetId: 'provider', targetLabel: 'fixture', targetModel: 'fixture', input: { text: 'fixture', voice: 'fixture', speed: 1, instructions: null }, source: { shotId }, speechBatch: { id: batch, index: 0, total: 1, shotTitle: shotId, shotRevision: 1 }, currency: 'USD', budgetMode: 'none', reservedAmount: 0, actualAmount: null, artifactId: id, draftId: null, review: null, error: null, createdAt: '', updatedAt: '' };
}
const image = { ...asset('image', 0), kind: 'image' as const, media: { kind: 'image' as const, durationMs: 0, hasAudio: false, format: 'png' } };
const assets = [image, asset('voice-01', 1500), asset('voice-02', 1000), asset('music', 3000)];
const plan: TimelineDraft = { width: 320, height: 180, fps: 24, clips: ['a', 'b', 'c'].map(shotId => ({ artifactId: image.id, shotId, sourceInMs: 0, durationMs: 1000, fit: 'contain', muteSource: true })), captions: [{ startMs: 1000, endMs: 2000, text: '第二镜' }], audio: [{ artifactId: 'music', startMs: 0, sourceInMs: 0, durationMs: 3000, gainDb: -12 }] };
const context: BatchAudioContext = { projectId: 'project', mode: 'shots', startMs: 0, shots: ['a', 'b', 'c'].map(shot), operations: [operation('voice-01', 'a'), operation('voice-02', 'b')] };

test('existing audio picker excludes used/foreign/invalid assets and only aligns saved complete speech provenance', () => {
  const rows = batchAudioRows(plan, [...assets, { ...asset('foreign'), projectId: 'other' }, asset('invalid', 0)], context);
  assert(!rows.some(row => row.artifact.id === 'foreign'));
  assert.match(rows.find(row => row.artifact.id === 'music')!.reason, /已在时间线/);
  assert.match(rows.find(row => row.artifact.id === 'invalid')!.reason, /时长无效/);
  assert.deepEqual(defaultBatchAudioIds(rows, 'shots'), ['voice-01', 'voice-02']);
  const ordinary = batchAudioRows(plan, [...assets, asset('imported')], context).find(row => row.artifact.id === 'imported')!;
  assert.match(ordinary.reason, /无分镜配音来源/);
  assert.throws(() => planBatchAudio(plan, ['imported'], [...assets, asset('imported')], context), /无分镜配音来源/);
  assert.throws(() => planBatchAudio(plan, ['voice-01'], assets, { ...context, shots: [{ ...shot('a'), revision: 2 }] }), /分镜已改变/);
});

test('selection defaults pick newest per-shot version, reject duplicate versions and do not mutate source lists', () => {
  const more = [...assets, { ...asset('voice-01-new'), createdAt: '2026-11-08T01:00:00Z' }];
  const ctx = { ...context, operations: [...context.operations, operation('voice-01-new', 'a')] };
  const rows = batchAudioRows(plan, more, ctx);
  assert.deepEqual(defaultBatchAudioIds(rows, 'shots'), ['voice-01-new', 'voice-02']);
  assert.throws(() => planBatchAudio(plan, ['voice-01', 'voice-01-new'], more, ctx), /同一镜头/);
  assert.equal(more[0], image);
});

test('multiple speech batches align in one transaction-free plan and preserve existing music/caption shifts', () => {
  const original = structuredClone(plan);
  const result = planBatchAudio(plan, ['voice-02', 'voice-01'], assets, context);
  assert.deepEqual(plan, original);
  assert.equal(result.added, 2); assert.equal(result.extendedShots, 1);
  assert.deepEqual(result.tracks.map(track => [track.artifactId, track.startMs, track.durationMs]), [['voice-02', 1500, 1000], ['voice-01', 0, 1500]]);
  assert.deepEqual(result.draft.captions, [{ startMs: 1500, endMs: 2500, text: '第二镜' }]);
  assert.deepEqual(result.draft.audio[0], plan.audio[0]);
  const rows = batchAudioRows(result.draft, assets, context);
  assert(rows.every(row => row.reason.includes('已在时间线')));
  assert.throws(() => planBatchAudio(result.draft, ['voice-01'], assets, context), /已在时间线/);
});

test('sequential and parallel imports preserve selection order, start times, complete sources and existing tracks', () => {
  const sequence = planBatchAudio(plan, ['voice-02', 'voice-01', 'voice-02'], assets, { ...context, mode: 'sequence', startMs: 250 });
  assert.equal(sequence.added, 2);
  assert.deepEqual(sequence.tracks.map(track => [track.artifactId, track.startMs, track.durationMs]), [['voice-02', 250, 1000], ['voice-01', 1250, 1500]]);
  assert.deepEqual(sequence.draft.audio[0], plan.audio[0]);
  const parallel = planBatchAudio(plan, ['voice-01', 'voice-02'], assets, { ...context, mode: 'parallel', startMs: 1200 });
  assert.deepEqual(parallel.tracks.map(track => track.startMs), [1200, 1200]);
  assert.deepEqual(parallel.draft.clips, plan.clips);
  assert.deepEqual(parallel.draft.captions, plan.captions);
});

test('invalid selections, duration overflow and video overflow reject the entire plan without truncating or partial writes', () => {
  const original = structuredClone(plan);
  for (const mode of ['sequence', 'parallel'] as const) {
    assert.throws(() => planBatchAudio(plan, ['voice-01', 'voice-02'], assets, { ...context, mode, startMs: 2000 }), /未截断/);
    assert.throws(() => planBatchAudio(plan, ['voice-01'], assets, { ...context, mode, startMs: NaN }), /起点/);
  }
  assert.throws(() => planBatchAudio(plan, ['missing'], assets, context), /不存在/);
  assert.throws(() => planBatchAudio(plan, [], assets, context), /请选择/);
  assert.throws(() => planBatchAudio(plan, ['voice-01'], assets.map(asset => asset.id === 'image' ? { ...asset, kind: 'video' } : asset), context), /超过视频时长/);
  assert.deepEqual(plan, original);
});
