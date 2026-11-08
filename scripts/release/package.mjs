import { execFileSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { artifactNames, assertNative, assertVersion, nativeTarget, targetById } from './targets.mjs';
import { builderConfiguration, signingEnvironment, signingMode } from './config.mjs';
import { digestFile, writeJson } from './integrity.mjs';
import { installedElectron } from './installed-electron.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { values } = parseArgs({ options: { target: { type: 'string' }, platform: { type: 'string' } }, strict: true });
const target = values.target ? targetById(values.target) : nativeTarget(values.platform ?? process.platform);
assertNative(target);
process.chdir(root);
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
assertVersion(pkg.version);
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const sourceDirty = Boolean(execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim());
if (sourceDirty) throw new Error('Commit tracked changes before producing a release artifact');
for (const file of ['apps/desktop/dist/main.mjs', 'apps/desktop/dist/preload.cjs', 'apps/desktop/dist/service.mjs', 'apps/web/dist/index.html']) await readFile(file);
const environment = signingEnvironment(process.env);
const configuration = builderConfiguration(target, environment);
configuration.electronDist = await installedElectron(root, target, pkg.devDependencies.electron);
configuration.electronVersion = pkg.devDependencies.electron;
const signing = signingMode(target, environment);
console.log(`[package] ${target.id} · ${pkg.version} · ${signing}`);
if (['unsigned', 'ad-hoc'].includes(signing)) console.warn('[package] No trusted publisher certificate. These artifacts are not notarized/Authenticode-signed.');
// Apply only the removed empty credentials at the CLI boundary. electron-builder
// reads process.env itself and treats a defined CSC_LINK='' as a certificate path.
for (const key of Object.keys(process.env)) {
  if (!Object.hasOwn(environment, key)) delete process.env[key];
}
// Never let electron-builder infer publishing permission from a tag or GH_TOKEN.
const builder = await import('electron-builder');
const platform = target.platform === 'darwin' ? builder.Platform.MAC : target.platform === 'win32' ? builder.Platform.WINDOWS : builder.Platform.LINUX;
const built = await builder.build({ targets: platform.createTarget(target.formats, builder.Arch[target.arch]), config: configuration, publish: 'never' });
const emitted = new Set(built.map(file => basename(file)));
const files = [];
for (const name of artifactNames(target)) {
  if (!emitted.has(name)) throw new Error(`Builder did not emit the required artifact: ${name}`);
  files.push({ name, ...await digestFile(resolve('release', name)) });
}
await mkdir('release', { recursive: true });
await writeJson(`release/manifest-${target.id}.json`, { schema: 1, target: target.id, version: pkg.version, commit, sourceDirty, signing, files, smoke: { status: 'pending' } });
