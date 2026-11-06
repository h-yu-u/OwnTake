import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AppError } from '../packages/contracts/src/errors.ts';
import { Store, SCHEMA_VERSION, verifyMigrationSnapshot } from '../packages/storage/src/index.ts';
import type { MigrationSnapshot, MigrationSnapshotManifest } from '../packages/storage/src/index.ts';
import { StoryboardStore } from '../packages/storage/src/storyboard.ts';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6akAAAAASUVORK5CYII=', 'base64');
function failure(code: string): (error: unknown) => boolean { return error => error instanceof AppError && error.code === code; }
function temporary(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'owntake-migration-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, options: { dataDir: join(root, 'data'), projectsDir: join(root, 'projects') } };
}
function sqlite<T>(path: string, fn: (db: DatabaseSync) => T, readOnly = true): T {
  const db = new DatabaseSync(path, { readOnly });
  try { return fn(db); } finally { db.close(); }
}
function legacy(t: TestContext) {
  const { root, options } = temporary(t), store = new Store(options);
  const project = store.createProject({ name: '迁移前的短片', brief: '保留镜头、媒体和未完成任务', ratio: '16:9' });
  const assetId = 'original_image', relativePath = `assets/${assetId}/original.png`;
  const assetPath = join(store.getProjectDir(project.id), relativePath);
  mkdirSync(join(store.getProjectDir(project.id), 'assets', assetId), { mode: 0o700 });
  writeFileSync(assetPath, png, { flag: 'wx', mode: 0o600 });
  const artifact = store.addArtifact({ id: assetId, projectId: project.id, name: '原始图片.png', kind: 'image', relativePath, sha256: createHash('sha256').update(png).digest('hex'), sizeBytes: png.length, source: 'import', media: { kind: 'image', durationMs: 0, width: 1, height: 1, hasAudio: false, format: 'png_pipe', codec: 'png' }, metadata: {} });
  const board = new StoryboardStore(store);
  const shot = board.addShot(project.id, { title: '迁移前镜头', purpose: '保留叙事意图', description: '窗边暖光', action: '', durationMs: 1000, caption: '旧版字幕', mode: 'import', referenceArtifactIds: [] }, 0).shots[0]!;
  const candidate = board.addCandidate({ projectId: project.id, shotId: shot.id, visualRevision: 1, artifactId: artifact.id });
  board.selectCandidate(shot.id, candidate.id, shot.revision);
  const timeline = store.saveTimeline(project.id, { width: 1280, height: 720, fps: 24, clips: [{ artifactId: artifact.id, sourceInMs: 0, durationMs: 1000, fit: 'contain', muteSource: false, shotId: shot.id }], captions: [], audio: [] }, 0);
  const queued = store.createJob({ projectId: project.id, type: 'generation', payload: { note: '原有任务，不允许重新创建' }, dedupeKey: 'legacy-original' });
  const job = store.updateJob(queued.id, { status: 'blocked', error: { code: 'SUBMISSION_UNKNOWN', message: '等待人工核对' } });
  const original = { project: store.getProject(project.id), artifact, board: board.snapshot(project.id), timeline, job };
  // A real v3 structure, with actual project records; do not merely relabel v4.
  store.db.exec('DROP TABLE studio_receipts; DROP TABLE studio_frames; DROP TABLE studio_operations; DROP TABLE runtime_profiles; PRAGMA user_version=3;');
  const databasePath = store.databasePath;
  store.close();
  return { root, options, databasePath, project, artifact, assetPath, original };
}
function snapshots(dataDir: string): string[] {
  const root = join(realpathSync(dataDir), 'backups', 'migrations');
  return existsSync(root) ? readdirSync(root).filter(name => !name.startsWith('.')).map(name => join(root, name)) : [];
}
function assertOldDatabase(databasePath: string, projectId: string): void {
  sqlite(databasePath, db => {
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 3);
    assert.equal(db.prepare('SELECT name FROM projects WHERE id=?').get(projectId)?.name, '迁移前的短片');
    assert.equal(db.prepare("SELECT name FROM sqlite_schema WHERE name='runtime_profiles'").get(), undefined);
  });
}

test('existing v3 opens only after a verified private metadata snapshot, and portable backup still includes media', async t => {
  const f = legacy(t), store = new Store(f.options);
  try {
    assert.equal(store.schemaVersion, SCHEMA_VERSION);
    const snapshot = store.migrationSnapshot; assert(snapshot);
    assert.deepEqual(snapshots(f.options.dataDir), [snapshot.directory]);
    assert.deepEqual(verifyMigrationSnapshot(f.options.dataDir, snapshot.directory), snapshot.manifest);
    assert.equal(snapshot.manifest.fromSchemaVersion, 3); assert.equal(snapshot.manifest.toSchemaVersion, SCHEMA_VERSION);
    assert.equal(snapshot.manifest.scope, 'database-only'); assert.equal(snapshot.manifest.mediaFilesIncluded, false); assert.equal(snapshot.manifest.credentialsIncluded, false);
    assert.equal(snapshot.manifest.source.projectsDir, realpathSync(f.options.projectsDir));
    assert.deepEqual(readdirSync(snapshot.directory).sort(), ['app.sqlite', 'manifest.json']);
    for (const name of ['app.sqlite', 'manifest.json']) {
      const info: Stats = lstatSync(join(snapshot.directory, name)); assert.equal(info.isSymbolicLink(), false);
      if (process.platform !== 'win32') assert.equal(info.mode & 0o777, 0o600);
    }
    if (process.platform !== 'win32') {
      for (const directory of [snapshot.directory, join(f.options.dataDir, 'backups'), join(f.options.dataDir, 'backups', 'migrations')]) assert.equal(statSync(directory).mode & 0o777, 0o700);
    }
    const databaseBytes = readFileSync(join(snapshot.directory, 'app.sqlite'));
    assert.equal(createHash('sha256').update(databaseBytes).digest('hex'), snapshot.manifest.database.sha256); assert.equal(databaseBytes.length, snapshot.manifest.database.sizeBytes);
    assertOldDatabase(join(snapshot.directory, 'app.sqlite'), f.project.id);
    assert.deepEqual(store.getProject(f.project.id), f.original.project); assert.deepEqual(store.getArtifact(f.artifact.id), f.original.artifact);
    assert.deepEqual(new StoryboardStore(store).snapshot(f.project.id), f.original.board);
    assert.deepEqual(store.getLatestTimeline(f.project.id), f.original.timeline); assert.deepEqual(store.getJob(f.original.job.id), f.original.job);
    assert.deepEqual(readFileSync(f.assetPath), png, 'external immutable media stay in their original directory');
    const portable = join(f.root, 'portable-backup'), manifest = await store.backupTo(portable);
    assert.equal(manifest.format, 'owntake.backup'); assert.equal(manifest.artifacts.length, 1);
    assert.deepEqual(readFileSync(join(portable, 'projects', f.project.id, f.artifact.relativePath)), png);
  } finally { store.close(); }
  const current = new Store(f.options);
  try { assert.equal(current.migrationSnapshot, null); assert.equal(snapshots(f.options.dataDir).length, 1); }
  finally { current.close(); }
});

test('pre-migration snapshot includes committed WAL records while another connection remains open', t => {
  const f = legacy(t), writer = new DatabaseSync(f.databasePath);
  let migrated: Store | undefined;
  try {
    writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
    writer.prepare('UPDATE projects SET name=?,revision=revision+1 WHERE id=?').run('只在 WAL 中提交的新名称', f.project.id);
    assert(statSync(`${f.databasePath}-wal`).size > 0);
    migrated = new Store(f.options);
    const snapshot = migrated.migrationSnapshot; assert(snapshot);
    sqlite(join(snapshot.directory, 'app.sqlite'), db => {
      assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 3);
      assert.equal(db.prepare('SELECT name,revision FROM projects WHERE id=?').get(f.project.id)?.name, '只在 WAL 中提交的新名称');
      assert.equal(db.prepare('SELECT revision FROM projects WHERE id=?').get(f.project.id)?.revision, f.project.revision + 1);
    });
    assert.equal(migrated.getProject(f.project.id).name, '只在 WAL 中提交的新名称');
  } finally { migrated?.close(); writer.close(); }
});

test('new, empty, current and newer databases create no unnecessary migration snapshots', async t => {
  for (const state of ['new', 'empty', 'current', 'newer'] as const) await t.test(state, sub => {
    const { options } = temporary(sub);
    if (state === 'empty') { mkdirSync(options.dataDir, { recursive: true }); new DatabaseSync(join(options.dataDir, 'app.sqlite')).close(); }
    if (state === 'current' || state === 'newer') {
      const store = new Store(options); store.createProject({ name: '保留项目' });
      if (state === 'newer') store.db.exec('PRAGMA user_version=99');
      store.close();
    }
    if (state === 'newer') {
      assert.throws(() => new Store(options), failure('DATABASE_NEWER'));
      sqlite(join(options.dataDir, 'app.sqlite'), db => { assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 99); assert.equal(db.prepare('SELECT name FROM projects').get()?.name, '保留项目'); });
    } else {
      const store = new Store(options); try { assert.equal(store.migrationSnapshot, null); } finally { store.close(); }
    }
    assert.equal(existsSync(join(options.dataDir, 'backups')), false);
  });
});

test('unversioned existing data is refused rather than initialized as a new database', t => {
  const f = legacy(t);
  sqlite(f.databasePath, db => db.exec('PRAGMA user_version=0'), false);
  assert.throws(() => new Store(f.options), failure('DATABASE_UNVERSIONED'));
  sqlite(f.databasePath, db => {
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 0);
    assert.equal(db.prepare('SELECT name FROM projects WHERE id=?').get(f.project.id)?.name, f.project.name);
    assert.equal(db.prepare("SELECT name FROM sqlite_schema WHERE name='runtime_profiles'").get(), undefined);
  });
  assert.equal(existsSync(join(f.options.dataDir, 'backups')), false);
});

test('failed transactional migration rolls back earlier DDL, preserves the snapshot and closes the source handle', t => {
  const f = legacy(t);
  // runtime_profiles is created first; this conflict fails the next CREATE TABLE.
  sqlite(f.databasePath, db => db.exec('CREATE VIEW studio_operations AS SELECT 1 AS fixture_conflict'), false);
  const closed: string[] = [], originalClose = DatabaseSync.prototype.close;
  t.mock.method(DatabaseSync.prototype, 'close', function (this: DatabaseSync) { const path = this.location(); if (path) closed.push(path); return originalClose.call(this); });
  assert.throws(() => new Store(f.options), /studio_operations.*already exists/);
  assert(closed.includes(f.databasePath), 'a failed Store constructor must close its SQLite connection');
  assertOldDatabase(f.databasePath, f.project.id);
  const saved = snapshots(f.options.dataDir); assert.equal(saved.length, 1);
  assert.equal(verifyMigrationSnapshot(f.options.dataDir, saved[0]!).fromSchemaVersion, 3);
  assertOldDatabase(join(saved[0]!, 'app.sqlite'), f.project.id);
  sqlite(f.databasePath, db => assert.equal(db.prepare("SELECT type FROM sqlite_schema WHERE name='studio_operations'").get()?.type, 'view'));
  assert.deepEqual(readFileSync(f.assetPath), png);
});

test('unsafe or blocked backup directories stop migration without following links or changing the old database', async t => {
  for (const mode of ['backup-symlink', 'migration-symlink', 'backup-file'] as const) await t.test(mode, sub => {
    const f = legacy(sub), outside = join(f.root, 'outside'); mkdirSync(outside, { mode: 0o700 });
    const sentinel = join(outside, 'keep.txt'); writeFileSync(sentinel, 'unchanged');
    const backups = join(f.options.dataDir, 'backups');
    if (mode === 'backup-symlink') symlinkSync(outside, backups, 'dir');
    else if (mode === 'migration-symlink') { mkdirSync(backups); symlinkSync(outside, join(backups, 'migrations'), 'dir'); }
    else writeFileSync(backups, 'do not replace this file');
    const closed: string[] = [], originalClose = DatabaseSync.prototype.close;
    sub.mock.method(DatabaseSync.prototype, 'close', function (this: DatabaseSync) { const path = this.location(); if (path) closed.push(path); return originalClose.call(this); });
    assert.throws(() => new Store(f.options), failure('MIGRATION_BACKUP_FAILED'));
    assert(closed.includes(f.databasePath)); assertOldDatabase(f.databasePath, f.project.id);
    assert.deepEqual(readdirSync(outside), ['keep.txt']); assert.equal(readFileSync(sentinel, 'utf8'), 'unchanged');
    if (mode === 'backup-file') assert.equal(readFileSync(backups, 'utf8'), 'do not replace this file');
  });
});

test('snapshot verification rejects changed paths, metadata, sidecars, bytes and file or directory symlinks', t => {
  const f = legacy(t), store = new Store(f.options); let snapshot: MigrationSnapshot;
  try { assert(store.migrationSnapshot); snapshot = store.migrationSnapshot; } finally { store.close(); }
  const directory = snapshot!.directory, manifestPath = join(directory, 'manifest.json'), databasePath = join(directory, 'app.sqlite');
  const originalManifest = readFileSync(manifestPath), originalDatabase = readFileSync(databasePath), parsed = JSON.parse(originalManifest.toString('utf8')) as MigrationSnapshotManifest;
  for (const changed of [
    { ...parsed, database: { ...parsed.database, path: '../app.sqlite' } },
    { ...parsed, database: { ...parsed.database, sha256: '0'.repeat(64) } },
    { ...parsed, database: { ...parsed.database, sizeBytes: parsed.database.sizeBytes + 1 } },
    { ...parsed, fromSchemaVersion: 2 }, { ...parsed, scope: 'portable' }, { ...parsed, extra: 'unsupported' },
    { ...parsed, source: { ...parsed.source, databasePath: join(f.root, 'elsewhere.sqlite') } },
  ]) {
    writeFileSync(manifestPath, JSON.stringify(changed));
    assert.throws(() => verifyMigrationSnapshot(f.options.dataDir, directory), failure('MIGRATION_SNAPSHOT_INVALID'));
  }
  writeFileSync(manifestPath, originalManifest);
  assert.throws(() => verifyMigrationSnapshot(f.options.dataDir, join(f.root, 'outside')), failure('MIGRATION_SNAPSHOT_INVALID'));
  writeFileSync(join(directory, 'app.sqlite-wal'), 'untracked sidecar', { mode: 0o600 });
  assert.throws(() => verifyMigrationSnapshot(f.options.dataDir, directory), failure('MIGRATION_SNAPSHOT_INVALID')); unlinkSync(join(directory, 'app.sqlite-wal'));
  const corrupt = Buffer.from(originalDatabase); corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1; writeFileSync(databasePath, corrupt);
  assert.throws(() => verifyMigrationSnapshot(f.options.dataDir, directory), failure('MIGRATION_SNAPSHOT_INVALID')); writeFileSync(databasePath, originalDatabase);
  for (const path of [manifestPath, databasePath]) {
    const saved = join(f.root, `outside-${path === manifestPath ? 'manifest.json' : 'app.sqlite'}`);
    renameSync(path, saved); symlinkSync(saved, path);
    assert.throws(() => verifyMigrationSnapshot(f.options.dataDir, directory), failure('MIGRATION_SNAPSHOT_INVALID'));
    unlinkSync(path); renameSync(saved, path);
  }
  const moved = join(f.root, 'moved-snapshot'); renameSync(directory, moved); symlinkSync(moved, directory, 'dir');
  assert.throws(() => verifyMigrationSnapshot(f.options.dataDir, directory), failure('MIGRATION_SNAPSHOT_INVALID')); unlinkSync(directory); renameSync(moved, directory);
  if (process.platform !== 'win32') {
    chmodSync(databasePath, 0o644); assert.throws(() => verifyMigrationSnapshot(f.options.dataDir, directory), failure('MIGRATION_SNAPSHOT_INVALID')); chmodSync(databasePath, 0o600);
  }
  assert.deepEqual(verifyMigrationSnapshot(f.options.dataDir, directory), parsed);
  sqlite(f.databasePath, db => { assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, SCHEMA_VERSION); assert.equal(db.prepare('SELECT name FROM projects WHERE id=?').get(f.project.id)?.name, f.project.name); });
});

test('an invalid source snapshot aborts migration and removes only its own unpublished partial directory', t => {
  const f = legacy(t);
  sqlite(f.databasePath, db => { db.exec('PRAGMA foreign_keys=OFF'); db.prepare('UPDATE artifacts SET project_id=? WHERE id=?').run('missing_project', f.artifact.id); }, false);
  assert.throws(() => new Store(f.options), failure('MIGRATION_BACKUP_FAILED'));
  assertOldDatabase(f.databasePath, f.project.id);
  assert.deepEqual(readdirSync(join(f.options.dataDir, 'backups', 'migrations')), []);
  sqlite(f.databasePath, db => assert.equal(db.prepare('SELECT project_id FROM artifacts WHERE id=?').get(f.artifact.id)?.project_id, 'missing_project'));
  assert.deepEqual(readFileSync(f.assetPath), png);
});
