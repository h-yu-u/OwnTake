import { execFileSync } from 'node:child_process';
import { open, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { assertExecutableArchitecture } from './integrity.mjs';
import { assertNative } from './targets.mjs';

/** Electron >=42 installs binaries on demand, not during npm ci. */
export async function installedElectron(root, target, expectedVersion) {
  assertNative(target);
  const packageDirectory = await realpath(join(root, 'node_modules', 'electron'));
  const installed = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8'));
  if (installed.version !== expectedVersion || installed.bin?.['install-electron'] !== 'install.js') {
    throw new Error('Installed Electron package does not match the pinned dependency or installer contract; run npm ci');
  }
  // Execute only the already-installed pinned package, never npx-fetch another version.
  // Its installer is idempotent and uses the package's checksums.json by default.
  const env = { ...process.env, ELECTRON_INSTALL_PLATFORM: target.platform, ELECTRON_INSTALL_ARCH: target.arch,
    npm_config_platform: target.platform, npm_config_arch: target.arch };
  for (const key of ['ELECTRON_OVERRIDE_DIST_PATH', 'electron_use_remote_checksums', 'npm_config_electron_use_remote_checksums']) delete env[key];
  execFileSync(process.execPath, [join(packageDirectory, 'install.js')], {
    cwd: root, env, stdio: 'inherit', timeout: 180_000, windowsHide: true,
  });
  const directory = await realpath(join(packageDirectory, 'dist'));
  const version = (await readFile(join(directory, 'version'), 'utf8')).trim().replace(/^v/, '');
  if (version !== expectedVersion) throw new Error('Installed Electron binary does not match the pinned dependency');
  const executable = target.platform === 'darwin' ? join(directory, 'Electron.app', 'Contents', 'MacOS', 'Electron')
    : join(directory, target.platform === 'win32' ? 'electron.exe' : 'electron');
  const file = await open(executable, 'r'), header = Buffer.alloc(4096);
  try { await file.read(header, 0, header.length, 0); } finally { await file.close(); }
  assertExecutableArchitecture(header, target);
  return directory;
}
