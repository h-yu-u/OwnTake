import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync, closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync,
  mkdirSync, openSync, readSync, readdirSync, realpathSync, renameSync, rmSync,
  writeFileSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AppError, invariant } from '../../contracts/src/errors.ts';

export interface MigrationSnapshotManifest {
  format: 'owntake.migration-snapshot';
  version: 1;
  id: string;
  createdAt: string;
  fromSchemaVersion: number;
  toSchemaVersion: number;
  scope: 'database-only';
  mediaFilesIncluded: false;
  credentialsIncluded: false;
  source: { databasePath: string; projectsDir: string };
  database: { path: 'app.sqlite'; sha256: string; sizeBytes: number };
}
export interface MigrationSnapshot { directory: string; manifest: MigrationSnapshotManifest }
interface MigrationSource { db: DatabaseSync; dataDir: string; projectsDir: string; targetSchemaVersion: number }
const invalidCode = 'MIGRATION_SNAPSHOT_INVALID';
const snapshotName = /^v[1-9][0-9]*-to-v[1-9][0-9]*-[0-9]{13}-[a-f0-9-]{36}$/;

function check(condition: unknown): asserts condition {
  invariant(condition, invalidCode, '迁移前快照路径、清单或完整性检查失败；原数据库未被替换。', 409);
}
function exists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
function normalDirectory(path: string): Stats {
  const value = lstatSync(path);
  check(value.isDirectory() && !value.isSymbolicLink() && realpathSync(path) === path);
  return value;
}
function syncDirectory(path: string): void {
  normalDirectory(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { check(fstatSync(fd).isDirectory()); fsyncSync(fd); }
  finally { closeSync(fd); }
}
function childDirectory(parent: string, name: string, create: boolean): string {
  normalDirectory(parent);
  const path = join(parent, name);
  if (create && !exists(path)) { mkdirSync(path, { mode: 0o700 }); syncDirectory(parent); }
  normalDirectory(path);
  if (create) chmodSync(path, 0o700);
  return path;
}
function rootDirectory(dataDir: string, create: boolean): { data: string; migrations: string } {
  const data = realpathSync(dataDir);
  normalDirectory(data);
  const backups = childDirectory(data, 'backups', create);
  return { data, migrations: childDirectory(backups, 'migrations', create) };
}
function regularFile(path: string): Stats {
  const value = lstatSync(path);
  check(value.isFile() && !value.isSymbolicLink() && value.nlink === 1 && realpathSync(path) === path);
  check(process.platform === 'win32' || (value.mode & 0o777) === 0o600);
  return value;
}
function readFileDigest(path: string, maximum?: number): { sha256: string; sizeBytes: number; text?: string } {
  const info = regularFile(path), fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const initial = fstatSync(fd);
    check(initial.isFile() && initial.ino === info.ino && initial.dev === info.dev && initial.size > 0 && Number.isSafeInteger(initial.size));
    check(maximum === undefined || initial.size <= maximum);
    const hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024), chunks: Buffer[] = [];
    let sizeBytes = 0;
    while (sizeBytes < initial.size) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, initial.size - sizeBytes), sizeBytes);
      check(count > 0);
      const bytes = buffer.subarray(0, count); hash.update(bytes);
      if (maximum !== undefined) chunks.push(Buffer.from(bytes));
      sizeBytes += count;
    }
    const last = fstatSync(fd);
    check(last.size === initial.size && last.mtimeMs === initial.mtimeMs);
    return { sha256: hash.digest('hex'), sizeBytes, ...(maximum === undefined ? {} : { text: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) }) };
  } finally { closeSync(fd); }
}
function syncFile(path: string): void {
  regularFile(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  check(value && typeof value === 'object' && !Array.isArray(value));
  check(Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)));
  return value as Record<string, unknown>;
}
function manifest(value: unknown, dataDir: string, id: string): MigrationSnapshotManifest {
  const body = object(value, ['format', 'version', 'id', 'createdAt', 'fromSchemaVersion', 'toSchemaVersion', 'scope', 'mediaFilesIncluded', 'credentialsIncluded', 'source', 'database']);
  check(body.format === 'owntake.migration-snapshot' && body.version === 1 && body.id === id && snapshotName.test(id));
  check(typeof body.createdAt === 'string' && Number.isFinite(Date.parse(body.createdAt)));
  check(typeof body.fromSchemaVersion === 'number' && Number.isSafeInteger(body.fromSchemaVersion) && body.fromSchemaVersion >= 1 && typeof body.toSchemaVersion === 'number' && Number.isSafeInteger(body.toSchemaVersion) && body.toSchemaVersion > body.fromSchemaVersion);
  check(id.startsWith(`v${body.fromSchemaVersion}-to-v${body.toSchemaVersion}-`));
  check(body.scope === 'database-only' && body.mediaFilesIncluded === false && body.credentialsIncluded === false);
  const source = object(body.source, ['databasePath', 'projectsDir']);
  check(source.databasePath === join(dataDir, 'app.sqlite'));
  check(typeof source.projectsDir === 'string' && source.projectsDir.length <= 4096 && !source.projectsDir.includes('\0') && isAbsolute(source.projectsDir) && resolve(source.projectsDir) === source.projectsDir);
  const database = object(body.database, ['path', 'sha256', 'sizeBytes']);
  check(database.path === 'app.sqlite' && typeof database.sha256 === 'string' && /^[a-f0-9]{64}$/.test(database.sha256) && typeof database.sizeBytes === 'number' && Number.isSafeInteger(database.sizeBytes) && database.sizeBytes > 0);
  return body as unknown as MigrationSnapshotManifest;
}
function checkDatabase(path: string, expectedVersion: number): void {
  regularFile(path);
  const snapshot = new DatabaseSync(path, { readOnly: true });
  try {
    snapshot.exec('PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON;');
    check(Number(snapshot.prepare('PRAGMA user_version').get()?.user_version) === expectedVersion);
    check(snapshot.prepare('PRAGMA quick_check').get()?.quick_check === 'ok');
    check(snapshot.prepare('PRAGMA foreign_key_check').all().length === 0);
  } finally { snapshot.close(); }
}
function verifyFiles(directory: string, dataDir: string, id: string): MigrationSnapshotManifest {
  normalDirectory(directory);
  // A sidecar could alter SQLite's view independently of the main-file digest.
  check(JSON.stringify(readdirSync(directory).sort()) === JSON.stringify(['app.sqlite', 'manifest.json']));
  const metadata = readFileDigest(join(directory, 'manifest.json'), 64 * 1024);
  const result = manifest(JSON.parse(metadata.text!), dataDir, id), databasePath = join(directory, 'app.sqlite');
  const digest = readFileDigest(databasePath);
  check(digest.sha256 === result.database.sha256 && digest.sizeBytes === result.database.sizeBytes);
  checkDatabase(databasePath, result.fromSchemaVersion);
  const after = readFileDigest(databasePath);
  check(after.sha256 === digest.sha256 && after.sizeBytes === digest.sizeBytes);
  return result;
}

/** Verifies a local metadata snapshot without following manifest-supplied file paths or restoring anything. */
export function verifyMigrationSnapshot(dataDir: string, snapshotDirectory: string): MigrationSnapshotManifest {
  try {
    const { data, migrations } = rootDirectory(dataDir, false), directory = resolve(snapshotDirectory), id = basename(directory);
    check(dirname(directory) === migrations && snapshotName.test(id));
    return verifyFiles(directory, data, id);
  } catch (error) {
    if (error instanceof AppError && error.code === invalidCode) throw error;
    throw new AppError(invalidCode, '迁移前快照无法安全读取或校验；原数据库未被替换。', 409);
  }
}

/**
 * Synchronous WAL-aware snapshot before schema DDL. The service must already own
 * its data-directory lock and must not start any scheduler until migration ends.
 * This captures SQLite (including durable BLOB receipts), not external media files.
 */
export function backupBeforeMigration(source: MigrationSource): MigrationSnapshot | null {
  const version = Number(source.db.prepare('PRAGMA user_version').get()?.user_version);
  invariant(Number.isSafeInteger(version) && version >= 0, 'DATABASE_VERSION_INVALID', '数据库版本标记无效，已停止初始化；现有数据未重置。', 409);
  invariant(Number.isSafeInteger(source.targetSchemaVersion) && source.targetSchemaVersion >= 1, 'DATABASE_VERSION_INVALID', '目标数据库版本无效。', 409);
  if (version === 0) {
    invariant(!source.db.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get(), 'DATABASE_UNVERSIONED', '现有数据库包含数据结构但没有有效版本；已停止初始化，请核对原数据库，不能将其当作新项目重置。', 409);
    return null;
  }
  if (version >= source.targetSchemaVersion) return null;
  let staging: string | undefined, stagingIdentity: Stats | undefined, published = false;
  try {
    invariant(!source.db.isTransaction, 'TRANSACTION_ACTIVE', '迁移快照须在事务外执行。', 409);
    const { data, migrations } = rootDirectory(source.dataDir, true);
    const databasePath = join(data, 'app.sqlite'), location = source.db.location();
    check(location !== null && resolve(location) === databasePath);
    const sourceFile = lstatSync(databasePath);
    check(sourceFile.isFile() && !sourceFile.isSymbolicLink() && realpathSync(databasePath) === databasePath);
    const projectsDir = realpathSync(source.projectsDir);
    normalDirectory(projectsDir);
    const id = `v${version}-to-v${source.targetSchemaVersion}-${Date.now()}-${randomUUID()}`;
    const directory = join(migrations, id);
    staging = join(migrations, `.${id}.partial`);
    mkdirSync(staging, { mode: 0o700 }); stagingIdentity = normalDirectory(staging);
    const snapshotPath = join(staging, 'app.sqlite'), fd = openSync(snapshotPath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    try { fchmodSync(fd, 0o600); } finally { closeSync(fd); }
    source.db.exec('PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=5000;');
    source.db.prepare('VACUUM INTO ?').run(snapshotPath);
    checkDatabase(snapshotPath, version);
    syncFile(snapshotPath);
    const digest = readFileDigest(snapshotPath);
    const metadata: MigrationSnapshotManifest = {
      format: 'owntake.migration-snapshot', version: 1, id, createdAt: new Date().toISOString(),
      fromSchemaVersion: version, toSchemaVersion: source.targetSchemaVersion, scope: 'database-only', mediaFilesIncluded: false, credentialsIncluded: false,
      source: { databasePath, projectsDir }, database: { path: 'app.sqlite', sha256: digest.sha256, sizeBytes: digest.sizeBytes },
    };
    const manifestPath = join(staging, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify(metadata, null, 2), { flag: 'wx', mode: 0o600 });
    syncFile(manifestPath); syncDirectory(staging);
    verifyFiles(staging, data, id);
    check(rootDirectory(source.dataDir, false).migrations === migrations && !exists(directory));
    check(normalDirectory(staging).ino === stagingIdentity.ino && normalDirectory(staging).dev === stagingIdentity.dev);
    renameSync(staging, directory); published = true;
    syncDirectory(migrations);
    verifyMigrationSnapshot(data, directory);
    return { directory, manifest: metadata };
  } catch (error) {
    if (staging && stagingIdentity && !published) {
      try {
        const root = rootDirectory(source.dataDir, false), current = normalDirectory(staging);
        if (dirname(staging) === root.migrations && current.ino === stagingIdentity.ino && current.dev === stagingIdentity.dev) rmSync(staging, { recursive: true, force: true });
      } catch { /* Never follow a changed path just to remove an incomplete snapshot. */ }
    }
    throw new AppError('MIGRATION_BACKUP_FAILED', '迁移前数据库快照未能安全完成，已停止升级；请检查备份目录权限、磁盘空间和数据库完整性，现有数据未重置。', 503, { reason: error instanceof AppError ? error.code : 'SNAPSHOT_IO_FAILED' });
  }
}
