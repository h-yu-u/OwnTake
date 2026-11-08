import { randomUUID } from 'node:crypto';
import type { Store } from '../../../packages/storage/src/index.ts';
import type { StoryboardStore } from '../../../packages/storage/src/storyboard.ts';
import type { ProviderProfile, ProviderSummary } from '../../../packages/contracts/src/providers.ts';
import type { CallRecord, Reservation } from '../../../packages/contracts/src/calls.ts';
import type { Shot } from '../../../packages/contracts/src/storyboard.ts';
import { AppError, invariant } from '../../../packages/contracts/src/errors.ts';
import { finiteNumber, integer, record, resourceId, text } from '../../../packages/domain/src/validation.ts';
import { requestHash } from '../../../packages/storage/src/validation.ts';
import { validateProfile } from '../../../packages/providers/src/profiles.ts';
import { CredentialVault } from './credentials.ts';
export interface StoredCall extends CallRecord {
  operationId: string; provider: ProviderProfile; credentialRef: string | null;
  input: { brief: string; shots: Shot[]; boardRevision: number; projectRevision: number };
  reservation: Reservation | null; settlementNote?: string;
}
export function publicCall(call: StoredCall): CallRecord {
  const { id, projectId, providerId, jobId, status, currency, reservedAmount, actualAmount, draftId, error, createdAt, updatedAt, budgetMode } = call;
  return { id, projectId, providerId, jobId, status, currency, reservedAmount, actualAmount, draftId, error, createdAt, updatedAt, ...(budgetMode ? { budgetMode } : {}) };
}
function reservationInput(value: unknown): Reservation {
  const v = record(value); invariant(v.currency === 'USD' || v.currency === 'CNY', 'INVALID_CURRENCY', '请选择 USD 或 CNY');
  const amount = finiteNumber(v.amount, '预留金额', 0, 1000000), singleLimit = finiteNumber(v.singleLimit, '单次上限', 0, 1000000), projectLimit = finiteNumber(v.projectLimit, '项目上限', 0, 1000000);
  invariant(amount <= singleLimit && amount <= projectLimit, 'BUDGET_EXCEEDED', '预留金额超过单次或项目额度', 409);
  return { currency: v.currency, amount, singleLimit, projectLimit };
}
export class ProviderRepository {
  readonly store: Store;
  readonly board: StoryboardStore;
  readonly vault: CredentialVault;
  constructor(store: Store, board: StoryboardStore) { this.store = store; this.board = board; this.vault = new CredentialVault(store.dataDir); }
  getProfile(id: string): { profile: ProviderProfile; credentialRef: string | null } {
    resourceId(id); const row = this.store.db.prepare('SELECT * FROM provider_profiles WHERE id=?').get(id);
    if (!row) throw new AppError('PROVIDER_NOT_FOUND', '模型连接不存在', 404);
    return { profile: JSON.parse(String(row.body_json)) as ProviderProfile, credentialRef: row.credential_ref ? String(row.credential_ref) : null };
  }
  listProfiles(): ProviderSummary[] {
    return this.store.db.prepare(`SELECT p.*, managed.connection_id FROM provider_profiles p
      LEFT JOIN openai_connection_profiles managed ON managed.provider_id=p.id ORDER BY p.rowid`).all().map(row => ({
      ...JSON.parse(String(row.body_json)) as ProviderProfile,
      hasKey: this.vault.has(row.credential_ref ? String(row.credential_ref) : null),
      verification: 'unverified',
      ...(row.connection_id ? { connectionId: String(row.connection_id) } : {}),
    }));
  }
  /** Internal persistence boundary; shared-account updates supply one immutable key reference. */
  persistProfile(profile: ProviderProfile, credentialRef: string | null): void {
    this.store.db.prepare('INSERT INTO provider_profiles(id,body_json,credential_ref) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body_json=excluded.body_json,credential_ref=excluded.credential_ref').run(profile.id, JSON.stringify(profile), credentialRef);
  }
  saveProfile(value: unknown, existingId?: string): ProviderSummary {
    if (existingId) {
      resourceId(existingId);
      invariant(!this.store.db.prepare('SELECT 1 FROM openai_connection_profiles WHERE provider_id=?').get(existingId),
        'MANAGED_PROVIDER', '此能力由 OpenAI 连接统一管理，请在 OpenAI 入口修改密钥或模型。', 409);
    }
    const body = record(value), { key, ...data } = body;
    const existing = existingId ? this.getProfile(existingId) : undefined, id = existingId ?? randomUUID(), now = new Date().toISOString();
    const profile = validateProfile({ ...data, id, createdAt: existing?.profile.createdAt ?? now, updatedAt: now });
    invariant(key === undefined || typeof key === 'string', 'INVALID_KEY', 'API 密钥必须是文本');
    invariant(!existing || new URL(existing.profile.baseUrl).origin === new URL(profile.baseUrl).origin || !this.vault.has(existing.credentialRef) || typeof key === 'string' && key.trim().length > 0, 'NEW_ORIGIN_KEY_REQUIRED', '连接地址已更换服务来源，请重新填写该服务的密钥；原密钥不会发送到新来源');
    const credentialRef = typeof key === 'string' && key.trim() ? this.vault.put(key.trim()) : existing?.credentialRef ?? null;
    this.persistProfile(profile, credentialRef);
    return { ...profile, hasKey: this.vault.has(credentialRef), verification: 'unverified' };
  }
  getCall(id: string): StoredCall {
    const row = this.store.db.prepare('SELECT body_json FROM provider_calls WHERE id=?').get(resourceId(id));
    if (!row) throw new AppError('CALL_NOT_FOUND', '模型调用不存在', 404);
    return JSON.parse(String(row.body_json)) as StoredCall;
  }
  listCalls(projectId: string): CallRecord[] {
    this.store.getProject(projectId);
    return this.store.db.prepare('SELECT body_json FROM provider_calls WHERE project_id=? ORDER BY rowid DESC').all(projectId).map(row => publicCall(JSON.parse(String(row.body_json))));
  }
  allCalls(): StoredCall[] { return this.store.db.prepare('SELECT body_json FROM provider_calls ORDER BY rowid').all().map(row => JSON.parse(String(row.body_json)) as StoredCall); }
  saveCall(call: StoredCall): void {
    call.updatedAt = new Date().toISOString();
    this.store.db.prepare('UPDATE provider_calls SET status=?,body_json=? WHERE id=?').run(call.status, JSON.stringify(call), call.id);
    this.store.appendEvent(call.projectId, 'call.updated', { callId: call.id, status: call.status });
  }
  exposure(projectId: string, currency: string): number {
    const calls = this.listCalls(projectId).filter(c => c.currency === currency).reduce((sum, c) => sum + (c.actualAmount ?? c.reservedAmount), 0);
    const generations = this.store.db.prepare('SELECT body_json FROM generations WHERE project_id=?').all(projectId).map(row => JSON.parse(String(row.body_json)) as { currency: string; actualAmount: number | null; reservedAmount: number });
    const studio = this.store.db.prepare('SELECT body_json FROM studio_operations WHERE project_id=?').all(projectId).map(row => JSON.parse(String(row.body_json)) as { currency: string; actualAmount: number | null; reservedAmount: number });
    return calls + [...generations, ...studio].filter(g => g.currency === currency).reduce((sum, g) => sum + (g.actualAmount ?? g.reservedAmount), 0);
  }
  createReasoning(projectId: string, value: unknown): StoredCall {
    const b = record(value), providerId = resourceId(b.providerId), operationId = resourceId(b.clientRequestId);
    const expected = integer(b.expectedBoardRevision, '分镜版本', 0, Number.MAX_SAFE_INTEGER), expectedProject = integer(b.expectedProjectRevision, '项目简报版本', 1, Number.MAX_SAFE_INTEGER), reservation = b.reservation === undefined ? null : reservationInput(b.reservation);
    const expectedProviderUpdatedAt = text(b.expectedProviderUpdatedAt, '模型连接版本', 100);
    const hash = requestHash({ providerId, expected, expectedProject, expectedProviderUpdatedAt, reservation });
    return this.store.transaction(() => {
      const existing = this.store.db.prepare('SELECT request_hash,body_json FROM provider_calls WHERE project_id=? AND operation_id=?').get(projectId, operationId);
      if (existing) { invariant(existing.request_hash === hash, 'IDEMPOTENCY_CONFLICT', '同一调用标识不能用于不同输入', 409); return JSON.parse(String(existing.body_json)) as StoredCall; }
      const { profile, credentialRef } = this.getProfile(providerId);
      invariant(profile.kind === 'chat-completions', 'PROVIDER_CAPABILITY', '请选择推理连接');
      invariant(profile.updatedAt === expectedProviderUpdatedAt, 'PROVIDER_CHANGED', '模型连接已改变，请重新审阅发送目标', 409);
      const snapshot = this.board.snapshot(projectId), project = this.store.getProject(projectId);
      invariant(snapshot.revision === expected, 'REVISION_CONFLICT', '分镜已更新，请重新审阅调用内容', 409);
      invariant(project.revision === expectedProject, 'REVISION_CONFLICT', '创作简报已更新，请重新审阅调用内容', 409);
      invariant(project.brief.trim().length > 0, 'BRIEF_REQUIRED', '请先填写创作简报');
      invariant(profile.capabilities.inputModes.includes('text'), 'PROVIDER_CAPABILITY', '推理连接需要文本能力');
      invariant(Buffer.byteLength(JSON.stringify({ brief: project.brief, shots: snapshot.shots.filter(s => !s.archived) }), 'utf8') <= 256 * 1024, 'CONTEXT_TOO_LARGE', '本次分镜上下文超过 256 KiB，请缩短描述后再调用');
      if (reservation) invariant(this.exposure(projectId, reservation.currency) + reservation.amount <= reservation.projectLimit + 0.0000001, 'BUDGET_EXCEEDED', '当前币种的已确认费用与未核对预留已达到项目额度', 409);
      // Credential validation occurs before a reservation is committed or dispatch starts.
      const key = this.vault.get(credentialRef), hostname = new URL(profile.baseUrl).hostname;
      invariant(key.length > 0 || ['localhost', '127.0.0.1', '[::1]'].includes(hostname), 'CREDENTIAL_REQUIRED', '请先为远端模型连接填写 API 密钥');
      const id = randomUUID(), now = new Date().toISOString();
      const job = this.store.createJob({ projectId, type: 'reasoning', payload: { callId: id }, dedupeKey: `reasoning:${projectId}:${operationId}` });
      const call: StoredCall = { id, projectId, providerId, jobId: job.id, operationId, provider: profile, credentialRef, status: 'queued', currency: reservation?.currency ?? 'USD', reservedAmount: reservation?.amount ?? 0, ...(!reservation ? { budgetMode: 'none' as const } : {}), actualAmount: null, draftId: null, error: null, createdAt: now, updatedAt: now, input: { brief: project.brief, shots: snapshot.shots.filter(s => !s.archived), boardRevision: snapshot.revision, projectRevision: project.revision }, reservation };
      this.store.db.prepare('INSERT INTO provider_calls(id,project_id,operation_id,request_hash,status,body_json,credential_ref) VALUES(?,?,?,?,?,?,?)').run(id, projectId, operationId, hash, call.status, JSON.stringify(call), credentialRef);
      this.store.appendEvent(projectId, 'call.created', { callId: id, reservedAmount: call.reservedAmount, currency: call.currency }); return call;
    });
  }
  settle(id: string, value: unknown): CallRecord {
    const b = record(value), actual = finiteNumber(b.actualAmount, '确认费用', 0, 100000000), note = text(b.note, '账单核对说明', 2000);
    return this.store.transaction(() => {
      const call = this.getCall(id);
      invariant(!['queued', 'submitting'].includes(call.status), 'CALL_IN_PROGRESS', '调用仍在执行，请等待或核对远端状态', 409);
      invariant(b.currency === call.currency, 'INVALID_CURRENCY', '核对币种必须与预留一致');
      call.actualAmount = actual; call.settlementNote = note; this.saveCall(call);
      this.store.appendEvent(call.projectId, 'cost.settled', { callId: id, actualAmount: actual, currency: call.currency, note });
      return publicCall(call);
    });
  }
}
export { reservationInput };
