import { open, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { assertExecutableArchitecture } from './integrity.mjs';
import { assertNative } from './targets.mjs';

/** Reuse npm's verified distribution, but never accept a stale/different-CPU install. */
export async function installedElectron(root, target, expectedVersion) {
  assertNative(target);
  const directory = await realpath(join(root, 'node_modules', 'electron', 'dist'));
  const installed = JSON.parse(await readFile(join(root, 'node_modules', 'electron', 'package.json'), 'utf8'));
  const version = (await readFile(join(directory, 'version'), 'utf8')).trim().replace(/^v/, '');
  if (installed.version !== expectedVersion || version !== expectedVersion) throw new Error('Installed Electron does not match the pinned dependency; run npm ci');
  const executable = target.platform === 'darwin' ? join(directory, 'Electron.app', 'Contents', 'MacOS', 'Electron')
    : join(directory, target.platform === 'win32' ? 'electron.exe' : 'electron');
  const file = await open(executable, 'r'), header = Buffer.alloc(4096);
  try { await file.read(header, 0, header.length, 0); } finally { await file.close(); }
  assertExecutableArchitecture(header, target);
  return directory;
}
