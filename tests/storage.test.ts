import { SCHEMA_VERSION } from '../packages/storage/src/schema.ts';
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { AppError } from '../packages/contracts/src/errors.ts';
import type { TimelineDraft } from '../packages/contracts/src/index.ts';
import { Store, restoreBackup } from '../packages/storage/src/index.ts';
import type { NewArtifact } from '../packages/storage/src/index.ts';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'owntake-storage-'));
  const options = { dataDir: join(root, 'data'), projectsDir: join(root, 'projects') };
  const store = new Store(options);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, options, store };
}

function errorCode(code: string, status?: number) {
  return (error: unknown) => error instanceof AppError && error.code === code && (status === undefined || error.status === status);
}

function makeArtifact(store: Store, projectId: string, id = `artifact_${randomUUID()}`): NewArtifact {
  const bytes = Buffer.from(`test media for ${id}: 中文素材`);
  const relativePath = `assets/${id}/original.mp4`;
  const absolute = join(store.getProjectDir(projectId), relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, bytes);
  return {
    id, projectId, name: '镜头一.mp4', kind: 'video', relativePath,
    sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length,
    media: { kind: 'video', durationMs: 5000, width: 1920, height: 1080, fps: 24, hasAudio: true, format: 'mp4', codec: undefined },
    source: 'import', metadata: { 中文: '保留 UTF-8', optional: undefined },
  };
}

function draft(artifactId: string): TimelineDraft {
  return {
    width: 1920, height: 1080, fps: 24,
    clips: [{ artifactId, sourceInMs: 0, durationMs: 3000, fit: 'contain', muteSource: false }],
    captions: [{ startMs: 0, endMs: 2000, text: '我的第一条短片' }], audio: [],
  };
}

test('SQLite persists projects, immutable assets, timeline versions, jobs and tool settings after restart', t => {
  const { store, options } = fixture(t);
  const project = store.createProject({ name: "短片'); DROP TABLE projects; --", brief: '自己的镜头', ratio: '9:16' });
  const asset = store.addArtifact(makeArtifact(store, project.id));
  const timeline = store.saveTimeline(project.id, draft(asset.id), 0);
  const job = store.createJob({ projectId: project.id, type: 'render', payload: { timelineId: timeline.id }, dedupeKey: 'render-once' });
  store.updateJob(job.id, { status: 'running', progress: 0.25 });
  store.updateSettings({ ffmpegPath: '/工具/ffmpeg' });
  const before = store.snapshot(project.id);
  store.close();
  const reopened = new Store(options);
  try {
    assert.deepEqual(reopened.snapshot(project.id), before);
    assert.equal(reopened.getSettings().ffmpegPath, '/工具/ffmpeg');
    assert.equal(reopened.getSettings().ffprobePath, 'ffprobe');
    assert.equal(reopened.listRecoverableJobs()[0]?.id, job.id);
    assert.equal(reopened.schemaVersion, SCHEMA_VERSION);
    assert.equal(reopened.db.prepare('PRAGMA foreign_keys').get()?.foreign_keys, 1);
    assert.equal(reopened.db.prepare('PRAGMA journal_mode').get()?.journal_mode, 'wal');
    assert.equal(reopened.getArtifact(asset.id).metadata['中文'], '保留 UTF-8');
  } finally { reopened.close(); }
});

test('job creation deduplicates canonical payloads and rejects conflicting reuse without extra events', t => {
  const { store } = fixture(t);
  const project = store.createProject({ name: '任务' });
  const input = { projectId: project.id, type: 'render', payload: { quality: 'preview', options: { a: 1, b: 2 } }, dedupeKey: 'click-1' };
  const first = store.createJob(input);
  const cursor = store.getEventCursor();
  const duplicate = store.createJob({ ...input, payload: { options: { b: 2, a: 1 }, quality: 'preview' } });
  assert.equal(first.id, duplicate.id);
  assert.equal(store.getEventCursor(), cursor);
  assert.throws(() => store.createJob({ ...input, payload: { quality: 'final' } }), errorCode('IDEMPOTENCY_CONFLICT', 409));
  assert.equal(store.listJobs(project.id).length, 1);
  assert.equal(store.getEventCursor(), cursor);
});

test('nested transactions atomically publish artifacts, completion and events, and roll back all three on failure', t => {
  const { store } = fixture(t);
  const project = store.createProject({ name: '原子发布' });
  const input = makeArtifact(store, project.id);
  const job = store.createJob({ projectId: project.id, type: 'import', payload: {}, dedupeKey: 'import-1' });
  const before = store.snapshot(project.id);
  assert.throws(() => store.transaction(() => {
    store.addArtifact(input);
    store.updateJob(job.id, { status: 'succeeded', result: { artifactId: input.id } });
    throw new Error('simulate failed publication');
  }), /failed publication/);
  assert.deepEqual(store.snapshot(project.id), before);
  store.transaction(() => {
    store.addArtifact(input);
    store.updateJob(job.id, { status: 'succeeded', result: { artifactId: input.id } });
  });
  const published = store.snapshot(project.id);
  assert.equal(published.artifacts.length, 1);
  assert.equal(published.jobs[0]?.status, 'succeeded');
  assert.equal(published.jobs[0]?.progress, 1);
  assert.deepEqual(store.listEvents(project.id, before.eventCursor).map(event => event.type), ['artifact.ready', 'job.updated']);
  assert.throws(() => store.updateJob(job.id, { status: 'running' }), errorCode('JOB_STATE_CONFLICT', 409));
  assert.throws(() => store.transaction(async () => 1), errorCode('ASYNC_TRANSACTION'));
});

test('savepoints let an outer transaction recover from a nested failure without keeping nested events', t => {
  const { store } = fixture(t);
  const project = store.createProject({ name: '保存点' });
  const after = store.getEventCursor();
  store.transaction(() => {
    store.appendEvent(project.id, 'test.before', {});
    assert.throws(() => store.transaction(() => {
      store.appendEvent(project.id, 'test.rolled_back', {});
      throw new Error('inner failure');
    }), /inner failure/);
    store.appendEvent(project.id, 'test.after', {});
  });
  assert.deepEqual(store.listEvents(project.id, after).map(event => event.type), ['test.before', 'test.after']);
});

test('optimistic revisions preserve prior versions and reject cross-project timeline references', t => {
  const { store } = fixture(t);
  const project = store.createProject({ name: '版本' });
  const second = store.createProject({ name: '另一个项目' });
  const asset = store.addArtifact(makeArtifact(store, project.id));
  const first = store.saveTimeline(project.id, draft(asset.id), 0);
  const next = store.saveTimeline(project.id, { ...draft(asset.id), width: 1280, height: 720 }, first.version);
  assert.equal(next.version, 2);
  assert.equal(store.getTimeline(first.id).width, 1920);
  const cursor = store.getEventCursor();
  assert.throws(() => store.saveTimeline(project.id, draft(asset.id), 1), errorCode('REVISION_CONFLICT', 409));
  assert.throws(() => store.saveTimeline(second.id, draft(asset.id), 0), errorCode('INVALID_REFERENCE'));
  assert.equal(store.getEventCursor(), cursor);
  assert.equal(store.getLatestTimeline(second.id), null);
  assert.equal(store.updateProject(project.id, { name: '新名称' }, 1).revision, 2);
  assert.throws(() => store.updateProject(project.id, { name: '旧编辑器' }, 1), errorCode('REVISION_CONFLICT', 409));
  assert.equal(store.getProject(project.id).name, '新名称');
});

test('artifact metadata is immutable and asset paths cannot traverse directories or escape through symlinks', t => {
  const { store, root } = fixture(t);
  const project = store.createProject({ name: '路径安全' });
  const input = makeArtifact(store, project.id);
  const asset = store.addArtifact(input);
  assert.deepEqual(store.addArtifact(input), asset);
  assert.throws(() => store.addArtifact({ ...input, name: '改写.mp4' }), errorCode('ARTIFACT_CONFLICT', 409));
  assert.throws(() => store.addArtifact({ ...input, relativePath: '../outside.mp4' }), errorCode('INVALID_PATH'));
  assert.throws(() => store.addArtifact({ ...input, relativePath: 'project.owntake.json' }), errorCode('INVALID_PATH'));
  assert.throws(() => store.getProject('../escape'), errorCode('INVALID_ID'));
  const outside = join(root, 'private.mp4');
  writeFileSync(outside, 'private');
  const linkedId = 'artifact_linked';
  const linked = join(store.getProjectDir(project.id), 'assets', linkedId);
  mkdirSync(linked);
  symlinkSync(outside, join(linked, 'original.mp4'));
  assert.throws(() => store.addArtifact({ ...input, id: linkedId, relativePath: `assets/${linkedId}/original.mp4`, sizeBytes: 7 }), errorCode('INVALID_PATH'));
  assert.equal(store.listArtifacts(project.id).length, 1);
});

test('invalid media, malformed timeline objects and out-of-range progress are rejected before persistence', t => {
  const { store } = fixture(t);
  const project = store.createProject({ name: '输入校验' });
  const input = makeArtifact(store, project.id);
  assert.throws(() => store.addArtifact({ ...input, media: { ...input.media, durationMs: Number.NaN } }), errorCode('INVALID_INPUT'));
  const asset = store.addArtifact(input);
  assert.throws(() => store.saveTimeline(project.id, { ...draft(asset.id), clips: [null] } as unknown as TimelineDraft, 0), errorCode('INVALID_INPUT'));
  assert.throws(() => store.saveTimeline(project.id, { ...draft(asset.id), clips: [{ ...draft(asset.id).clips[0]!, durationMs: 10000 }] }, 0), errorCode('INVALID_RANGE'));
  const job = store.createJob({ projectId: project.id, type: 'render', payload: {}, dedupeKey: 'progress-1' });
  assert.throws(() => store.updateJob(job.id, { progress: 10 }), errorCode('INVALID_INPUT'));
  assert.equal(store.getJob(job.id).progress, 0);
  assert.equal(store.getLatestTimeline(project.id), null);
});

test('consistent backup contains a standalone SQLite snapshot and referenced media and can restore to an empty app', async t => {
  const { store, root } = fixture(t);
  const project = store.createProject({ name: '备份', brief: '中文与空格路径' });
  const asset = store.addArtifact(makeArtifact(store, project.id));
  store.saveTimeline(project.id, draft(asset.id), 0);
  store.createJob({ projectId: project.id, type: 'render', payload: { setting: 'preview' }, dedupeKey: 'backup-job' });
  writeFileSync(join(store.dataDir, 'credentials.json'), 'must not be copied');
  const expected = store.snapshot(project.id);
  const backup = join(root, "备份 ' 空格");
  const manifest = await store.backupTo(backup);
  assert.equal(manifest.credentialsIncluded, false);
  assert.deepEqual(readdirSync(backup).filter(name => !name.startsWith('.')).sort(), ['app.sqlite', 'manifest.json', 'projects']);
  assert.equal(existsSync(join(backup, 'credentials.json')), false);
  const standalone = new DatabaseSync(join(backup, 'app.sqlite'), { readOnly: true });
  try { assert.equal(standalone.prepare('SELECT COUNT(*) AS count FROM artifacts').get()?.count, 1); }
  finally { standalone.close(); }
  const target = { dataDir: join(root, 'restored-data'), projectsDir: join(root, 'restored-projects') };
  await restoreBackup(backup, target);
  const restored = new Store(target);
  try {
    assert.deepEqual(restored.snapshot(project.id), expected);
    assert.deepEqual(readFileSync(restored.resolveArtifactPath(asset.id)), readFileSync(store.resolveArtifactPath(asset.id)));
    assert.equal(restored.listRecoverableJobs().length, 1);
  } finally { restored.close(); }
  await assert.rejects(() => restoreBackup(backup, target), errorCode('RESTORE_TARGET_NOT_EMPTY', 409));
  await assert.rejects(() => store.backupTo(backup), errorCode('BACKUP_TARGET_EXISTS', 409));
});

test('restore validates all backup hashes before writing, and refuses backup directory aliases', async t => {
  const { store, root } = fixture(t);
  const project = store.createProject({ name: '恢复检查' });
  const asset = store.addArtifact(makeArtifact(store, project.id));
  const backup = join(root, 'backup');
  await store.backupTo(backup);
  const alias = join(root, 'backup-alias');
  symlinkSync(backup, alias, 'dir');
  await assert.rejects(() => restoreBackup(backup, { dataDir: join(alias, 'data'), projectsDir: join(root, 'should-not-exist') }), errorCode('RESTORE_TARGET_INVALID'));
  assert.equal(existsSync(join(backup, 'data')), false);
  const target = { dataDir: join(root, 'bad-data'), projectsDir: join(root, 'bad-projects') };
  writeFileSync(join(backup, 'projects', asset.projectId, asset.relativePath), 'tampered');
  await assert.rejects(() => restoreBackup(backup, target), errorCode('BACKUP_INVALID', 409));
  assert.equal(existsSync(target.dataDir), false);
  assert.equal(existsSync(target.projectsDir), false);
});

test('backup never publishes a snapshot whose registered media have changed', async t => {
  const { store, root } = fixture(t);
  const project = store.createProject({ name: '备份完整性' });
  const asset = store.addArtifact(makeArtifact(store, project.id));
  writeFileSync(store.resolveArtifactPath(asset.id), 'damaged bytes');
  const destination = join(root, 'incomplete-backup');
  await assert.rejects(() => store.backupTo(destination), errorCode('BACKUP_ASSET_CHANGED', 409));
  assert.equal(existsSync(destination), false);
  assert.deepEqual(readdirSync(root).filter(name => name.startsWith('.owntake-backup-')), []);
});

test('a newer database schema is never silently downgraded', t => {
  const { store, options } = fixture(t);
  const project = store.createProject({ name: '未来版本' });
  store.db.exec('PRAGMA user_version = 99');
  store.close();
  assert.throws(() => new Store(options), errorCode('DATABASE_NEWER', 409));
  const db = new DatabaseSync(join(options.dataDir, 'app.sqlite'), { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 99);
    assert.equal(db.prepare('SELECT name FROM projects WHERE id=?').get(project.id)?.name, '未来版本');
  } finally { db.close(); }
});
