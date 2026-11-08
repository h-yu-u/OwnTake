import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TARGETS, artifactNames } from './targets.mjs';
import { digestFile, writeJson } from './integrity.mjs';
import { planReleaseSource, preparePublication, publishRelease, verifyUploadedAssets } from './publish.mjs';

const commit = 'a'.repeat(40), repository = 'h-yu-u/OwnTake';

async function fixture(t, tag = 'v0.1.0') {
  const directory = await mkdtemp(join(tmpdir(), 'owntake publish test '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const artifacts = [];
  for (const target of TARGETS) {
    for (const name of artifactNames(target)) {
      await writeFile(join(directory, name), `fixture package: ${name}`);
      artifacts.push({ name, target: target.id, signing: target.platform === 'darwin' ? 'ad-hoc' : 'unsigned', ...await digestFile(join(directory, name)) });
    }
  }
  artifacts.sort((a, b) => a.name.localeCompare(b.name));
  await writeJson(join(directory, 'release-manifest.json'), { schema: 1, tag, version: tag.slice(1), commit, nativeSmokePassed: true, artifacts });
  await writeFile(join(directory, 'SHA256SUMS'), artifacts.map(file => `${file.sha256}  ${file.name}`).join('\n') + '\n');
  await writeFile(join(directory, 'release-notes.md'), `# OwnTake ${tag}\n\n## Features\n\n- First desktop release.\n\n<!-- lang:zh -->\n\n## 新增\n\n- 首个桌面版本。\n`);
  const release = await preparePublication(directory, tag, commit);
  return { directory, tag, commit, repository, release };
}

const uploadedAssets = expected => expected.map(file => ({ name: file.name, size: file.size, state: 'uploaded', digest: `sha256:${file.sha256}` }));

function fakeGithub(f, behavior = {}) {
  const calls = [];
  let created = false, published = false;
  const snapshot = () => ({
    id: 123, tag_name: f.tag, draft: !published, prerelease: f.release.prerelease,
    target_commitish: commit, name: `OwnTake ${f.tag}`, body: f.release.notes,
    assets: behavior.assets ? behavior.assets(uploadedAssets(f.release.assets)) : uploadedAssets(f.release.assets),
    ...behavior.releasePatch,
  });
  const gh = async args => {
    calls.push(args);
    if (args[0] === 'release' && args[1] === 'create') {
      created = true;
      if (behavior.uploadError) throw new Error('Upload interrupted');
      return `https://github.com/${repository}/releases/tag/${f.tag}\n`;
    }
    assert.equal(args[0], 'api');
    if (args[1] === 'graphql') {
      if (behavior.lookupError) throw new Error('GitHub lookup unavailable');
      if (args.some(arg => arg.includes('ref(qualifiedName:'))) {
        return JSON.stringify({ data: { repository: { ref: behavior.tagExists ? { id: 'existing-tag' } : null } } });
      }
      return JSON.stringify({ data: { repository: { release: created || behavior.exists ? { databaseId: 123 } : null } } });
    }
    if (args[1] === `repos/${repository}/compare/${commit}...main`) {
      return JSON.stringify({ status: behavior.sourceNotMain ? 'diverged' : 'ahead', merge_base_commit: { sha: commit } });
    }
    if (args[1] === `repos/${repository}/git/refs`) {
      assert.ok(args.includes('POST'));
      return JSON.stringify({ ref: `refs/tags/${f.tag}`, object: { sha: commit } });
    }
    if (args[1] === `repos/${repository}/commits/${encodeURIComponent(`refs/tags/${f.tag}`)}`) {
      return JSON.stringify({ sha: behavior.movedTag && created ? 'b'.repeat(40) : commit });
    }
    assert.equal(args[1], `repos/${repository}/releases/123`);
    if (args.includes('PATCH')) published = true;
    return JSON.stringify(snapshot());
  };
  return { calls, gh };
}

const creates = calls => calls.filter(args => args[0] === 'release' && args[1] === 'create');
const publishes = calls => calls.filter(args => args.includes('PATCH'));
const tagCreates = calls => calls.filter(args => args.includes('POST') && args[1].endsWith('/git/refs'));

test('only an explicit manual main run may plan a new version tag', () => {
  const source = { tag: 'v0.1.0', eventName: 'workflow_dispatch', ref: 'refs/heads/main', selectedCommit: commit, createTag: true };
  assert.deepEqual(planReleaseSource(source), { commit, createTag: true });
  assert.deepEqual(planReleaseSource({ ...source, existingTagCommit: commit }), { commit, createTag: false });
  for (const patch of [
    { ref: 'refs/heads/feature' }, { ref: 'refs/tags/v0.1.0' },
    { eventName: 'push' }, { eventName: 'pull_request' }, { createTag: false },
    { existingTagCommit: 'b'.repeat(40) }, { selectedCommit: 'main' }, { tag: 'v0.1.0\nextra=true' },
  ]) assert.throws(() => planReleaseSource({ ...source, ...patch }));
});

test('existing tags remain selectable manually and pushed tags match the event commit', () => {
  const source = { tag: 'v0.1.0', eventName: 'workflow_dispatch', ref: 'refs/heads/main', selectedCommit: 'b'.repeat(40), existingTagCommit: commit };
  assert.deepEqual(planReleaseSource(source), { commit, createTag: false });
  const pushed = { ...source, eventName: 'push', ref: 'refs/tags/v0.1.0', selectedCommit: commit };
  assert.deepEqual(planReleaseSource(pushed), { commit, createTag: false });
  assert.throws(() => planReleaseSource({ ...pushed, existingTagCommit: 'b'.repeat(40) }), /Tag push/);
});

test('remote verification requires exact names, complete upload state and byte sizes', () => {
  const expected = [{ name: 'package.zip', size: 123, sha256: 'a'.repeat(64) }];
  const valid = uploadedAssets(expected);
  assert.deepEqual(verifyUploadedAssets(expected, valid), { assetCount: 1, digestCount: 1 });
  for (const assets of [[], [...valid, ...valid], [{ ...valid[0], name: 'other.zip' }]]) {
    assert.throws(() => verifyUploadedAssets(expected, assets), /missing, duplicated or unexpected/);
  }
  for (const patch of [{ size: 122 }, { size: '123' }, { state: 'starter' }]) {
    assert.throws(() => verifyUploadedAssets(expected, [{ ...valid[0], ...patch }]), /incomplete/);
  }
});

test('remote SHA256 must match when present and older responses may omit it', () => {
  const expected = [{ name: 'package.zip', size: 123, sha256: 'a'.repeat(64) }];
  const valid = uploadedAssets(expected);
  for (const digest of [null, undefined]) assert.deepEqual(verifyUploadedAssets(expected, [{ ...valid[0], digest }]), { assetCount: 1, digestCount: 0 });
  for (const digest of ['sha256:' + 'b'.repeat(64), 'sha512:' + 'a'.repeat(64), '']) {
    assert.throws(() => verifyUploadedAssets(expected, [{ ...valid[0], digest }]), /digest mismatch/);
  }
  assert.throws(() => verifyUploadedAssets([...expected, ...expected], valid), /Invalid expected/);
});

test('draft creation uploads the twelve packages and both indexes without exposing notes as an asset', async t => {
  const f = await fixture(t), remote = fakeGithub(f, { releasePatch: { body: f.release.notes.replaceAll('\n', '\r\n') } });
  const result = await publishRelease(f, remote);
  assert.equal(result.draft, true);
  assert.equal(result.assetCount, 14);
  assert.equal(result.digestCount, 14);
  assert.equal(creates(remote.calls).length, 1);
  assert.equal(publishes(remote.calls).length, 0);
  const creation = creates(remote.calls)[0];
  assert.deepEqual(creation.slice(3, 17), f.release.assets.map(file => join(f.directory, file.name)));
  assert.ok(creation.includes('--draft'));
  assert.ok(creation.includes('--verify-tag'));
  assert.equal(creation[creation.indexOf('--target') + 1], commit);
  assert.equal(creation[creation.indexOf('--notes-file') + 1], join(f.directory, 'release-notes.md'));
  assert.ok(remote.calls.every(args => !args.includes('--clobber')));
});

test('publishing verifies the draft first, rechecks the tag and updates only its release ID', async t => {
  const f = await fixture(t), remote = fakeGithub(f);
  const result = await publishRelease({ ...f, publish: true }, remote);
  assert.equal(result.draft, false);
  assert.equal(result.url, `https://github.com/${repository}/releases/tag/${f.tag}`);
  const mutation = publishes(remote.calls);
  assert.equal(mutation.length, 1);
  assert.equal(mutation[0][1], `repos/${repository}/releases/123`);
  assert.ok(mutation[0].includes('draft=false'));
  assert.ok(mutation[0].includes('make_latest=legacy'));
  const index = remote.calls.indexOf(mutation[0]);
  assert.equal(remote.calls[index - 1][1], `repos/${repository}/commits/${encodeURIComponent(`refs/tags/${f.tag}`)}`);
  assert.equal(remote.calls[index - 2][1], `repos/${repository}/releases/123`);
  assert.equal(remote.calls.at(-1)[1], `repos/${repository}/releases/123`);
  assert.ok(!remote.calls.at(-1).includes('PATCH'));
});

test('a prerelease is marked explicitly and cannot replace the stable Latest release', async t => {
  const f = await fixture(t, 'v0.1.0-rc.1'), remote = fakeGithub(f);
  await publishRelease({ ...f, publish: true }, remote);
  assert.ok(creates(remote.calls)[0].includes('--prerelease'));
  assert.ok(publishes(remote.calls)[0].includes('make_latest=false'));
});

test('an explicitly requested tag is created only for the complete checked main commit', async t => {
  const f = await fixture(t), remote = fakeGithub(f);
  await publishRelease({ ...f, createTag: true, publish: true }, remote);
  const creation = tagCreates(remote.calls);
  assert.equal(creation.length, 1);
  assert.ok(creation[0].includes(`ref=refs/tags/${f.tag}`));
  assert.ok(creation[0].includes(`sha=${commit}`));
  assert.ok(remote.calls.indexOf(creation[0]) < remote.calls.indexOf(creates(remote.calls)[0]));
  assert.ok(remote.calls.every(args => !args.some(arg => arg.startsWith('force='))));
  assert.equal(publishes(remote.calls).length, 1);
});

test('a tag appearing during builds or a source removed from main blocks tag creation', async t => {
  const f = await fixture(t);
  for (const behavior of [{ tagExists: true }, { sourceNotMain: true }]) {
    const remote = fakeGithub(f, behavior);
    await assert.rejects(() => publishRelease({ ...f, createTag: true, publish: true }, remote), /never moved|still belongs to main/);
    assert.equal(tagCreates(remote.calls).length, 0);
    assert.equal(creates(remote.calls).length, 0);
    assert.equal(publishes(remote.calls).length, 0);
  }
});

test('an existing draft or release and a failed existence lookup both block creation', async t => {
  const f = await fixture(t);
  for (const behavior of [{ exists: true }, { lookupError: true }]) {
    const remote = fakeGithub(f, behavior);
    await assert.rejects(() => publishRelease({ ...f, publish: true }, remote), /already exists|lookup unavailable/);
    assert.equal(creates(remote.calls).length, 0);
    assert.equal(publishes(remote.calls).length, 0);
  }
});

test('an interrupted or incorrect upload never publishes or deletes the diagnostic draft', async t => {
  const f = await fixture(t);
  for (const behavior of [
    { uploadError: true },
    { assets: assets => assets.slice(1) },
    { assets: assets => assets.map((asset, i) => i ? asset : { ...asset, digest: 'sha256:' + 'b'.repeat(64) }) },
    { releasePatch: { body: 'Changed notes' } },
    { movedTag: true },
  ]) {
    const remote = fakeGithub(f, behavior);
    await assert.rejects(() => publishRelease({ ...f, publish: true }, remote));
    assert.equal(creates(remote.calls).length, 1);
    assert.equal(publishes(remote.calls).length, 0);
    assert.ok(remote.calls.every(args => !args.includes('delete') && !args.includes('DELETE')));
  }
});

test('mismatched source, tampered package and checksum index fail before remote side effects', async t => {
  const f = await fixture(t), remote = fakeGithub(f);
  await assert.rejects(() => publishRelease({ ...f, commit: 'b'.repeat(40) }, remote), /verified tag, commit/);
  await assert.rejects(() => publishRelease({ ...f, tag: 'v0.1.0; echo no' }, remote), /Tag must/);
  const file = join(f.directory, f.release.assets.find(asset => asset.name.endsWith('.dmg')).name);
  const original = await readFile(file);
  await writeFile(file, Buffer.alloc(original.length, 42));
  await assert.rejects(() => publishRelease(f, remote), /package changed/);
  await writeFile(file, original);
  await writeFile(join(f.directory, 'SHA256SUMS'), 'incorrect checksums\n');
  await assert.rejects(() => publishRelease(f, remote), /SHA256SUMS/);
  assert.equal(remote.calls.length, 0);
});

test('extra files, symlinks and placeholder notes cannot enter a release', async t => {
  const f = await fixture(t), remote = fakeGithub(f);
  const extra = join(f.directory, 'credentials.json');
  await writeFile(extra, '{}');
  await assert.rejects(() => publishRelease(f, remote), /exactly the complete/);
  await rm(extra);
  const notes = join(f.directory, 'release-notes.md');
  await rm(notes);
  await symlink(join(f.directory, 'SHA256SUMS'), notes, 'file');
  await assert.rejects(() => publishRelease(f, remote), /exactly the complete/);
  await rm(notes);
  await writeFile(notes, 'Maintainer: replace this section with concrete changes.');
  await assert.rejects(() => publishRelease(f, remote), /Concrete release notes/);
  assert.equal(remote.calls.length, 0);
});
