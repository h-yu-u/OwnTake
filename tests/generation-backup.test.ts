import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { link, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppError } from '../packages/contracts/src/errors.ts';
import type { GenerationStatus } from '../packages/contracts/src/generations.ts';
import type { GenerationPlan } from '../packages/contracts/src/providers.ts';
import { Store, restoreBackup, SCHEMA_VERSION } from '../packages/storage/src/index.ts';
import { createBackup } from '../packages/storage/src/backup.ts';
import type { BackupManifest } from '../packages/storage/src/backup.ts';
import { StoryboardStore } from '../packages/storage/src/storyboard.ts';
import { probe } from '../packages/media/src/index.ts';
import { GenerationRepository } from '../apps/server/src/generation-repository.ts';
import type { StoredGeneration } from '../apps/server/src/generation-repository.ts';
import { ProviderRepository } from '../apps/server/src/provider-repository.ts';
import { startServer } from '../apps/server/src/app.ts';

function backupInvalid(error: unknown): boolean { return error instanceof AppError && error.code === 'BACKUP_INVALID' && error.status === 409; }

async function fixture(t: TestContext, baseUrl = 'http://127.0.0.1:9/v1') {
  const root = await mkdtemp(join(tmpdir(), 'owntake-generation-backup-'));
  const store = new Store({ dataDir: join(root, 'source-data'), projectsDir: join(root, 'source-projects') });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const pngPath = join(root, 'complete.png');
  const encoded = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=1536x864', '-frames:v', '1', '-threads', '1', pngPath], { timeout: 15000 });
  assert.equal(encoded.status, 0, encoded.stderr?.toString());
  const bytes = await readFile(pngPath), sha256 = createHash('sha256').update(bytes).digest('hex'), media = await probe(pngPath);
  const project = store.createProject({ name: '暂存结果恢复', brief: '收到结果但尚未发布候选', ratio: '16:9' });
  const board = new StoryboardStore(store);
  const shot = board.addShot(project.id, { title: '待入库镜头', purpose: '', description: '蓝色天空', action: '', durationMs: 2000, caption: '', mode: 'generate_image', referenceArtifactIds: [] }, 0).shots[0]!;
  const providers = new ProviderRepository(store, board), generations = new GenerationRepository(store, board, providers);
  const imageProvider = providers.saveProfile({ label: '同步图片', kind: 'openai-images', baseUrl, model: 'fixture-model', capabilities: { inputModes: ['text'], ratios: ['16:9'], durationsSec: [], maxReferences: 0 }, maxOutputTokens: 2048, timeoutMs: 500 });
  const videoProvider = providers.saveProfile({ label: '异步视频', kind: 'ark-video', baseUrl, model: 'fixture-model', capabilities: { inputModes: ['text'], ratios: ['16:9'], durationsSec: [2], maxReferences: 0 }, maxOutputTokens: 2048, timeoutMs: 500 });
  function relative(generation: StoredGeneration): string { return `assets/${generation.outputArtifactId}/received.${generation.plan.kind === 'image' ? 'png' : 'mp4'}`; }
  async function received(status: GenerationStatus, hasStage = true): Promise<StoredGeneration> {
    const kind = status === 'waiting_remote' ? 'video' : 'image';
    const provider = kind === 'image' ? imageProvider : videoProvider;
    const plan: GenerationPlan = { kind, inputMode: 'text', prompt: '蓝色天空', ratio: '16:9', referenceArtifactIds: [], ...(kind === 'video' ? { durationSec: 2 } : {}) };
    const generation = await generations.create(shot.id, { providerId: provider.id, plan, expectedShotRevision: shot.revision, expectedProviderUpdatedAt: provider.updatedAt, clientRequestId: randomUUID(), reservation: { currency: 'USD', amount: 0.5, singleLimit: 1, projectLimit: 10 } });
    if (hasStage) {
      assert.equal(kind, 'image');
      const path = join(store.getProjectDir(project.id), relative(generation));
      await mkdir(dirname(path), { recursive: true }); await link(pngPath, path);
    }
    generation.status = status;
    if (status === 'waiting_remote') { generation.remoteTaskId = 'cgt-paused'; generation.pollingPaused = true; }
    // Stored path hints are not authority: backup must infer the only legitimate asset path.
    generation.stagedRelativePath = '../../must-not-be-read.png';
    store.transaction(() => {
      generations.save(generation);
      store.updateJob(generation.jobId, { status: status === 'submission_unknown' || status === 'download_failed' ? 'blocked' : status === 'waiting_remote' ? 'waiting_external' : 'running' });
    });
    return generation;
  }
  function register(generation: StoredGeneration): void {
    store.transaction(() => {
      store.addArtifact({ id: generation.outputArtifactId, projectId: project.id, name: '已登记.png', kind: 'image', relativePath: relative(generation), sizeBytes: bytes.length, sha256, source: 'generated', media, metadata: { generationId: generation.id } });
      const candidate = board.addCandidate({ projectId: project.id, shotId: shot.id, visualRevision: generation.visualRevision, artifactId: generation.outputArtifactId, planId: generation.planId });
      generation.status = 'succeeded'; generation.artifactId = generation.outputArtifactId; generation.candidateId = candidate.id;
      generations.save(generation);
      store.updateJob(generation.jobId, { status: 'succeeded', progress: 1 });
    });
  }
  async function receipt(generation: StoredGeneration, partial = false, complete = true): Promise<string> {
    const saved = { ...generation, inlineReceipt: { sha256, sizeBytes: bytes.length } };
    generations.save(saved);
    const path = `assets/${generation.outputArtifactId}/receipt-${generation.attemptId}.png${partial ? '.part' : ''}`;
    await mkdir(dirname(join(store.getProjectDir(project.id), path)), { recursive: true });
    await writeFile(join(store.getProjectDir(project.id), path), complete ? bytes : bytes.subarray(0, Math.floor(bytes.length / 2)), { flag: 'wx' });
    return path;
  }
  return { root, store, project, shot, board, generations, bytes, sha256, received, relative, register, receipt };
}

test('backup preserves complete unregistered images and an actual restored server ingests them without a generation POST', { timeout: 30000 }, async t => {
  let supplierRequests = 0;
  const supplier = createServer((_request, response) => { supplierRequests += 1; response.writeHead(500); response.end(); });
  await new Promise<void>(resolve => supplier.listen(0, '127.0.0.1', resolve));
  t.after(async () => { supplier.closeAllConnections(); await new Promise<void>(resolve => supplier.close(() => resolve())); });
  const f = await fixture(t, `http://127.0.0.1:${(supplier.address() as AddressInfo).port}/v1`);
  const submitting = await f.received('submitting');
  const ingesting = await f.received('ingesting');
  const secondaryReceipt = await f.receipt(ingesting);
  const failed = await f.received('download_failed');
  const registered = await f.received('ingesting'); f.register(registered);
  const unknown = await f.received('submission_unknown', false);
  const waiting = await f.received('waiting_remote', false);
  const receivedImage = await f.received('ingesting', false), receivedPath = await f.receipt(receivedImage);
  const receivedPart = await f.received('ingesting', false), partialPath = await f.receipt(receivedPart, true);
  const incomplete = await f.received('ingesting', false), incompletePath = await f.receipt(incomplete, true, false);
  const backup = join(f.root, 'backup');
  const manifest = await f.store.backupTo(backup);
  assert.equal(manifest.schemaVersion, SCHEMA_VERSION);
  assert.equal(manifest.artifacts.length, 1);
  assert.deepEqual(manifest.stagedArtifacts?.map(item => item.generationId).sort(), [submitting.id, ingesting.id, failed.id, receivedImage.id, receivedPart.id].sort());
  for (const item of manifest.stagedArtifacts!) {
    assert.equal(item.relativePath, item.generationId === receivedImage.id ? receivedPath : item.generationId === receivedPart.id ? partialPath : f.relative(f.generations.get(item.generationId)));
    assert.equal(item.sha256, f.sha256); assert.equal(item.sizeBytes, f.bytes.length);
  }
  assert.equal(existsSync(join(backup, 'projects', f.project.id, secondaryReceipt)), false, 'a published final file takes precedence over its redundant receipt');
  assert.equal(existsSync(join(backup, 'projects', f.project.id, incompletePath)), false, 'incomplete bytes are not backed up as a successful receipt');
  const target = { dataDir: join(f.root, 'restored-data'), projectsDir: join(f.root, 'restored-projects') };
  await restoreBackup(backup, target);
  const app = await startServer({ ...target, port: 0 });
  try {
    const waitFor = async (id: string) => {
      for (let i = 0; i < 400; i++) {
        const current = app.generations.get(id);
        if (current.status === 'succeeded') return current;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.fail(JSON.stringify(app.generations.get(id)));
    };
    for (const generation of [submitting, ingesting, receivedImage, receivedPart]) {
      const complete = await waitFor(generation.id);
      assert.equal(complete.actualAmount, null);
      assert.deepEqual(await readFile(app.store.resolveArtifactPath(complete.artifactId!)), f.bytes);
    }
    assert.equal(app.generations.get(failed.id).status, 'download_failed');
    assert.deepEqual(await readFile(join(target.projectsDir, f.project.id, f.relative(failed))), f.bytes);
    const bootstrap = await fetch(app.url + '/api/session');
    const cookie = bootstrap.headers.get('set-cookie')!.split(';')[0]!;
    const csrf = (await bootstrap.json() as { csrfToken: string }).csrfToken;
    const retry = await fetch(app.url + `/api/generations/${failed.id}/retry-download`, { method: 'POST', headers: { Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(retry.status, 200, await retry.text());
    await waitFor(failed.id);
    assert.equal(app.generations.get(unknown.id).status, 'submission_unknown');
    assert.equal(app.generations.get(waiting.id).status, 'waiting_remote');
    assert.equal(app.generations.get(waiting.id).pollingPaused, true);
    assert.notEqual(app.generations.get(incomplete.id).status, 'succeeded');
    assert.equal(app.board.snapshot(f.project.id).candidates.length, 6);
    assert.equal(app.board.getShot(f.shot.id).selectedArtifactId, null);
    assert.equal(supplierRequests, 0, 'restored complete files must not require any supplier call, especially another paid POST');
  } finally { await app.close(); }
});

test('restore rejects staged path, generation, hash and duplicate tampering before creating output directories', { timeout: 30000 }, async t => {
  const f = await fixture(t), generation = await f.received('ingesting', false);
  await f.receipt(generation);
  const backup = join(f.root, 'backup'), original = await f.store.backupTo(backup);
  const entry = original.stagedArtifacts![0]!;
  const variants: BackupManifest[] = [
    { ...original, stagedArtifacts: [{ ...entry, relativePath: '../escape.png' }] },
    { ...original, stagedArtifacts: [{ ...entry, relativePath: `assets/${generation.outputArtifactId}/different.png` }] },
    { ...original, stagedArtifacts: [{ ...entry, generationId: 'generation_absent' }] },
    { ...original, stagedArtifacts: [{ ...entry, projectId: 'project_absent' }] },
    { ...original, stagedArtifacts: [{ ...entry, sha256: '0'.repeat(64) }] },
    { ...original, stagedArtifacts: [{ ...entry, sizeBytes: entry.sizeBytes + 1 }] },
    { ...original, stagedArtifacts: [entry, entry] },
    { ...original, stagedArtifacts: undefined },
  ];
  for (const [index, manifest] of variants.entries()) {
    await writeFile(join(backup, 'manifest.json'), JSON.stringify(manifest));
    const target = { dataDir: join(f.root, `bad-data-${index}`), projectsDir: join(f.root, `bad-projects-${index}`) };
    await assert.rejects(restoreBackup(backup, target), backupInvalid);
    assert.equal(existsSync(target.dataDir), false); assert.equal(existsSync(target.projectsDir), false);
  }
  await writeFile(join(backup, 'manifest.json'), JSON.stringify(original));
  await writeFile(join(backup, 'projects', entry.projectId, entry.relativePath), 'tampered complete media');
  const target = { dataDir: join(f.root, 'bad-media-data'), projectsDir: join(f.root, 'bad-media-projects') };
  await assert.rejects(restoreBackup(backup, target), backupInvalid);
  assert.equal(existsSync(target.dataDir), false);
});

test('legacy version 1 and version 2 manifests without stagedArtifacts still restore and migrate', async t => {
  for (const version of [1, 2]) {
    await t.test(`schema ${version} to schema ${SCHEMA_VERSION}`, async sub => {
      const f = await fixture(sub);
      // Remove newer child tables before their parents; changing user_version alone
      // would leave a v4 database falsely labelled as a legacy backup.
      f.store.db.exec('DROP TABLE library_story_projects; DROP TABLE library_script_versions; DROP TABLE library_story_versions; DROP TABLE library_stories;');
      f.store.db.exec('DROP TABLE studio_receipts; DROP TABLE studio_frames; DROP TABLE studio_operations; DROP TABLE runtime_profiles; DROP TABLE reviews; DROP TABLE generations;');
      if (version === 1) f.store.db.exec('DROP TABLE storyboard_drafts; DROP TABLE candidates; DROP TABLE shot_revisions; DROP TABLE shots; DROP TABLE boards; DROP TABLE provider_calls; DROP TABLE provider_profiles; DROP INDEX artifacts_identity_project;');
      f.store.db.exec(`PRAGMA user_version=${version}`);
      const expectedTables = ['artifacts', 'events', 'jobs', 'projects', 'settings', 'timelines', ...(version === 2 ? ['boards', 'candidates', 'provider_calls', 'provider_profiles', 'shot_revisions', 'shots', 'storyboard_drafts'] : [])].sort();
      assert.deepEqual(f.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name), expectedTables);
      const backup = join(f.root, 'legacy-backup');
      const manifest = await createBackup({ db: f.store.db, dataDir: f.store.dataDir, projectsDir: f.store.projectsDir, schemaVersion: version }, backup);
      assert.equal(manifest.stagedArtifacts, undefined);
      const target = { dataDir: join(f.root, 'restored-data'), projectsDir: join(f.root, 'restored-projects') };
      await restoreBackup(backup, target);
      const restored = new Store(target);
      try {
        assert.equal(restored.schemaVersion, SCHEMA_VERSION);
        assert.equal(restored.getProject(f.project.id).name, f.project.name);
        assert.equal(restored.db.prepare('SELECT COUNT(*) AS count FROM generations').get()?.count, 0);
        assert.equal(restored.db.prepare('SELECT COUNT(*) AS count FROM studio_operations').get()?.count, 0);
        assert.equal(restored.db.prepare('SELECT COUNT(*) AS count FROM studio_receipts').get()?.count, 0);
        assert.equal(new StoryboardStore(restored).snapshot(f.project.id).shots.length, version === 1 ? 0 : 1);
      } finally { restored.close(); }
    });
  }
});
