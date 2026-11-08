import { execFile } from 'node:child_process';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { TARGETS, artifactNames, assertReleaseTag } from './targets.mjs';
import { digestFile, readManifest } from './integrity.mjs';

const executeFile = promisify(execFile);
const INDEX_FILES = ['SHA256SUMS', 'release-manifest.json'];
const NOTES_FILE = 'release-notes.md';
const RELEASE_QUERY = 'query($owner: String!, $name: String!, $tag: String!) { repository(owner: $owner, name: $name) { release(tagName: $tag) { databaseId } } }';
const TAG_QUERY = 'query($owner: String!, $name: String!, $ref: String!) { repository(owner: $owner, name: $name) { ref(qualifiedName: $ref) { id } } }';
const sameNames = (left, right) => JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
const normalizeNotes = value => typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim() : null;

/** A new tag may only be planned by an explicit manual run from its selected main commit. */
export function planReleaseSource({ tag, eventName, ref, selectedCommit, existingTagCommit = null, createTag = false }) {
  assertReleaseTag(tag, typeof tag === 'string' ? tag.slice(1) : undefined);
  if (!/^[a-f0-9]{40}$/.test(selectedCommit ?? '') || typeof createTag !== 'boolean') throw new Error('Invalid selected release source');
  if (!['push', 'workflow_dispatch'].includes(eventName)) throw new Error('Unsupported release event');
  if (createTag && (eventName !== 'workflow_dispatch' || ref !== 'refs/heads/main')) throw new Error('Creating a release tag requires a manual run from main');
  if (eventName === 'push' && (ref !== `refs/tags/${tag}` || existingTagCommit !== selectedCommit)) throw new Error('Tag push does not match the selected source commit');
  if (existingTagCommit !== null) {
    if (!/^[a-f0-9]{40}$/.test(existingTagCommit) || (createTag && existingTagCommit !== selectedCommit)) throw new Error('Existing tag points elsewhere; tags are never moved');
    return { commit: existingTagCommit, createTag: false };
  }
  if (!createTag) throw new Error('An existing version tag is required unless create_tag is explicitly enabled');
  return { commit: selectedCommit, createTag: true };
}

/** GitHub may omit a digest, but an available digest must agree with the local bytes. */
export function verifyUploadedAssets(expected, actual) {
  if (!Array.isArray(expected) || expected.length === 0 || expected.some(file =>
    typeof file?.name !== 'string' || !Number.isSafeInteger(file.size) || file.size <= 0 || !/^[a-f0-9]{64}$/.test(file.sha256 ?? '')) ||
    new Set(expected.map(file => file.name)).size !== expected.length) throw new Error('Invalid expected release assets');
  if (!Array.isArray(actual) || !sameNames(actual.map(file => file?.name), expected.map(file => file.name))) {
    throw new Error('Remote release assets are missing, duplicated or unexpected');
  }
  const files = new Map(expected.map(file => [file.name, file]));
  let digestCount = 0;
  for (const asset of actual) {
    const file = files.get(asset.name);
    if (asset.state !== 'uploaded' || asset.size !== file.size) throw new Error(`Remote upload is incomplete: ${file.name}`);
    if (asset.digest != null) {
      if (asset.digest !== `sha256:${file.sha256}`) throw new Error(`Remote upload digest mismatch: ${file.name}`);
      digestCount += 1;
    }
  }
  return { assetCount: expected.length, digestCount };
}

/** Read only the assembled, complete release set; never upload a directory glob. */
export async function preparePublication(directory, tag, commit) {
  if (!/^[a-f0-9]{40}$/.test(commit ?? '')) throw new Error('A full expected release commit is required');
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Release directory must be a regular directory');
  const entries = await readdir(directory, { withFileTypes: true });
  const targetFiles = TARGETS.flatMap(target => artifactNames(target).map(name => ({ name, target: target.id })));
  const names = [...targetFiles.map(file => file.name), ...INDEX_FILES].sort();
  if (entries.some(entry => !entry.isFile() || entry.isSymbolicLink()) || !sameNames(entries.map(entry => entry.name), [...names, NOTES_FILE])) {
    throw new Error('Release directory must contain exactly the complete packages, indexes and notes');
  }
  const manifest = await readManifest(join(directory, 'release-manifest.json'));
  assertReleaseTag(tag, manifest?.version);
  if (manifest.schema !== 1 || manifest.tag !== tag || manifest.commit !== commit || manifest.nativeSmokePassed !== true) {
    throw new Error('Release manifest does not match the verified tag, commit and native smoke results');
  }
  if (!Array.isArray(manifest.artifacts) || !sameNames(manifest.artifacts.map(file => file?.name), targetFiles.map(file => file.name))) {
    throw new Error('Release manifest does not contain every native package exactly once');
  }
  const artifacts = new Map(manifest.artifacts.map(file => [file.name, file]));
  const assets = [];
  for (const name of names) assets.push({ name, ...await digestFile(join(directory, name)) });
  for (const file of targetFiles) {
    const recorded = artifacts.get(file.name), actual = assets.find(asset => asset.name === file.name);
    if (recorded.target !== file.target || recorded.size !== actual.size || recorded.sha256 !== actual.sha256) {
      throw new Error(`Assembled package changed: ${file.name}`);
    }
  }
  const checksums = manifest.artifacts.slice().sort((a, b) => a.name.localeCompare(b.name)).map(file => `${file.sha256}  ${file.name}`).join('\n') + '\n';
  if (await readFile(join(directory, 'SHA256SUMS'), 'utf8') !== checksums) throw new Error('SHA256SUMS does not match the release manifest');
  const notes = await readFile(join(directory, NOTES_FILE), 'utf8');
  if (!notes.trim() || notes.includes('Maintainer: replace this section') || notes.includes('发布草稿前填写本版本')) {
    throw new Error('Concrete release notes are required before uploading');
  }
  return { directory, tag, commit, notes, assets, prerelease: tag.includes('-') };
}

async function runGh(args) {
  const { stdout } = await executeFile('gh', args, {
    encoding: 'utf8', maxBuffer: 2 * 1024 * 1024,
    timeout: args[0] === 'release' ? 20 * 60 * 1000 : 60 * 1000,
    env: { ...process.env, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1' },
  });
  return stdout;
}

async function githubJson(gh, endpoint, args = []) {
  return JSON.parse(await gh(['api', endpoint, '--hostname', 'github.com', ...args]));
}

async function releaseId(gh, repository, tag) {
  const [owner, name] = repository.split('/');
  // REST's /releases/tags endpoint excludes pending drafts; use the same lookup as gh release view.
  const response = await githubJson(gh, 'graphql', [
    '--raw-field', `query=${RELEASE_QUERY}`, '--raw-field', `owner=${owner}`,
    '--raw-field', `name=${name}`, '--raw-field', `tag=${tag}`,
  ]);
  if (response.errors?.length || !response.data?.repository) throw new Error('Could not verify existing releases');
  const release = response.data.repository.release;
  if (release === null) return null;
  if (!Number.isSafeInteger(release?.databaseId) || release.databaseId <= 0) throw new Error('Invalid release identity');
  return release.databaseId;
}

async function verifyRemoteTag(gh, repository, release) {
  const remote = await githubJson(gh, `repos/${repository}/commits/${encodeURIComponent(`refs/tags/${release.tag}`)}`);
  if (remote.sha !== release.commit) throw new Error('Remote tag no longer points to the verified source commit');
}

async function createVerifiedTag(gh, repository, release) {
  const comparison = await githubJson(gh, `repos/${repository}/compare/${release.commit}...main`);
  if (!['identical', 'ahead'].includes(comparison.status) || comparison.merge_base_commit?.sha !== release.commit) {
    throw new Error('A new release tag must point to a commit that still belongs to main');
  }
  const [owner, name] = repository.split('/');
  const response = await githubJson(gh, 'graphql', [
    '--raw-field', `query=${TAG_QUERY}`, '--raw-field', `owner=${owner}`,
    '--raw-field', `name=${name}`, '--raw-field', `ref=refs/tags/${release.tag}`,
  ]);
  if (response.errors?.length || !response.data?.repository || response.data.repository.ref !== null) {
    throw new Error('Release tag already exists or could not be checked; existing tags are never moved');
  }
  // POST is create-only: a concurrent creator makes this fail instead of moving its tag.
  await githubJson(gh, `repos/${repository}/git/refs`, [
    '--method', 'POST', '--raw-field', `ref=refs/tags/${release.tag}`, '--raw-field', `sha=${release.commit}`,
  ]);
}

function verifyRemoteRelease(remote, id, release, draft) {
  if (remote?.id !== id || remote.tag_name !== release.tag || remote.draft !== draft || remote.prerelease !== release.prerelease ||
    remote.target_commitish !== release.commit || remote.name !== `OwnTake ${release.tag}` || normalizeNotes(remote.body) !== normalizeNotes(release.notes)) {
    throw new Error('Remote release identity, notes or publication state changed');
  }
  return verifyUploadedAssets(release.assets, remote.assets);
}

/** A failed upload/verification stays a draft. Existing releases are never edited or overwritten. */
export async function publishRelease({ repository, tag, commit, directory, publish = false, createTag = false }, { gh = runGh } = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repository ?? '')) throw new Error('Repository must be owner/name');
  if (typeof publish !== 'boolean' || typeof createTag !== 'boolean') throw new Error('Publication and tag creation must be explicit booleans');
  const release = await preparePublication(resolve(directory), tag, commit);
  if (await releaseId(gh, repository, tag) !== null) throw new Error('A release or draft already exists for this tag; nothing will be overwritten');
  if (createTag) await createVerifiedTag(gh, repository, release);
  await verifyRemoteTag(gh, repository, release);
  await gh([
    'release', 'create', tag, ...release.assets.map(file => join(release.directory, file.name)),
    '--repo', `github.com/${repository}`, '--verify-tag', '--draft', '--target', commit,
    '--title', `OwnTake ${tag}`, '--notes-file', join(release.directory, NOTES_FILE),
    ...(release.prerelease ? ['--prerelease'] : []),
  ]);
  const id = await releaseId(gh, repository, tag);
  if (id === null) throw new Error('Uploaded draft could not be found; inspect the release before retrying');
  const endpoint = `repos/${repository}/releases/${id}`;
  const draft = await githubJson(gh, endpoint);
  let verification = verifyRemoteRelease(draft, id, release, true);
  if (publish) {
    await verifyRemoteTag(gh, repository, release);
    await githubJson(gh, endpoint, ['--method', 'PATCH', '--field', 'draft=false', '--raw-field', `make_latest=${release.prerelease ? 'false' : 'legacy'}`]);
    const published = await githubJson(gh, endpoint);
    verification = verifyRemoteRelease(published, id, release, false);
  }
  return { tag, id, draft: !publish, url: `https://github.com/${repository}/releases/tag/${tag}`, ...verification };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    for (const key of ['RELEASE_PUBLISH', 'RELEASE_CREATE_TAG']) {
      if (process.env[key] !== undefined && !['true', 'false'].includes(process.env[key])) throw new Error(`${key} must be true or false`);
    }
    const { values } = parseArgs({
      options: {
        directory: { type: 'string', default: 'release-ready' },
        repository: { type: 'string', default: process.env.GH_REPO },
        tag: { type: 'string', default: process.env.RELEASE_TAG },
        commit: { type: 'string', default: process.env.RELEASE_COMMIT },
        publish: { type: 'boolean', default: process.env.RELEASE_PUBLISH === 'true' },
        'create-tag': { type: 'boolean', default: process.env.RELEASE_CREATE_TAG === 'true' },
      }, strict: true,
    });
    const result = await publishRelease({ ...values, createTag: values['create-tag'] });
    console.log(`[release] ${result.draft ? 'Verified draft' : 'Published'}: ${result.url} (${result.assetCount} uploads verified; ${result.digestCount} remote SHA256 digests available)`);
  } catch (error) { console.error(`[release] ${error.message}`); process.exitCode = 1; }
}
