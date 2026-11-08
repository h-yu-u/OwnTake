import test from 'node:test';
import assert from 'node:assert/strict';
import type { Artifact, TimelineDraft } from '../packages/contracts/src/index.ts';
import { MAX_AUDIO_TRACKS } from '../packages/contracts/src/index.ts';
import type { Shot } from '../packages/contracts/src/storyboard.ts';
import type { StudioOperation } from '../packages/contracts/src/studio.ts';
import { placeBatchSpeech } from '../packages/domain/src/batch-speech.ts';
import { timelineInput } from '../packages/domain/src/validation.ts';

function artifact(id: string, kind: Artifact['kind'], durationMs = 0): Artifact {
  return { id, projectId: 'p', kind, name: id, relativePath: id, sha256: '0'.repeat(64), sizeBytes: 100, source: 'generated', media: { kind, durationMs, hasAudio: kind === 'audio', format: 'fixture' }, metadata: {}, createdAt: '2026-11-08T00:00:00Z' };
}
function shot(id: string): Shot { return { id, projectId: 'p', title: id, purpose: '', description: '', action: '', durationMs: 1000, caption: id, mode: 'import', referenceArtifactIds: [], order: 0, revision: 1, visualRevision: 1, captionRevision: 1, editRevision: 1, archived: false, selectedArtifactId: 'image', selectedVisualRevision: 1, createdAt: '', updatedAt: '' }; }
function operation(id: string, index = 0, status: StudioOperation['status'] = 'succeeded'): StudioOperation {
  return { id: `op-${id}`, projectId: 'p', kind: 'tts', status, jobId: `job-${id}`, targetId: 'provider', targetLabel: 'fixture', targetModel: 'fixture', input: { text: id, voice: 'voice', speed: 1, instructions: null }, source: { shotId: id }, speechBatch: { id: 'batch', index, total: 2, shotTitle: id, shotRevision: 1 }, budgetMode: 'none', currency: 'USD', reservedAmount: 0, actualAmount: null, artifactId: `voice-${id}`, draftId: null, review: null, error: null, createdAt: '', updatedAt: '' };
}
function timeline(): TimelineDraft { return { width: 320, height: 180, fps: 24, clips: ['a', 'b', 'c'].map(shotId => ({ artifactId: 'image', sourceInMs: 0, durationMs: 1000, fit: 'contain', muteSource: true, shotId })), captions: [{ startMs: 0, endMs: 1000, text: 'A' }, { startMs: 1000, endMs: 2000, text: 'B' }, { startMs: 2100, endMs: 2800, text: 'C' }], audio: [{ artifactId: 'music', startMs: 0, sourceInMs: 0, durationMs: 3000, gainDb: -10 }, { artifactId: 'effect', startMs: 2200, sourceInMs: 0, durationMs: 300, gainDb: 0 }] }; }
const assets = [artifact('image', 'image'), artifact('voice-a', 'audio', 1500), artifact('voice-b', 'audio', 750), artifact('music', 'audio', 3000), artifact('effect', 'audio', 300)];
const shots = ['a', 'b', 'c'].map(shot);

test('batch speech extends images, shifts captions and existing effects, and preserves full voice/music without mutation', () => {
  const before = timeline(), untouched = structuredClone(before);
  const result = placeBatchSpeech(before, [operation('a'), operation('b', 1)], assets, shots);
  assert.deepEqual(before, untouched);
  assert.equal(result.added, 2); assert.equal(result.extendedShots, 1);
  assert.deepEqual(result.draft.clips.map(clip => clip.durationMs), [1500, 1000, 1000]);
  assert.deepEqual(result.draft.captions.map(caption => [caption.startMs, caption.endMs]), [[0, 1500], [1500, 2500], [2600, 3300]]);
  assert.deepEqual(result.draft.audio.slice(0, 2), [before.audio[0], { ...before.audio[1], startMs: 2700 }]);
  assert.deepEqual(result.draft.audio.slice(2).map(track => [track.startMs, track.durationMs]), [[0, 1500], [1500, 750]]);
  assert.equal(placeBatchSpeech(result.draft, [operation('a'), operation('b', 1)], assets, shots).added, 0);
});

test('batch speech rejects stale/foreign/missing media, duplicate clips, video overflow and conflicting speech', () => {
  const op = operation('a');
  assert.throws(() => placeBatchSpeech(timeline(), [op], assets, [{ ...shots[0]!, revision: 2 }]), /已改变/);
  assert.throws(() => placeBatchSpeech(timeline(), [op], assets.filter(asset => asset.id !== op.artifactId), shots), /无效/);
  assert.throws(() => placeBatchSpeech(timeline(), [op], assets.map(asset => asset.id === op.artifactId ? { ...asset, projectId: 'other' } : asset), shots), /无效/);
  const duplicate = timeline(); duplicate.clips[1]!.shotId = 'a';
  assert.throws(() => placeBatchSpeech(duplicate, [op], assets, shots), /恰好出现一次/);
  assert.throws(() => placeBatchSpeech(timeline(), [op], assets.map(asset => asset.id === 'image' ? { ...asset, kind: 'video' } : asset), shots), /超过视频时长/);
  assert.throws(() => placeBatchSpeech(timeline(), [op], assets.map(asset => asset.id === 'music' ? { ...asset, metadata: { shotId: 'a', speechBatchId: 'old' } } : asset), shots), /已有分镜配音/);
});

test('26-shot narration fits the bounded track limit, skips failures, preserves rounded frame boundaries and rejects overflow', () => {
  const count = 26, scenes = Array.from({ length: count }, (_, index) => shot(`s${index}`));
  const ops = scenes.map((scene, index) => operation(scene.id, index));
  const audio = scenes.map(scene => artifact(`voice-${scene.id}`, 'audio', 1010));
  const plan = { ...timeline(), audio: [], captions: [], clips: scenes.map(scene => ({ ...timeline().clips[0]!, shotId: scene.id })) };
  const result = placeBatchSpeech(plan, ops, [assets[0]!, ...audio], scenes);
  assert.equal(result.added, count); assert.equal(result.draft.audio.length, count);
  assert.equal(result.draft.audio[25]!.startMs, Math.floor(25 * 25 / 24 * 1000 + 0.001));
  assert.equal(result.draft.audio[25]!.durationMs, 1010);
  const partial = placeBatchSpeech(plan, [ops[0]!, { ...ops[1]!, status: 'failed', artifactId: null }], [assets[0]!, ...audio], scenes);
  assert.equal(partial.added, 1);
  assert.throws(() => timelineInput({ ...result.draft, audio: Array.from({ length: MAX_AUDIO_TRACKS + 1 }, () => result.draft.audio[0]), expectedVersion: 0 }), /最多/);
});
