import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AppEvent, Job, JobStatus, Project } from '../../contracts/src/index.ts';
import { AppError, invariant } from '../../contracts/src/errors.ts';
import { jobFromRow } from './mapping.ts';
import { finiteNumber, objectJson, requestHash, stringValue, validateId } from './validation.ts';

export interface CreateJobInput { projectId: string; type: string; payload: Record<string, unknown>; dedupeKey: string }
export type JobPatch = Partial<Pick<Job, 'status' | 'progress' | 'result' | 'error'>>;
interface Context {
  db: DatabaseSync;
  transaction<T>(fn: () => T): T;
  getProject(id: string): Project;
  appendEvent(projectId: string, type: string, data: Record<string, unknown>): AppEvent;
}
const statuses: JobStatus[] = ['queued', 'running', 'waiting_external', 'blocked', 'succeeded', 'failed', 'cancel_requested', 'cancelled'];

export class JobRepository {
  private readonly context: Context;
  constructor(context: Context) { this.context = context; }

  create(input: CreateJobInput): Job {
    validateId(input.projectId);
    const type = stringValue(input.type, '任务类型', 64);
    invariant(/^[a-z][a-z0-9_.-]*$/.test(type), 'INVALID_INPUT', '任务类型格式无效。');
    const dedupeKey = stringValue(input.dedupeKey, '操作去重标识', 300);
    const payload = objectJson(input.payload);
    const hash = requestHash({ projectId: input.projectId, type, payload: input.payload });
    return this.context.transaction(() => {
      this.context.getProject(input.projectId);
      const existing = this.context.db.prepare('SELECT * FROM jobs WHERE dedupe_key = ?').get(dedupeKey);
      if (existing) {
        invariant(existing.request_hash === hash, 'IDEMPOTENCY_CONFLICT', '同一个操作标识不能用于不同的任务内容。', 409);
        return jobFromRow(existing);
      }
      const id = `job_${randomUUID()}`;
      const now = new Date().toISOString();
      this.context.db.prepare(`INSERT INTO jobs (id,project_id,type,status,payload_json,result_json,progress,error_json,dedupe_key,request_hash,created_at,updated_at)
        VALUES (?,?,?,'queued',?,NULL,0,NULL,?,?,?,?)`).run(id, input.projectId, type, payload, dedupeKey, hash, now, now);
      this.context.appendEvent(input.projectId, 'job.created', { jobId: id, status: 'queued' });
      return this.get(id);
    });
  }

  get(id: string): Job {
    validateId(id);
    const row = this.context.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
    if (!row) throw new AppError('JOB_NOT_FOUND', '任务不存在。', 404);
    return jobFromRow(row);
  }

  list(projectId: string): Job[] {
    this.context.getProject(projectId);
    return this.context.db.prepare('SELECT * FROM jobs WHERE project_id = ? ORDER BY created_at DESC, rowid DESC').all(projectId).map(jobFromRow);
  }

  recoverable(): Job[] {
    return this.context.db.prepare("SELECT * FROM jobs WHERE status IN ('queued','running','waiting_external','blocked','cancel_requested') ORDER BY created_at, rowid").all().map(jobFromRow);
  }

  update(id: string, patch: JobPatch): Job {
    invariant(patch && typeof patch === 'object' && Object.keys(patch).every(key => ['status', 'progress', 'result', 'error'].includes(key)), 'INVALID_INPUT', '任务更新包含不允许的字段。');
    return this.context.transaction(() => {
      const current = this.get(id);
      const status = patch.status ?? current.status;
      invariant(statuses.includes(status), 'INVALID_INPUT', '无效的任务状态。');
      if (current.status === 'succeeded' || current.status === 'cancelled') {
        invariant(status === current.status, 'JOB_STATE_CONFLICT', '已结束任务不能由迟到结果改变状态。', 409);
        invariant(patch.result === undefined && patch.error === undefined && patch.progress === undefined, 'JOB_STATE_CONFLICT', '已结束任务的结果不能改写。', 409);
        return current;
      }
      const progress = patch.progress ?? (status === 'succeeded' ? 1 : current.progress);
      finiteNumber(progress, '任务进度', 0, 1);
      const result = patch.result === undefined ? current.result : patch.result;
      const error = patch.error === undefined ? current.error : patch.error;
      if (error !== null) {
        invariant(error && typeof error === 'object', 'INVALID_INPUT', '任务错误信息无效。');
        stringValue(error.code, '错误码', 100); stringValue(error.message, '错误信息', 4000);
      }
      this.context.db.prepare('UPDATE jobs SET status=?,progress=?,result_json=?,error_json=?,updated_at=? WHERE id=?')
        .run(status, progress, result === null ? null : objectJson(result), error === null ? null : objectJson(error), new Date().toISOString(), id);
      this.context.appendEvent(current.projectId, 'job.updated', { jobId: id, status, progress });
      return this.get(id);
    });
  }
}
