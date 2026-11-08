import { execFileSync } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, open, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { assertNative, nativeTarget, targetById } from './targets.mjs';
import { assertExecutableArchitecture, readManifest, verifyManifest, writeJson } from './integrity.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { values } = parseArgs({ options: { target: { type: 'string' } }, strict: true });
const target = values.target ? targetById(values.target) : nativeTarget();
assertNative(target);
const manifestPath = join(root, 'release', `manifest-${target.id}.json`);
const manifest = await readManifest(manifestPath);
if (manifest.target !== target.id) throw new Error('Wrong target manifest');
await verifyManifest(join(root, 'release'), manifest);
const archiveName = `owntake-${target.id}.${target.archive}`;
const archive = join(root, 'release', archiveName);
const work = await mkdtemp(join(tmpdir(), `owntake-package-${target.id}-`));
let passed = false;

async function findExecutables(directory, depth = 0) {
  if (depth > 5) return [];
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isFile() && entry.name === target.executable) found.push(path);
    if (entry.isDirectory()) found.push(...await findExecutables(path, depth + 1));
  }
  return found;
}
try {
  if (target.platform === 'darwin') execFileSync('ditto', ['-x', '-k', archive, work], { stdio: 'inherit' });
  else if (target.platform === 'win32') {
    // Paths travel in environment variables, never interpolated into PowerShell source.
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Expand-Archive -LiteralPath $env:OWNTAKE_ARCHIVE -DestinationPath $env:OWNTAKE_EXTRACT -ErrorAction Stop"], {
      stdio: 'inherit', env: { ...process.env, OWNTAKE_ARCHIVE: archive, OWNTAKE_EXTRACT: work },
    });
  } else execFileSync('tar', ['-xzf', archive, '-C', work], { stdio: 'inherit' });
  const executables = await findExecutables(work);
  if (executables.length !== 1) throw new Error(`Expected one ${target.executable} in the distribution; found ${executables.length}`);
  const executable = executables[0];
  if (!(await lstat(executable)).isFile()) throw new Error('Missing packaged executable');
  const file = await open(executable, 'r');
  const header = Buffer.alloc(4096);
  try { await file.read(header, 0, header.length, 0); } finally { await file.close(); }
  assertExecutableArchitecture(header, target);
  execFileSync(process.execPath, [join(root, 'scripts/smoke-desktop.mjs')], {
    cwd: root, stdio: 'inherit', timeout: 240_000,
    env: { ...process.env, OWNTAKE_DESKTOP_EXECUTABLE: executable,
      OWNTAKE_DESKTOP_SCREENSHOT: join(root, 'test-results', `packaged-${target.id}.png`) },
  });
  manifest.smoke = { status: 'passed', platform: process.platform, arch: process.arch, archive: archiveName };
  await verifyManifest(join(root, 'release'), manifest, { requireSmoke: true });
  await writeJson(manifestPath, manifest);
  const staged = join(root, 'release', `ready-${target.id}`);
  await mkdir(staged, { recursive: false });
  for (const item of manifest.files) await copyFile(join(root, 'release', item.name), join(staged, item.name));
  await copyFile(manifestPath, join(staged, `manifest-${target.id}.json`));
  await verifyManifest(staged, manifest, { requireSmoke: true });
  passed = true;
  console.log(`[package-smoke] ${target.id}: extracted archive, binary architecture and real Electron lifecycle passed`);
} finally {
  if (passed) await rm(work, { recursive: true, force: true });
  else console.error(`[package-smoke] Failed extraction retained for diagnosis: ${work}`);
}
