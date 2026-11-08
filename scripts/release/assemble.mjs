import { copyFile, mkdir, readdir, writeFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { TARGETS, assertReleaseTag } from './targets.mjs';
import { digestFile, readManifest, verifyManifest, writeJson } from './integrity.mjs';
import { formatReleaseNotes, readVersionChanges } from './notes.mjs';

/** A complete release is all native targets from ONE exact source commit and version. */
export async function assembleRelease(input, output, tag) {
  const manifests = [];
  for (const entry of await readdir(input, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error('Release input must contain only native target artifact directories');
    const directory = join(input, entry.name);
    const files = await readdir(directory);
    const names = files.filter(name => /^manifest-.+\.json$/.test(name));
    if (names.length !== 1) throw new Error(`Expected one build manifest in ${entry.name}`);
    const manifest = await readManifest(join(directory, names[0]));
    const target = await verifyManifest(directory, manifest, { requireSmoke: true });
    const expectedFiles = [...manifest.files.map(file => file.name), `manifest-${target.id}.json`].sort();
    if (JSON.stringify([...files].sort()) !== JSON.stringify(expectedFiles)) throw new Error(`Unexpected files in ${entry.name}`);
    manifests.push({ directory, manifest });
  }
  const ids = manifests.map(item => item.manifest.target).sort();
  if (JSON.stringify(ids) !== JSON.stringify(TARGETS.map(item => item.id).sort())) throw new Error('Release is incomplete or contains duplicate target builds');
  const { commit, version } = manifests[0].manifest;
  assertReleaseTag(tag, version);
  if (!manifests.every(item => item.manifest.commit === commit && item.manifest.version === version)) throw new Error('Mixed commits or versions are not a release');
  const changes = await readVersionChanges(tag, version);
  // Refuse stale output and never overwrite a previous release assembly.
  await mkdir(output, { recursive: false });
  try {
    const artifacts = [];
    for (const { directory, manifest } of manifests) {
      for (const file of manifest.files) {
        await copyFile(join(directory, file.name), join(output, file.name));
        const copied = await digestFile(join(output, file.name));
        if (copied.sha256 !== file.sha256 || copied.size !== file.size) throw new Error(`Artifact changed during assembly: ${file.name}`);
        artifacts.push({ target: manifest.target, signing: manifest.signing, ...file });
      }
    }
    artifacts.sort((a, b) => a.name.localeCompare(b.name));
    const release = { schema: 1, tag, version, commit, nativeSmokePassed: true, artifacts };
    await writeJson(join(output, 'release-manifest.json'), release);
    await writeFile(join(output, 'SHA256SUMS'), artifacts.map(file => `${file.sha256}  ${file.name}`).join('\n') + '\n');
    await writeFile(join(output, 'release-notes.md'), formatReleaseNotes(release, changes));
    return release;
  } catch (error) { await rm(output, { recursive: true, force: true }); throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { input: { type: 'string', default: 'package-downloads' }, output: { type: 'string', default: 'release-ready' }, tag: { type: 'string' } }, strict: true });
  if (!values.tag) throw new Error('--tag is required');
  const release = await assembleRelease(resolve(values.input), resolve(values.output), values.tag);
  console.log(`[release] ${release.artifacts.length} checked artifacts for ${release.tag} (${release.commit})`);
}
