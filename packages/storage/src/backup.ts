import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { invariant } from '../../contracts/src/errors.ts';
import { artifactRelativePath, existingProjectFile, inside, projectDirectory } from './paths.ts';
import { SCHEMA_VERSION } from './schema.ts';
import { integer, parseJson, validateId } from './validation.ts';

interface BackupSource { db: DatabaseSync; dataDir: string; projectsDir: string; schemaVersion: number }
interface SavedAsset { id: string; projectId: string; relativePath: string; sha256: string; sizeBytes: number }
interface FileDigest { sha256: string; sizeBytes: number }
export interface BackupManifest {
  format: 'owntake.backup'; version: 1; schemaVersion: number; createdAt: string;
  credentialsIncluded: false; database: FileDigest & { path: 'app.sqlite' };
  projects: { id: string }[]; artifacts: SavedAsset[];
}

async function digest(file: string): Promise<FileDigest> {
  const hash = createHash('sha256'); let sizeBytes = 0;
  for await (const chunk of createReadStream(file)) { hash.update(chunk); sizeBytes += chunk.length; }
  return { sha256: hash.digest('hex'), sizeBytes };
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

function snapshotIndex(db: DatabaseSync): Pick<BackupManifest, 'projects' | 'artifacts'> {
  const projects = db.prepare('SELECT id FROM projects ORDER BY id').all().map(row => ({ id: String(row.id) }));
  const artifacts = db.prepare('SELECT id,project_id,relative_path,sha256,size_bytes FROM artifacts ORDER BY id').all().map(row => ({ id: String(row.id), projectId: String(row.project_id), relativePath: String(row.relative_path), sha256: String(row.sha256), sizeBytes: Number(row.size_bytes) }));
  for (const project of projects) validateId(project.id);
  const projectIds = new Set(projects.map(project => project.id));
  for (const artifact of artifacts) {
    validateId(artifact.id); validateId(artifact.projectId); artifactRelativePath(artifact.relativePath, artifact.id);
    invariant(projectIds.has(artifact.projectId), 'BACKUP_INVALID', '备份中有无法归属项目的素材。', 409);
    invariant(/^[a-f0-9]{64}$/.test(artifact.sha256), 'BACKUP_INVALID', '备份素材摘要无效。', 409);
    integer(artifact.sizeBytes, '备份素材大小');
  }
  return { projects, artifacts };
}

function openSnapshot(path: string): DatabaseSync {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('PRAGMA trusted_schema = OFF; PRAGMA foreign_keys = ON;');
    const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
    invariant(version === SCHEMA_VERSION, 'BACKUP_VERSION', '备份数据库版本与应用不兼容。', 409);
    invariant(db.prepare('PRAGMA quick_check').get()?.quick_check === 'ok', 'BACKUP_INVALID', '备份数据库完整性检查失败。', 409);
    invariant(db.prepare('PRAGMA foreign_key_check').all().length === 0, 'BACKUP_INVALID', '备份中的数据库引用无效。', 409);
    return db;
  } catch (error) { db.close(); throw error; }
}

/** Snapshot SQLite first; immutable media are then copied against that snapshot. */
export async function createBackup(source: BackupSource, destination: string): Promise<BackupManifest> {
  const target = resolve(destination);
  invariant(!(await exists(target)), 'BACKUP_TARGET_EXISTS', '备份目标已经存在，请使用新目录。', 409);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const staging = resolve(dirname(target), `.owntake-backup-${randomUUID()}.partial`);
  await mkdir(staging, { mode: 0o700 });
  try {
    const databasePath = resolve(staging, 'app.sqlite');
    // Parameter binding also handles spaces, Chinese names and quotes in the target path.
    source.db.prepare('VACUUM INTO ?').run(databasePath);
    await chmod(databasePath, 0o600);
    const snapshot = openSnapshot(databasePath);
    let index: Pick<BackupManifest, 'projects' | 'artifacts'>;
    try { index = snapshotIndex(snapshot); } finally { snapshot.close(); }
    for (const project of index.projects) await mkdir(resolve(staging, 'projects', project.id), { recursive: true, mode: 0o700 });
    for (const asset of index.artifacts) {
      const from = existingProjectFile(projectDirectory(source.projectsDir, asset.projectId), asset.relativePath);
      const to = resolve(staging, 'projects', asset.projectId, asset.relativePath);
      await mkdir(dirname(to), { recursive: true, mode: 0o700 });
      await copyFile(from, to, constants.COPYFILE_EXCL);
      const copied = await digest(to);
      invariant(copied.sha256 === asset.sha256 && copied.sizeBytes === asset.sizeBytes, 'BACKUP_ASSET_CHANGED', '素材缺失、损坏或在备份期间发生变化。备份未发布。', 409);
    }
    const manifest: BackupManifest = { format: 'owntake.backup', version: 1, schemaVersion: source.schemaVersion, createdAt: new Date().toISOString(), credentialsIncluded: false, database: { path: 'app.sqlite', ...await digest(databasePath) }, ...index };
    await writeFile(resolve(staging, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
    invariant(!(await exists(target)), 'BACKUP_TARGET_EXISTS', '备份目标在执行期间已经创建，请使用新目录。', 409);
    await rename(staging, target);
    return manifest;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

function validateManifest(value: unknown): BackupManifest {
  invariant(value !== null && typeof value === 'object', 'BACKUP_INVALID', '备份清单无效。', 409);
  const manifest = value as BackupManifest;
  invariant(manifest.format === 'owntake.backup' && manifest.version === 1 && manifest.schemaVersion === SCHEMA_VERSION, 'BACKUP_VERSION', '备份格式或版本不兼容。', 409);
  invariant(manifest.credentialsIncluded === false && manifest.database?.path === 'app.sqlite' && /^[a-f0-9]{64}$/.test(manifest.database.sha256), 'BACKUP_INVALID', '备份数据库清单无效。', 409);
  integer(manifest.database.sizeBytes, '数据库备份大小', 1);
  invariant(Array.isArray(manifest.projects) && Array.isArray(manifest.artifacts), 'BACKUP_INVALID', '备份项目或素材清单缺失。', 409);
  return manifest;
}

async function requireEmptyDirectory(path: string): Promise<void> {
  if (!(await exists(path))) return;
  const info = await lstat(path);
  invariant(info.isDirectory() && !info.isSymbolicLink(), 'RESTORE_TARGET_NOT_EMPTY', '恢复目标必须是空的普通目录。', 409);
  invariant((await readdir(path)).length === 0, 'RESTORE_TARGET_NOT_EMPTY', '恢复不会覆盖现有数据，请选择空目录。', 409);
}

/** Resolve existing ancestors as well as missing destinations, including directory aliases. */
async function canonicalDestination(path: string): Promise<string> {
  const target = resolve(path);
  try { return await realpath(target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return resolve(await canonicalDestination(dirname(target)), basename(target));
  }
}

/** Restores into empty destinations only. Caller must keep the application stopped. */
export async function restoreBackup(backupDir: string, options: { dataDir: string; projectsDir: string }): Promise<BackupManifest> {
  const source = await realpath(backupDir);
  const manifestPath = existingProjectFile(source, 'manifest.json');
  invariant((await stat(manifestPath)).size <= 16_777_216, 'BACKUP_INVALID', '备份清单过大。', 409);
  const manifest = validateManifest(parseJson(await readFile(manifestPath, 'utf8')));
  const databasePath = existingProjectFile(source, 'app.sqlite');
  const databaseDigest = await digest(databasePath);
  invariant(databaseDigest.sha256 === manifest.database.sha256 && databaseDigest.sizeBytes === manifest.database.sizeBytes, 'BACKUP_INVALID', '备份数据库摘要不匹配。', 409);
  const snapshot = openSnapshot(databasePath);
  let index: Pick<BackupManifest, 'projects' | 'artifacts'>;
  try { index = snapshotIndex(snapshot); } finally { snapshot.close(); }
  // Paths come from the checked database, not arbitrary manifest input.
  invariant(JSON.stringify(index.projects) === JSON.stringify(manifest.projects) && JSON.stringify(index.artifacts) === JSON.stringify(manifest.artifacts), 'BACKUP_INVALID', '清单与数据库引用不一致。', 409);
  for (const asset of index.artifacts) {
    const file = existingProjectFile(source, `projects/${asset.projectId}/${asset.relativePath}`);
    const value = await digest(file);
    invariant(value.sha256 === asset.sha256 && value.sizeBytes === asset.sizeBytes, 'BACKUP_INVALID', '备份素材摘要不匹配，恢复已停止。', 409);
  }
  await requireEmptyDirectory(resolve(options.dataDir)); await requireEmptyDirectory(resolve(options.projectsDir));
  const dataDir = await canonicalDestination(options.dataDir); const projectsDir = await canonicalDestination(options.projectsDir);
  invariant(dataDir !== projectsDir && !inside(projectsDir, dataDir), 'RESTORE_TARGET_INVALID', '数据库目录不能位于项目目录内。');
  invariant(source !== dataDir && source !== projectsDir && !inside(source, dataDir) && !inside(source, projectsDir), 'RESTORE_TARGET_INVALID', '不能向备份目录内部恢复。');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await mkdir(projectsDir, { recursive: true, mode: 0o700 });
  const canonicalProjects = await realpath(projectsDir);
  for (const project of index.projects) {
    const directory = resolve(canonicalProjects, project.id);
    await mkdir(directory, { mode: 0o700 });
    for (const folder of ['assets', 'exports', '.work']) await mkdir(resolve(directory, folder), { mode: 0o700 });
    await writeFile(resolve(directory, 'project.owntake.json'), JSON.stringify({ schemaVersion: 1, id: project.id }, null, 2), { flag: 'wx', mode: 0o600 });
  }
  for (const asset of index.artifacts) {
    const from = existingProjectFile(source, `projects/${asset.projectId}/${asset.relativePath}`);
    const to = resolve(canonicalProjects, asset.projectId, asset.relativePath);
    await mkdir(dirname(to), { recursive: true, mode: 0o700 });
    await copyFile(from, to, constants.COPYFILE_EXCL);
    const copied = await digest(to);
    invariant(copied.sha256 === asset.sha256 && copied.sizeBytes === asset.sizeBytes, 'BACKUP_INVALID', '恢复时素材发生变化，数据库未发布。', 409);
  }
  // Publish the usable database last; partial media never appear as a complete restored app.
  const temporaryDb = resolve(dataDir, `.restore-${randomUUID()}.sqlite`);
  await copyFile(databasePath, temporaryDb, constants.COPYFILE_EXCL);
  await chmod(temporaryDb, 0o600);
  const copiedDb = await digest(temporaryDb);
  invariant(copiedDb.sha256 === manifest.database.sha256, 'BACKUP_INVALID', '恢复时数据库发生变化。', 409);
  await rename(temporaryDb, resolve(dataDir, 'app.sqlite'));
  return manifest;
}
