import test from 'node:test';
import assert from 'node:assert/strict';
import { projectInput, timelineInput, resourceId } from '../packages/domain/src/validation.ts';
test('boundary validation rejects path IDs and invalid timeline dimensions', () => {
  assert.throws(() => resourceId('../outside'));
  assert.throws(() => resourceId('x\0y'));
  assert.equal(projectInput({ name: ' 第一部作品 ', ratio: '16:9' }).name, '第一部作品');
  const draft = { width: 1280, height: 720, fps: 24, expectedVersion: 0, clips: [{ artifactId: 'asset_1', sourceInMs: 0, durationMs: 1000, fit: 'contain', muteSource: true }], captions: [], audio: [] };
  assert.equal(timelineInput(draft).clips.length, 1);
  assert.throws(() => timelineInput({ ...draft, width: 1279 }));
  assert.throws(() => timelineInput({ ...draft, fps: NaN }));
  assert.throws(() => timelineInput({ ...draft, clips: [] }));
  assert.throws(() => timelineInput({ ...draft, captions: [{ text: 'not yet supported' }] }));
});
