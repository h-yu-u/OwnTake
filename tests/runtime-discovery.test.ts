import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { discoverLocalRuntimes, parseLocalModelCatalog } from '../packages/runtimes/src/discovery.ts';
import { localEnvironment } from '../packages/runtimes/src/local-process.ts';
import { startServer } from '../apps/server/src/app.ts';

const fixture = new URL('./fixtures/local-cli.mjs', import.meta.url);
async function install(root: string, kind: 'codex-cli' | 'claude-code', extra: object = {}): Promise<string> {
  const directory = join(root, kind), command = kind === 'codex-cli' ? 'codex' : 'claude';
  await mkdir(directory, { recursive: true });
  const source = join(directory, 'fixture.mjs');
  await copyFile(fixture, source); await chmod(source, 0o700);
  await symlink(source, join(directory, command));
  await writeFile(join(directory, 'fixture-settings.json'), JSON.stringify({ kind, ...extra }));
  return directory;
}
async function logs(directory: string): Promise<{ check?: string; run?: boolean; args?: string[] }[]> {
  return (await readFile(join(directory, 'invocations.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
}

test('model catalog accepts only bounded public model fields and omits hidden, injected and duplicate entries', () => {
  const result = parseLocalModelCatalog({ identity: 'private-account', models: [
    { slug: 'model-a', display_name: '模型 A', private: 'secret' }, { slug: 'model-a', display_name: '模型 A' },
    { slug: '--tools' }, { slug: 'model\nsecret' }, { slug: 'hidden', visibility: 'hide' },
    { slug: 'provider/model-b', display_name: '<valid text>' }, { slug: 'model-c', display_name: 'bad\nname' }, null,
  ] });
  assert.deepEqual(result, [{ id: 'model-a', label: '模型 A' }, { id: 'provider/model-b', label: '<valid text>' }, { id: 'model-c', label: 'model-c' }]);
  for (const invalid of [null, [], {}, { models: 'invalid' }, { models: Array(1001).fill({ slug: 'a' }) }]) assert.deepEqual(parseLocalModelCatalog(invalid), []);
});

test('model reasoning levels come from the catalog, filter unknown/delegating values and validate defaults', () => {
  const models = parseLocalModelCatalog({ models: [
    { slug: 'model-a', supported_reasoning_levels: [{ effort: 'high' }, { effort: 'low' }, { effort: 'ultra' }, { effort: '--tools' }, { effort: 'high' }, null], default_reasoning_level: 'low' },
    { slug: 'model-b', supported_reasoning_levels: [{ effort: 'medium' }], default_reasoning_level: 'high' },
  ] });
  assert.deepEqual(models[0], { id: 'model-a', label: 'model-a', reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'low' });
  assert.deepEqual(models[1], { id: 'model-b', label: 'model-b', reasoningEfforts: ['medium'] });
});

test('discovery uses fixed executable names, resolves symlinks, prioritizes PATH and reads only model cache fields', async t => {
  const root = await mkdtemp(join(tmpdir(), 'owntake 检测 $;-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const codex = await install(root, 'codex-cli'), claude = await install(root, 'claude-code');
  const other = await install(join(root, 'other'), 'codex-cli');
  const cache = join(root, 'cache'); await mkdir(cache);
  await writeFile(join(cache, 'models_cache.json'), JSON.stringify({ identity: 'private-account', models: [{ slug: 'local-model', display_name: '本地模型' }] }));
  const found = await discoverLocalRuntimes({ searchDirectories: ['', '.', join(root, 'missing'), codex, claude, other], codexHome: cache });
  assert.equal(found.length, 2);
  assert.equal(found[0]!.binaryPath, join(codex, 'codex'));
  assert.equal(found[0]!.inspection.compatible, true);
  assert.equal(found[0]!.modelSource, 'local-cache');
  assert.deepEqual(found[0]!.models, [{ id: 'local-model', label: '本地模型' }]);
  assert.equal(found[1]!.modelSource, 'aliases');
  assert.deepEqual(found[1]!.models.map(model => model.id), ['sonnet', 'opus', 'haiku']);
  assert(!JSON.stringify(found).includes('private-account'));
  for (const dir of [codex, claude]) assert.deepEqual((await logs(dir)).map(entry => entry.check), ['version', 'help']);
  await assert.rejects(readFile(join(other, 'invocations.jsonl')), { code: 'ENOENT' });
  assert(found.every(runtime => runtime.inspection.authentication === 'not_checked'));
});

test('missing, oversized and symlinked caches fall back to a help-verified offline bundled catalog', async t => {
  const root = await mkdtemp(join(tmpdir(), 'owntake-discovery-fallback-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const codex = await install(root, 'codex-cli', { bundledModels: [{ slug: 'bundled-model' }] });
  const cache = join(root, 'cache'); await mkdir(cache);
  const cachePath = join(cache, 'models_cache.json');
  const options = { searchDirectories: [codex], codexHome: cache };
  for (const mode of ['missing', 'malformed', 'oversized', 'symlink']) {
    await rm(cachePath, { force: true });
    if (mode === 'malformed') await writeFile(cachePath, '{');
    if (mode === 'oversized') await writeFile(cachePath, ' '.repeat(2 * 1024 * 1024 + 1));
    if (mode === 'symlink') {
      const privatePath = join(root, 'must-not-read.json');
      await writeFile(privatePath, JSON.stringify({ models: [{ slug: 'private-model' }] }));
      await symlink(privatePath, cachePath);
    }
    const found = await discoverLocalRuntimes(options);
    assert.equal(found[0]!.modelSource, 'bundled', mode);
    assert.deepEqual(found[0]!.models, [{ id: 'bundled-model', label: 'bundled-model' }]);
  }
  const calls = await logs(codex);
  assert(calls.every(entry => !entry.run));
  assert.equal(calls.filter(entry => entry.check === 'bundled').length, 4);
  assert(calls.filter(entry => entry.check === 'bundled').every(entry => entry.args?.join(' ') === 'debug models --bundled'));
});

test('unsupported model discovery and incompatible binaries remain diagnosable without invoking a model', async t => {
  const root = await mkdtemp(join(tmpdir(), 'owntake-discovery-errors-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const codex = await install(root, 'codex-cli', { missingFlag: '--ignore-user-config' });
  const options = { searchDirectories: [codex], codexHome: root };
  const found = await discoverLocalRuntimes(options);
  assert.equal(found[0]!.inspection.available, true);
  assert.equal(found[0]!.inspection.compatible, false);
  assert.match(found[0]!.inspection.error!, /--ignore-user-config/);
  assert.equal(found[0]!.modelSource, 'unavailable');
  assert((await logs(codex)).every(entry => !entry.run));
  assert.deepEqual(await discoverLocalRuntimes({ searchDirectories: [join(root, 'missing')], codexHome: root }), []);
});

test('desktop subprocess environment includes the chosen nvm bin, excludes cwd and keeps credentials out', () => {
  const binary = '/some nvm/versions/node/v24.0.0/bin/codex';
  const environment = localEnvironment('codex-cli', binary);
  assert.equal(environment.PATH?.split(delimiter)[0], dirname(binary));
  assert(!environment.PATH?.split(delimiter).some(path => path === '' || path === '.'));
  assert.equal(environment.OPENAI_API_KEY, undefined);
  assert.equal(environment.ANTHROPIC_API_KEY, undefined);
  assert.equal(environment.NODE_OPTIONS, undefined);
});

test('discovery endpoint requires a local session and CSRF before scanning or creating configuration', async t => {
  const root = await mkdtemp(join(tmpdir(), 'owntake-discovery-security-'));
  const app = await startServer({ dataDir: root, port: 0 });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const url = app.url + '/api/runtimes/discover';
  assert.equal((await fetch(url, { method: 'POST' })).status, 401);
  const session = await fetch(app.url + '/api/session');
  const cookie = session.headers.get('set-cookie')!.split(';')[0]!;
  assert.equal((await fetch(url, { method: 'POST', headers: { Cookie: cookie } })).status, 403);
  assert.equal(app.runtimes.list().length, 0);
});
