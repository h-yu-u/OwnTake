import test from 'node:test';
import assert from 'node:assert/strict';
import { TARGETS, artifactNames } from './targets.mjs';
import { formatReleaseNotes, readVersionChanges } from './notes.mjs';

const release = {
  tag: 'v0.1.0', version: '0.1.0', commit: 'a'.repeat(40),
  artifacts: TARGETS.flatMap(target => artifactNames(target).map(name => ({
    target: target.id, name, signing: target.platform === 'darwin' ? 'ad-hoc' : 'unsigned',
  }))),
};

test('versioned notes include all verified downloads and actual signing modes', async () => {
  const changes = await readVersionChanges(release.tag, release.version);
  const notes = formatReleaseNotes(release, changes);
  assert.equal(formatReleaseNotes(release, changes.replace(/\n/g, '\r\n')), notes);
  for (const file of release.artifacts) assert.ok(notes.includes(`/v0.1.0/${file.name})`));
  assert.ok(notes.includes('ad-hoc'));
  assert.ok(notes.includes('unsigned'));
  assert.ok(notes.includes(`/commit/${release.commit}`));
  assert.doesNotMatch(notes, /maintainer: replace|placeholder|TODO|待填写/i);
});

test('wrong version, incomplete evidence and unfinished copy block release notes', async () => {
  const changes = await readVersionChanges(release.tag, release.version);
  assert.throws(() => formatReleaseNotes(release, changes.replace('v0.1.0', 'v0.2.0')), /exact version/);
  assert.throws(() => formatReleaseNotes(release, `${changes}\nTODO: finish notes`), /placeholders/);
  assert.throws(() => formatReleaseNotes({ ...release, artifacts: release.artifacts.slice(1) }, changes), /Incomplete/);
  await assert.rejects(() => readVersionChanges('v0.2.0', '0.2.0'), /ENOENT/);
  await assert.rejects(() => readVersionChanges('../../other', '0.1.0'), /Tag must/);
});
