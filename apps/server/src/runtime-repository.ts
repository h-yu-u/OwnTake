import { randomUUID } from 'node:crypto';
import type { Store } from '../../../packages/storage/src/index.ts';
import type { LocalRuntimeProfile } from '../../../packages/contracts/src/runtimes.ts';
import { AppError, invariant } from '../../../packages/contracts/src/errors.ts';
import { record, resourceId } from '../../../packages/domain/src/validation.ts';
import { validateLocalRuntime } from '../../../packages/runtimes/src/local.ts';

export class RuntimeRepository {
  readonly store: Store;
  constructor(store: Store) { this.store = store; }
  get(id: string): LocalRuntimeProfile {
    const row = this.store.db.prepare('SELECT body_json FROM runtime_profiles WHERE id=?').get(resourceId(id));
    if (!row) throw new AppError('RUNTIME_NOT_FOUND', '本机运行时配置不存在', 404);
    return JSON.parse(String(row.body_json)) as LocalRuntimeProfile;
  }
  list(): LocalRuntimeProfile[] { return this.store.db.prepare('SELECT body_json FROM runtime_profiles ORDER BY rowid').all().map(row => JSON.parse(String(row.body_json))); }
  save(value: unknown, id?: string): LocalRuntimeProfile {
    const { trustAcknowledged, ...input } = record(value), previous = id ? this.get(id) : undefined;
    invariant(input.enabled !== true || trustAcknowledged === true, 'RUNTIME_TRUST_REQUIRED', '启用前请明确认可这是会使用本机 CLI 认证与权限的可信扩展', 409);
    const now = new Date(Math.max(Date.now(), previous ? Date.parse(previous.updatedAt) + 1 : 0)).toISOString();
    const profile = validateLocalRuntime(input, { id: id ?? randomUUID(), createdAt: previous?.createdAt ?? now, updatedAt: now });
    this.store.db.prepare('INSERT INTO runtime_profiles(id,body_json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body_json=excluded.body_json').run(profile.id, JSON.stringify(profile));
    return profile;
  }
}
