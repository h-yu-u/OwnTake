import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AppEvent, AppSettings, Artifact, Project, ProjectSnapshot, Ratio, Timeline, TimelineDraft } from '../../contracts/src/index.ts';
import { AppError, invariant } from '../../contracts/src/errors.ts';
import { createBackup } from './backup.ts';
import { backupBeforeMigration } from './migration-backup.ts';
import type { MigrationSnapshot } from './migration-backup.ts';
import { artifactFromRow, eventFromRow, projectFromRow, timelineFromRow } from './mapping.ts';
import { JobRepository } from './jobs.ts';
import type { CreateJobInput, JobPatch } from './jobs.ts';
import { artifactRelativePath, existingProjectFile, projectDirectory } from './paths.ts';
import { initializeSchema, SCHEMA_VERSION } from './schema.ts';
import { integer, json, objectJson, parseJson, ratioValue, stringValue, validateId, validateMedia, validateTimeline } from './validation.ts';

export interface StoreOptions { dataDir: string; projectsDir: string }
export interface CreateProjectInput { name: string; brief?: string; ratio?: Ratio }
export type ProjectPatch = Partial<Pick<Project, 'name' | 'brief' | 'ratio'>>;
export type NewArtifact = Omit<Artifact, 'createdAt'> & { createdAt?: string };

export class Store {
  readonly db: DatabaseSync;
  readonly dataDir: string;
  readonly projectsDir: string;
  readonly databasePath: string;
  readonly schemaVersion = SCHEMA_VERSION;
  readonly migrationSnapshot: MigrationSnapshot | null;
  private readonly jobs: JobRepository;
  private depth = 0;
  private savepoint = 0;
  private closed = false;

  constructor(options: StoreOptions) {
    mkdirSync(resolve(options.dataDir), { recursive: true, mode: 0o700 });
    mkdirSync(resolve(options.projectsDir), { recursive: true, mode: 0o700 });
    this.dataDir = realpathSync(options.dataDir);
    this.projectsDir = realpathSync(options.projectsDir);
    this.databasePath = resolve(this.dataDir, 'app.sqlite');
    this.db = new DatabaseSync(this.databasePath);
    try {
      this.migrationSnapshot = backupBeforeMigration({ db: this.db, dataDir: this.dataDir, projectsDir: this.projectsDir, targetSchemaVersion: SCHEMA_VERSION });
      initializeSchema(this.db); chmodSync(this.databasePath, 0o600);
    } catch (error) { try { this.db.close(); } catch { /* Preserve the initialization error. */ } throw error; }
    this.jobs = new JobRepository(this);
  }

  close(): void {
    if (this.closed) return;
    invariant(this.depth === 0, 'TRANSACTION_ACTIVE', '事务执行中不能关闭数据库。', 409);
    this.db.close(); this.closed = true;
  }

  /** Only synchronous work belongs in a SQLite transaction; nested calls use savepoints. */
  transaction<T>(fn: () => T): T {
    invariant(!this.closed, 'STORE_CLOSED', '数据库已经关闭。', 409);
    invariant(fn.constructor.name !== 'AsyncFunction', 'ASYNC_TRANSACTION', '数据库事务内不能等待异步操作。');
    const nested = this.depth > 0;
    const name = `sp_${++this.savepoint}`;
    this.db.exec(nested ? `SAVEPOINT ${name}` : 'BEGIN IMMEDIATE');
    this.depth += 1;
    try {
      const result = fn();
      invariant(!(result && typeof (result as { then?: unknown }).then === 'function'), 'ASYNC_TRANSACTION', '数据库事务必须同步完成。');
      this.db.exec(nested ? `RELEASE SAVEPOINT ${name}` : 'COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec(nested ? `ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name}` : 'ROLLBACK'); } catch { /* Preserve the original failure. */ }
      throw error;
    } finally { this.depth -= 1; }
  }

  createProject(input: CreateProjectInput): Project {
    const name = stringValue(input.name, '项目名称', 200);
    const brief = stringValue(input.brief ?? '', '项目简报', 20000, true);
    const ratio = ratioValue(input.ratio ?? '16:9');
    const id = `project_${randomUUID()}`;
    const directory = resolve(this.projectsDir, id);
    mkdirSync(directory, { mode: 0o700 });
    for (const folder of ['assets', 'exports', '.work']) mkdirSync(resolve(directory, folder), { mode: 0o700 });
    writeFileSync(resolve(directory, 'project.owntake.json'), JSON.stringify({ schemaVersion: 1, id }, null, 2), { flag: 'wx', mode: 0o600 });
    return this.transaction(() => {
      const now = new Date().toISOString();
      this.db.prepare('INSERT INTO projects (id,name,brief,ratio,revision,created_at,updated_at) VALUES (?,?,?,?,1,?,?)').run(id, name, brief, ratio, now, now);
      this.appendEvent(id, 'project.created', { projectId: id });
      return this.getProject(id);
    });
  }

  listProjects(): Project[] {
    return this.db.prepare('SELECT * FROM projects ORDER BY updated_at DESC, rowid DESC').all().map(projectFromRow);
  }

  getProject(id: string): Project {
    validateId(id);
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
    if (!row) throw new AppError('PROJECT_NOT_FOUND', '项目不存在。', 404);
    return projectFromRow(row);
  }

  updateProject(id: string, patch: ProjectPatch, expectedRevision: number): Project {
    integer(expectedRevision, '期望项目版本', 1);
    invariant(patch && typeof patch === 'object' && Object.keys(patch).every(key => ['name', 'brief', 'ratio'].includes(key)), 'INVALID_INPUT', '项目更新包含不允许的字段。');
    return this.transaction(() => {
      const current = this.getProject(id);
      invariant(current.revision === expectedRevision, 'REVISION_CONFLICT', '项目已被更新，请重新读取后合并修改。', 409);
      const name = patch.name === undefined ? current.name : stringValue(patch.name, '项目名称', 200);
      const brief = patch.brief === undefined ? current.brief : stringValue(patch.brief, '项目简报', 20000, true);
      const ratio = patch.ratio === undefined ? current.ratio : ratioValue(patch.ratio);
      this.db.prepare('UPDATE projects SET name=?,brief=?,ratio=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?').run(name, brief, ratio, new Date().toISOString(), id, expectedRevision);
      this.appendEvent(id, 'project.updated', { projectId: id, revision: expectedRevision + 1 });
      return this.getProject(id);
    });
  }

  getProjectDir(id: string): string {
    this.getProject(id);
    return projectDirectory(this.projectsDir, id);
  }

  addArtifact(input: NewArtifact): Artifact {
    validateId(input.id); validateId(input.projectId);
    const name = stringValue(input.name, '素材名称', 255);
    const path = artifactRelativePath(input.relativePath, input.id);
    invariant(['image', 'video', 'audio'].includes(input.kind), 'INVALID_INPUT', '无效的素材类型。');
    invariant(['import', 'generated', 'render', 'composite'].includes(input.source), 'INVALID_INPUT', '无效的素材来源。');
    invariant(/^[a-f0-9]{64}$/.test(input.sha256), 'INVALID_INPUT', '素材摘要格式无效。');
    integer(input.sizeBytes, '素材大小'); validateMedia(input.media);
    invariant(input.media.kind === input.kind, 'INVALID_INPUT', '素材与媒体类型不一致。');
    const file = existingProjectFile(this.getProjectDir(input.projectId), path);
    invariant(statSync(file).size === input.sizeBytes, 'ASSET_UNAVAILABLE', '素材大小已变化，无法登记为可用版本。', 409);
    const media = objectJson(input.media); const metadata = objectJson(input.metadata);
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM artifacts WHERE id=? OR (project_id=? AND relative_path=?)').get(input.id, input.projectId, path);
      if (existing) {
        const asset = artifactFromRow(existing);
        const { createdAt: _createdAt, ...data } = asset;
        invariant(json(data) === json({ id: input.id, projectId: input.projectId, name, kind: input.kind, relativePath: path, sha256: input.sha256, sizeBytes: input.sizeBytes, media: input.media, source: input.source, metadata: input.metadata }), 'ARTIFACT_CONFLICT', '已有素材版本不能改写或覆盖。', 409);
        return asset;
      }
      const createdAt = input.createdAt ?? new Date().toISOString();
      invariant(Number.isFinite(Date.parse(createdAt)), 'INVALID_INPUT', '素材创建时间无效。');
      this.db.prepare('INSERT INTO artifacts (id,project_id,name,kind,relative_path,sha256,size_bytes,media_json,source,metadata_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(input.id, input.projectId, name, input.kind, path, input.sha256, input.sizeBytes, media, input.source, metadata, createdAt);
      this.appendEvent(input.projectId, 'artifact.ready', { artifactId: input.id });
      return this.getArtifact(input.id);
    });
  }

  getArtifact(id: string): Artifact {
    validateId(id);
    const row = this.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id);
    if (!row) throw new AppError('ARTIFACT_NOT_FOUND', '素材版本不存在。', 404);
    return artifactFromRow(row);
  }

  listArtifacts(projectId: string): Artifact[] {
    this.getProject(projectId);
    return this.db.prepare('SELECT * FROM artifacts WHERE project_id = ? ORDER BY created_at, rowid').all(projectId).map(artifactFromRow);
  }

  resolveArtifactPath(id: string): string {
    const asset = this.getArtifact(id);
    return existingProjectFile(this.getProjectDir(asset.projectId), asset.relativePath);
  }

  saveTimeline(projectId: string, draft: TimelineDraft, expectedVersion: number): Timeline {
    integer(expectedVersion, '期望时间线版本');
    return this.transaction(() => {
      this.getProject(projectId);
      const current = this.getLatestTimeline(projectId);
      invariant((current?.version ?? 0) === expectedVersion, 'REVISION_CONFLICT', '时间线已被更新，请重新读取后合并修改。', 409);
      validateTimeline(draft, id => {
        const asset = this.getArtifact(id);
        invariant(asset.projectId === projectId, 'INVALID_REFERENCE', '时间线不能引用其他项目的素材。');
        return asset;
      });
      const id = `timeline_${randomUUID()}`;
      this.db.prepare('INSERT INTO timelines (id,project_id,version,body_json,created_at) VALUES (?,?,?,?,?)').run(id, projectId, expectedVersion + 1, json(draft), new Date().toISOString());
      this.appendEvent(projectId, 'timeline.saved', { timelineId: id, version: expectedVersion + 1 });
      return this.getTimeline(id);
    });
  }

  getTimeline(id: string): Timeline {
    validateId(id);
    const row = this.db.prepare('SELECT * FROM timelines WHERE id=?').get(id);
    if (!row) throw new AppError('TIMELINE_NOT_FOUND', '时间线版本不存在。', 404);
    return timelineFromRow(row);
  }

  getLatestTimeline(projectId: string): Timeline | null {
    this.getProject(projectId);
    const row = this.db.prepare('SELECT * FROM timelines WHERE project_id=? ORDER BY version DESC LIMIT 1').get(projectId);
    return row ? timelineFromRow(row) : null;
  }

  createJob(input: CreateJobInput) { return this.jobs.create(input); }
  getJob(id: string) { return this.jobs.get(id); }
  listJobs(projectId: string) { return this.jobs.list(projectId); }
  listRecoverableJobs() { return this.jobs.recoverable(); }
  updateJob(id: string, patch: JobPatch) { return this.jobs.update(id, patch); }

  appendEvent(projectId: string, type: string, data: Record<string, unknown>): AppEvent {
    this.getProject(projectId);
    invariant(/^[a-z][a-z0-9_.-]{0,99}$/.test(type), 'INVALID_INPUT', '事件类型格式无效。');
    const encoded = objectJson(data);
    return this.transaction(() => {
      const now = new Date().toISOString();
      const result = this.db.prepare('INSERT INTO events (project_id,type,data_json,created_at) VALUES (?,?,?,?)').run(projectId, type, encoded, now);
      return { seq: Number(result.lastInsertRowid), projectId, type, data: parseJson(encoded), createdAt: now };
    });
  }

  listEvents(projectId: string, after = 0, limit = 1000): AppEvent[] {
    this.getProject(projectId); integer(after, '事件游标'); integer(limit, '事件数量', 1, 10000);
    return this.db.prepare('SELECT * FROM events WHERE project_id=? AND seq>? ORDER BY seq LIMIT ?').all(projectId, after, limit).map(eventFromRow);
  }

  getEventCursor(): number {
    return Number(this.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events').get()?.seq ?? 0);
  }

  snapshot(projectId: string): ProjectSnapshot {
    return this.transaction(() => ({ project: this.getProject(projectId), artifacts: this.listArtifacts(projectId), timeline: this.getLatestTimeline(projectId), jobs: this.listJobs(projectId), eventCursor: this.getEventCursor() }));
  }

  getSettings(): AppSettings {
    const row = this.db.prepare("SELECT value_json FROM settings WHERE key='media'").get();
    return row ? parseJson<AppSettings>(row.value_json) : { ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' };
  }

  updateSettings(patch: Partial<AppSettings>): AppSettings {
    invariant(patch && typeof patch === 'object' && Object.keys(patch).every(key => ['ffmpegPath', 'ffprobePath', 'subtitleFontPath'].includes(key)), 'INVALID_INPUT', '设置包含不允许的字段。');
    const next = { ...this.getSettings() };
    for (const key of ['ffmpegPath', 'ffprobePath'] as const) if (patch[key] !== undefined) next[key] = stringValue(patch[key], '工具路径', 2048);
    if (patch.subtitleFontPath !== undefined) { if (patch.subtitleFontPath === '') delete next.subtitleFontPath; else next.subtitleFontPath = stringValue(patch.subtitleFontPath, '字幕字体路径', 2048); }
    this.db.prepare("INSERT INTO settings (key,value_json) VALUES ('media',?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json").run(json(next));
    return next;
  }

  backupTo(destination: string) {
    invariant(this.depth === 0 && !this.closed, 'TRANSACTION_ACTIVE', '备份需在事务外执行。', 409);
    return createBackup(this, destination);
  }
}
