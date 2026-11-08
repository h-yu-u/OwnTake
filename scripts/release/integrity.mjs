import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, realpath, writeFile, rename } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { artifactNames, assertVersion, targetById } from './targets.mjs';

export async function digestFile(file) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) throw new Error(`Not a nonempty regular file: ${file}`);
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(file)) { size += chunk.length; hash.update(chunk); }
  if (size !== stat.size) throw new Error(`File changed while hashing: ${file}`);
  return { sha256: hash.digest('hex'), size };
}
export async function writeJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await rename(temporary, file);
}
export async function verifyManifest(directory, manifest, { requireSmoke = false } = {}) {
  if (!manifest || manifest.schema !== 1 || !/^[a-f0-9]{40}$/.test(manifest.commit ?? '')) throw new Error('Invalid build manifest');
  assertVersion(manifest.version);
  const target = targetById(manifest.target);
  if (manifest.sourceDirty !== false) throw new Error('Release input must come from an unmodified commit');
  const allowedSigning = target.platform === 'darwin' ? ['ad-hoc', 'developer-id-notarized'] : target.platform === 'win32' ? ['unsigned', 'authenticode'] : ['unsigned'];
  if (!allowedSigning.includes(manifest.signing)) throw new Error('Invalid signing declaration');
  if (requireSmoke && (manifest.smoke?.status !== 'passed' || manifest.smoke.platform !== target.platform || manifest.smoke.arch !== target.arch || manifest.smoke.archive !== `owntake-${target.id}.${target.archive}`)) {
    throw new Error(`Missing native packaged-app smoke evidence: ${target.id}`);
  }
  const expected = artifactNames(target).sort();
  if (!Array.isArray(manifest.files) || JSON.stringify(manifest.files.map(file => file?.name).sort()) !== JSON.stringify(expected)) {
    throw new Error(`Unexpected, duplicate or missing artifacts for ${target.id}`);
  }
  const root = await realpath(directory);
  for (const file of manifest.files) {
    if (!/^[a-f0-9]{64}$/.test(file.sha256 ?? '') || !Number.isSafeInteger(file.size) || file.size <= 0) throw new Error('Invalid artifact digest');
    const path = resolve(root, file.name), actual = await realpath(path), rel = relative(root, actual);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Artifact escapes its directory');
    const digest = await digestFile(path);
    if (digest.sha256 !== file.sha256 || digest.size !== file.size) throw new Error(`Artifact hash mismatch: ${file.name}`);
  }
  return target;
}
export async function readManifest(path) { return JSON.parse(await readFile(path, 'utf8')); }

/** Check the executable itself, not the runner's architecture or a filename. */
export function assertExecutableArchitecture(bytes, target) {
  const need = (condition) => { if (!condition) throw new Error(`Executable format/architecture does not match ${target.id}`); };
  need(bytes.length >= 64);
  if (target.platform === 'linux') {
    need(bytes.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) && bytes[4] === 2 && bytes[5] === 1);
    need(bytes.readUInt16LE(18) === (target.arch === 'arm64' ? 183 : 62));
  } else if (target.platform === 'darwin') {
    need(bytes.readUInt32LE(0) === 0xfeedfacf);
    need(bytes.readUInt32LE(4) === (target.arch === 'arm64' ? 0x0100000c : 0x01000007));
  } else {
    need(bytes[0] === 0x4d && bytes[1] === 0x5a);
    const offset = bytes.readUInt32LE(0x3c);
    need(offset >= 64 && offset + 6 <= bytes.length && bytes.toString('ascii', offset, offset + 4) === 'PE\0\0');
    need(bytes.readUInt16LE(offset + 4) === (target.arch === 'arm64' ? 0xaa64 : 0x8664));
  }
}
