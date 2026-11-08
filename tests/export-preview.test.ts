import test from 'node:test';
import assert from 'node:assert/strict';
import { exportPreviewStatus } from '../apps/web/src/lib/export-preview.ts';

test('a playable earlier export stays outdated when saved audio or unsaved edits change the timeline', () => {
  const silentOutput = { metadata: { timelineId: 'silent-v1' } };
  assert.equal(exportPreviewStatus(silentOutput, { id: 'with-audio-v3' }, false), 'outdated');
  assert.equal(exportPreviewStatus(silentOutput, { id: 'silent-v1' }, true), 'draft_changed');
  assert.equal(exportPreviewStatus({ metadata: { timelineId: 'with-audio-v3' } }, { id: 'with-audio-v3' }, false), 'current');
});

test('missing or legacy provenance never claims that an output contains the current edits', () => {
  assert.equal(exportPreviewStatus(undefined, { id: 'v3' }, false), 'missing');
  assert.equal(exportPreviewStatus({ metadata: {} }, { id: 'v3' }, false), 'unverified');
  assert.equal(exportPreviewStatus({ metadata: { timelineId: 3 } }, { id: 'v3' }, false), 'unverified');
  assert.equal(exportPreviewStatus({ metadata: { timelineId: 'v1' } }, null, false), 'unverified');
});
