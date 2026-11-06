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
interface StagedLocation { generationId: string; projectId: string; relativePath: string }
interface StagedSource extends StagedLocation { kind: 'final' | 'receipt'; expectedDigest?: FileDigest }
interface SavedStagedArtifact extends StagedLocation, FileDigest {}
export interface BackupManifest {
  format: 'owntake.backup'; version: 1; schemaVersion: number; createdAt: string;
  credentialsIncluded: false; database: FileDigest & { path: 'app.sqlite' };
  projects: { id: string }[]; artifacts: SavedAsset[];
  /** Complete immutable results received before their Artifact transaction committed. */
  stagedArtifacts?: SavedStagedArtifact[];
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

function snapshotStagedLocations(db: DatabaseSync, index: Pick<BackupManifest, 'projects' | 'artifacts'>): StagedSource[] {
  if (!db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='generations'").get()) return [];
  const projectIds = new Set(index.projects.map(project => project.id));
  const registeredPaths = new Set(index.artifacts.map(asset => `${asset.projectId}/${asset.relativePath}`));
  const stagedPaths = new Set<string>();
  const locations: StagedSource[] = [];
  for (const row of db.prepare('SELECT id,project_id,body_json FROM generations ORDER BY id').all()) {
    const generationId = String(row.id), projectId = String(row.project_id);
    validateId(generationId); validateId(projectId);
    const body = parseJson<Record<string, unknown>>(row.body_json);
    invariant(body && typeof body === 'object' && !Array.isArray(body) && body.id === generationId && body.projectId === projectId && projectIds.has(projectId), 'BACKUP_INVALID', '暂存结果的生成任务归属无效。', 409);
    validateId(body.outputArtifactId);
    const plan = body.plan as { kind?: unknown } | null | undefined;
    invariant(plan?.kind === 'image' || plan?.kind === 'video', 'BACKUP_INVALID', '暂存结果的媒体类型无效。', 409);
    // Neither stagedRelativePath nor outputUrl is trusted as a filesystem destination.
    const relativePath = artifactRelativePath(`assets/${body.outputArtifactId}/received.${plan.kind === 'image' ? 'png' : 'mp4'}`, body.outputArtifactId);
    const path = `${projectId}/${relativePath}`;
    if (registeredPaths.has(path)) continue;
    invariant(!stagedPaths.has(path), 'BACKUP_INVALID', '多个生成任务指向同一个未登记的结果路径。', 409);
    stagedPaths.add(path);
    let expectedDigest: FileDigest | undefined;
    if (body.inlineReceipt !== undefined) {
      const receipt = body.inlineReceipt as Partial<FileDigest> | null;
      invariant(plan.kind === 'image' && receipt && typeof receipt === 'object' && typeof receipt.sha256 === 'string' && /^[a-f0-9]{64}$/.test(receipt.sha256) && Number.isSafeInteger(receipt.sizeBytes) && receipt.sizeBytes! > 0 && receipt.sizeBytes! <= 32 * 1024 * 1024, 'BACKUP_INVALID', '同步图片接收摘要无效。', 409);
      expectedDigest = { sha256: receipt.sha256, sizeBytes: receipt.sizeBytes! };
    }
    locations.push({ generationId, projectId, relativePath, kind: 'final', ...(expectedDigest ? { expectedDigest } : {}) });
    if (expectedDigest) {
      validateId(body.attemptId);
      const receiptPath = artifactRelativePath(`assets/${body.outputArtifactId}/receipt-${body.attemptId}.png`, body.outputArtifactId);
      locations.push({ generationId, projectId, relativePath: receiptPath, kind: 'receipt', expectedDigest });
      locations.push({ generationId, projectId, relativePath: `${receiptPath}.part`, kind: 'receipt', expectedDigest });
    }
  }
  return locations;
}

function checkedStagedArtifacts(manifest: BackupManifest, locations: StagedSource[]): SavedStagedArtifact[] {
  const byPath = new Map(locations.map(location => [`${location.projectId}/${location.relativePath}`, location]));
  const seen = new Set<string>();
  return (manifest.stagedArtifacts ?? []).map(asset => {
    invariant(asset && typeof asset === 'object' && !Array.isArray(asset) && Object.keys(asset).every(key => ['generationId', 'projectId', 'relativePath', 'sha256', 'sizeBytes'].includes(key)), 'BACKUP_INVALID', '暂存结果清单无效。', 409);
    const expected = byPath.get(`${asset.projectId}/${asset.relativePath}`);
    invariant(expected && expected.generationId === asset.generationId && expected.projectId === asset.projectId && expected.relativePath === asset.relativePath && !seen.has(asset.generationId), 'BACKUP_INVALID', '暂存结果清单不匹配数据库中的生成任务，或重复引用同一结果。', 409);
    invariant(typeof asset.sha256 === 'string' && /^[a-f0-9]{64}$/.test(asset.sha256) && Number.isSafeInteger(asset.sizeBytes) && asset.sizeBytes > 0, 'BACKUP_INVALID', '暂存结果的摘要或大小无效。', 409);
    invariant(!expected.expectedDigest || expected.expectedDigest.sha256 === asset.sha256 && expected.expectedDigest.sizeBytes === asset.sizeBytes, 'BACKUP_INVALID', '暂存结果清单与数据库中已记录的接收摘要不一致。', 409);
    seen.add(asset.generationId);
    return { generationId: expected.generationId, projectId: expected.projectId, relativePath: expected.relativePath, sha256: asset.sha256, sizeBytes: asset.sizeBytes };
  });
}

function openSnapshot(path: string, expectedVersion?: number): DatabaseSync {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('PRAGMA trusted_schema = OFF; PRAGMA foreign_keys = ON;');
    const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
    invariant(version >= 1 && version <= SCHEMA_VERSION && (expectedVersion === undefined || version === expectedVersion), 'BACKUP_VERSION', '备份数据库版本与应用不兼容，或与清单不一致。', 409);
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
    const snapshot = openSnapshot(databasePath, source.schemaVersion);
    let index: Pick<BackupManifest, 'projects' | 'artifacts'>;
    let stagedLocations: StagedSource[];
    try { index = snapshotIndex(snapshot); stagedLocations = snapshotStagedLocations(snapshot, index); } finally { snapshot.close(); }
    for (const project of index.projects) await mkdir(resolve(staging, 'projects', project.id), { recursive: true, mode: 0o700 });
    for (const asset of index.artifacts) {
      const from = existingProjectFile(projectDirectory(source.projectsDir, asset.projectId), asset.relativePath);
      const to = resolve(staging, 'projects', asset.projectId, asset.relativePath);
      await mkdir(dirname(to), { recursive: true, mode: 0o700 });
      await copyFile(from, to, constants.COPYFILE_EXCL);
      const copied = await digest(to);
      invariant(copied.sha256 === asset.sha256 && copied.sizeBytes === asset.sizeBytes, 'BACKUP_ASSET_CHANGED', '素材缺失、损坏或在备份期间发生变化。备份未发布。', 409);
    }
    const stagedArtifacts: SavedStagedArtifact[] = [];
    const capturedGenerations = new Set<string>();
    for (const location of stagedLocations) {
      if (capturedGenerations.has(location.generationId)) continue;
      if (!(await exists(resolve(source.projectsDir, location.projectId, location.relativePath)))) continue;
      const projectDir = projectDirectory(source.projectsDir, location.projectId);
      const from = existingProjectFile(projectDir, location.relativePath);
      const original = await digest(from);
      if (location.expectedDigest && (original.sha256 !== location.expectedDigest.sha256 || original.sizeBytes !== location.expectedDigest.sizeBytes)) {
        if (location.kind === 'receipt') continue; // A partial write is not a completed receipt.
        invariant(false, 'BACKUP_ASSET_CHANGED', '已发布结果与接收摘要不匹配，备份未发布。', 409);
      }
      invariant(original.sizeBytes > 0, 'BACKUP_ASSET_CHANGED', '已发布的暂存结果为空，备份未发布。', 409);
      const to = resolve(staging, 'projects', location.projectId, location.relativePath);
      await mkdir(dirname(to), { recursive: true, mode: 0o700 });
      await copyFile(from, to, constants.COPYFILE_EXCL);
      const copied = await digest(to);
      invariant(copied.sha256 === original.sha256 && copied.sizeBytes === original.sizeBytes, 'BACKUP_ASSET_CHANGED', '暂存结果在备份期间发生变化。备份未发布。', 409);
      stagedArtifacts.push({ generationId: location.generationId, projectId: location.projectId, relativePath: location.relativePath, ...copied });
      capturedGenerations.add(location.generationId);
    }
    const manifest: BackupManifest = { format: 'owntake.backup', version: 1, schemaVersion: source.schemaVersion, createdAt: new Date().toISOString(), credentialsIncluded: false, database: { path: 'app.sqlite', ...await digest(databasePath) }, ...index, ...(stagedArtifacts.length ? { stagedArtifacts } : {}) };
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
  invariant(manifest.format === 'owntake.backup' && manifest.version === 1 && Number.isSafeInteger(manifest.schemaVersion) && manifest.schemaVersion >= 1 && manifest.schemaVersion <= SCHEMA_VERSION, 'BACKUP_VERSION', '备份格式或版本不兼容。', 409);
  invariant(manifest.credentialsIncluded === false && manifest.database?.path === 'app.sqlite' && /^[a-f0-9]{64}$/.test(manifest.database.sha256), 'BACKUP_INVALID', '备份数据库清单无效。', 409);
  integer(manifest.database.sizeBytes, '数据库备份大小', 1);
  invariant(Array.isArray(manifest.projects) && Array.isArray(manifest.artifacts), 'BACKUP_INVALID', '备份项目或素材清单缺失。', 409);
  invariant(manifest.stagedArtifacts === undefined || Array.isArray(manifest.stagedArtifacts), 'BACKUP_INVALID', '暂存结果清单必须是列表。', 409);
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
  const snapshot = openSnapshot(databasePath, manifest.schemaVersion);
  let index: Pick<BackupManifest, 'projects' | 'artifacts'>;
  let stagedLocations: StagedSource[];
  try { index = snapshotIndex(snapshot); stagedLocations = snapshotStagedLocations(snapshot, index); } finally { snapshot.close(); }
  // Paths come from the checked database, not arbitrary manifest input.
  invariant(JSON.stringify(index.projects) === JSON.stringify(manifest.projects) && JSON.stringify(index.artifacts) === JSON.stringify(manifest.artifacts), 'BACKUP_INVALID', '清单与数据库引用不一致。', 409);
  const stagedArtifacts = checkedStagedArtifacts(manifest, stagedLocations);
  const listedStages = new Set(stagedArtifacts.map(asset => asset.generationId));
  for (const location of stagedLocations) {
    if (listedStages.has(location.generationId)) continue;
    invariant(!(await exists(resolve(source, 'projects', location.projectId, location.relativePath))), 'BACKUP_INVALID', '备份包含未列入清单的暂存结果，恢复已停止。', 409);
  }
  const mediaFiles = [...index.artifacts, ...stagedArtifacts];
  for (const asset of mediaFiles) {
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
  for (const asset of mediaFiles) {
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
