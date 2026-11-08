import { randomUUID } from 'node:crypto';
import type { Store } from '../../../packages/storage/src/index.ts';
import type { StoryboardStore } from '../../../packages/storage/src/storyboard.ts';
import type { GenerationRecord, ReviewRecord } from '../../../packages/contracts/src/generations.ts';
import type { ProviderProfile, GenerationPlan, PlanValidationResult } from '../../../packages/contracts/src/providers.ts';
import type { Artifact } from '../../../packages/contracts/src/index.ts';
import type { CastReferenceSnapshot } from '../../../packages/contracts/src/shot-cast.ts';
import type { Reservation } from '../../../packages/contracts/src/calls.ts';
import { AppError, invariant } from '../../../packages/contracts/src/errors.ts';
import { record, resourceId, integer, finiteNumber, text } from '../../../packages/domain/src/validation.ts';
import { requestHash } from '../../../packages/storage/src/validation.ts';
import { parseGenerationPlan } from '../../../packages/providers/src/plans.ts';
import { validateGeneration } from '../../../packages/providers/src/generation.ts';
import { ProviderRepository, reservationInput } from './provider-repository.ts';
import { resolveAsset } from './assets.ts';
import type { InlineReceipt } from './inline-receipt.ts';
export interface StoredGeneration extends GenerationRecord {
  operationId: string; provider: ProviderProfile; credentialRef: string | null; reservation: Reservation;
  outputArtifactId: string; outputUrl?: string; stagedRelativePath?: string; inlineReceipt?: InlineReceipt;
  nextPollAt: number; pollFailures: number; cancelSent: boolean; settlementNote?: string;
}
export function publicGeneration(value: StoredGeneration): GenerationRecord {
  const { id, projectId, shotId, shotRevision, visualRevision, providerId, providerModel, planId, attemptId, jobId, plan, castReferences, status, remoteTaskId, lastRemoteStatus, cancelRequested, pollingPaused, currency, reservedAmount, actualAmount, artifactId, candidateId, error, createdAt, updatedAt } = value;
  return { id, projectId, shotId, shotRevision, visualRevision, providerId, providerModel, planId, attemptId, jobId, plan, ...(castReferences?.length ? { castReferences } : {}), status, remoteTaskId, lastRemoteStatus, cancelRequested, pollingPaused, currency, reservedAmount, actualAmount, artifactId, candidateId, error, createdAt, updatedAt };
}
export class GenerationRepository {
  readonly store: Store; readonly board: StoryboardStore; readonly providers: ProviderRepository;
  constructor(store: Store, board: StoryboardStore, providers: ProviderRepository) { this.store = store; this.board = board; this.providers = providers; }
  get(id: string): StoredGeneration {
    const row = this.store.db.prepare('SELECT body_json FROM generations WHERE id=?').get(resourceId(id));
    if (!row) throw new AppError('GENERATION_NOT_FOUND', '生成意图不存在', 404);
    return JSON.parse(String(row.body_json)) as StoredGeneration;
  }
  all(): StoredGeneration[] { return this.store.db.prepare('SELECT body_json FROM generations ORDER BY rowid').all().map(row => JSON.parse(String(row.body_json)) as StoredGeneration); }
  list(projectId: string): GenerationRecord[] { this.store.getProject(projectId); return this.all().filter(g => g.projectId === projectId).map(publicGeneration).reverse(); }
  save(value: StoredGeneration): void {
    value.updatedAt = new Date().toISOString();
    this.store.db.prepare('UPDATE generations SET status=?,body_json=? WHERE id=?').run(value.status, JSON.stringify(value), value.id);
    this.store.appendEvent(value.projectId, 'generation.updated', { generationId: value.id, status: value.status });
  }
  /** Immutable project artifacts + locked visual versions; never infer cast from a mutable profile. */
  private castSnapshot(shotId:string):CastReferenceSnapshot[] {
    return this.store.db.prepare('SELECT role_id,character_id,visual_version,look_id,reference_artifact_id FROM library_shot_cast WHERE shot_id=? ORDER BY rowid')
      .all(shotId).map(row=>({
        roleId:String(row.role_id),characterId:String(row.character_id),visualVersion:Number(row.visual_version),
        lookId:row.look_id==null?null:String(row.look_id),referenceArtifactId:String(row.reference_artifact_id),
      }));
  }
  async validation(shotId: string, providerId: string, rawPlan: unknown): Promise<{ result: PlanValidationResult; plan: GenerationPlan; references: Artifact[]; profile: ProviderProfile; credentialRef: string | null }> {
    const shot = this.board.getShot(shotId), { profile, credentialRef } = this.providers.getProfile(providerId), plan = parseGenerationPlan(rawPlan);
    invariant(!shot.archived, 'SHOT_ARCHIVED', '归档镜头不能提交新生成', 409);
    const cast = this.castSnapshot(shotId);
    invariant(cast.every(binding=>plan.referenceArtifactIds.includes(binding.referenceArtifactId)),
      'CAST_REFERENCE_REQUIRED', '生成计划不能忽略当前镜头绑定的人物参考图，请改用支持参考图的模型',409);
    const references: Artifact[] = [];
    for (const id of plan.referenceArtifactIds) { const { artifact } = await resolveAsset(this.store, id); invariant(artifact.projectId === shot.projectId, 'INVALID_REFERENCE', '参考素材必须属于当前项目'); references.push(artifact); }
    return { result: validateGeneration(profile, plan, references), plan, references, profile, credentialRef };
  }
  async create(shotId: string, value: unknown): Promise<StoredGeneration> {
    const b = record(value), providerId = resourceId(b.providerId), operationId = resourceId(b.clientRequestId), plan = parseGenerationPlan(b.plan);
    const expected = integer(b.expectedShotRevision, '镜头版本', 1, Number.MAX_SAFE_INTEGER), expectedProviderUpdatedAt = text(b.expectedProviderUpdatedAt, '模型连接版本', 100), reservation = reservationInput(b.reservation);
    const shot = this.board.getShot(shotId), hash = requestHash({ shotId, expected, providerId, expectedProviderUpdatedAt, plan, reservation });
    const existing = this.store.db.prepare('SELECT request_hash,body_json FROM generations WHERE project_id=? AND operation_id=?').get(shot.projectId, operationId);
    if (existing) { invariant(existing.request_hash === hash, 'IDEMPOTENCY_CONFLICT', '同一生成操作标识不能用于不同输入', 409); return JSON.parse(String(existing.body_json)); }
    const validation = await this.validation(shotId, providerId, plan);
    if (validation.result.status !== 'valid') throw new AppError('NEEDS_REPLAN', '生成计划与连接能力不匹配，请先调整计划', 409, { issues: validation.result.issues });
    const { profile, credentialRef } = validation, key = this.providers.vault.get(credentialRef);
    invariant(key.length > 0 || ['localhost','127.0.0.1'].includes(new URL(profile.baseUrl).hostname), 'CREDENTIAL_REQUIRED', '请先填写该远端连接的 API 密钥');
    return this.store.transaction(() => {
      // Validation includes asynchronous file checks; repeat the operation and version checks inside the reservation transaction.
      const duplicate = this.store.db.prepare('SELECT request_hash,body_json FROM generations WHERE project_id=? AND operation_id=?').get(shot.projectId, operationId);
      if (duplicate) { invariant(duplicate.request_hash === hash, 'IDEMPOTENCY_CONFLICT', '同一生成操作标识不能用于不同输入', 409); return JSON.parse(String(duplicate.body_json)) as StoredGeneration; }
      const current = this.board.getShot(shotId);
      const castReferences = this.castSnapshot(shotId);
      invariant(castReferences.every(binding=>plan.referenceArtifactIds.includes(binding.referenceArtifactId)),
        'CAST_REFERENCE_REQUIRED', '生成计划缺失人物参考图，请重新审阅',409);
      invariant(!current.archived && current.revision === expected, 'REVISION_CONFLICT', '镜头已改变，请重新审阅生成计划', 409);
      invariant(profile.updatedAt === expectedProviderUpdatedAt && this.providers.getProfile(providerId).profile.updatedAt === expectedProviderUpdatedAt, 'PROVIDER_CHANGED', '模型连接已改变，请重新审阅发送目标', 409);
      invariant(this.providers.exposure(shot.projectId, reservation.currency) + reservation.amount <= reservation.projectLimit + 0.0000001, 'BUDGET_EXCEEDED', '已确认费用与未核对预留超过该币种的项目额度', 409);
      const id = randomUUID(), now = new Date().toISOString(), job = this.store.createJob({ projectId: shot.projectId, type: 'generation', payload: { generationId: id }, dedupeKey: `generation:${shot.projectId}:${operationId}` });
      const generation: StoredGeneration = { id, projectId: shot.projectId, shotId, shotRevision: current.revision, visualRevision: current.visualRevision, providerId, providerModel: profile.model, planId: randomUUID(), attemptId: randomUUID(), jobId: job.id, plan, ...(castReferences.length ? { castReferences } : {}), status: 'queued', remoteTaskId: null, lastRemoteStatus: null, cancelRequested: false, pollingPaused: false, currency: reservation.currency, reservedAmount: reservation.amount, actualAmount: null, artifactId: null, candidateId: null, error: null, createdAt: now, updatedAt: now, operationId, provider: profile, credentialRef, reservation, outputArtifactId: randomUUID(), nextPollAt: 0, pollFailures: 0, cancelSent: false };
      this.store.db.prepare('INSERT INTO generations(id,project_id,shot_id,operation_id,request_hash,status,body_json) VALUES(?,?,?,?,?,?,?)').run(id, current.projectId, shotId, operationId, hash, generation.status, JSON.stringify(generation));
      this.store.appendEvent(current.projectId, 'generation.created', { generationId: id, shotId, visualRevision: current.visualRevision, reservedAmount: reservation.amount, currency: reservation.currency }); return generation;
    });
  }
  settle(id: string, input: unknown): GenerationRecord {
    const b = record(input), actualAmount = finiteNumber(b.actualAmount, '实付金额', 0, 100000000), note = text(b.note, '账单核对说明', 2000);
    return this.store.transaction(() => { const g = this.get(id); invariant(!['queued','submitting','waiting_remote'].includes(g.status), 'GENERATION_ACTIVE', '任务仍在进行，请先核对远端最终状态', 409); invariant(g.currency === b.currency, 'INVALID_CURRENCY', '币种与本次预留不一致'); g.actualAmount = actualAmount; g.settlementNote = note; this.save(g); this.store.appendEvent(g.projectId, 'cost.settled', { generationId: id, actualAmount, currency: g.currency, note }); return publicGeneration(g); });
  }
  listReviews(projectId: string): ReviewRecord[] { this.store.getProject(projectId); return this.store.db.prepare('SELECT body_json FROM reviews WHERE project_id=? ORDER BY rowid').all(projectId).map(row => JSON.parse(String(row.body_json))); }
  addReview(value: Omit<ReviewRecord, 'id' | 'createdAt'>): ReviewRecord {
    const review = { ...value, id: randomUUID(), createdAt: new Date().toISOString() };
    this.store.db.prepare('INSERT INTO reviews(id,project_id,artifact_id,body_json) VALUES(?,?,?,?)').run(review.id, review.projectId, review.artifactId, JSON.stringify(review));
    this.store.appendEvent(review.projectId, 'review.created', { reviewId: review.id, artifactId: review.artifactId }); return review;
  }
  review(shotId: string, input: unknown): ReviewRecord {
    const b = record(input), candidate = this.board.getCandidate(resourceId(b.candidateId)), shot = this.board.getShot(shotId), artifact = this.store.getArtifact(candidate.artifactId), checked = record(b.checked);
    invariant(candidate.shotId === shotId, 'INVALID_REFERENCE', '候选不属于该镜头');
    invariant(['pass','needs_review','reject'].includes(String(b.verdict)), 'INVALID_REVIEW', '复核结论无效');
    for (const name of ['visual','motion','audio']) invariant(typeof checked[name] === 'boolean', 'INVALID_REVIEW', '请明确复核覆盖范围');
    invariant(artifact.kind !== 'image' || !checked.motion && !checked.audio, 'INVALID_REVIEW', '静态图片不能证明完整动作或音频');
    if (b.verdict === 'pass') invariant(checked.visual && (artifact.kind === 'image' || checked.motion && (!artifact.media.hasAudio || checked.audio)), 'REVIEW_INCOMPLETE', '通过需要确认画面、完整动作及实际存在的声音；未检查内容请保留待复核');
    return this.store.transaction(() => this.addReview({ projectId: shot.projectId, shotId, artifactId: artifact.id, visualRevision: candidate.visualRevision, planId: candidate.planId, kind: 'human', ruleVersion: 'human-v1', verdict: b.verdict as ReviewRecord['verdict'], checked: { technical: false, visual: Boolean(checked.visual), motion: Boolean(checked.motion), audio: Boolean(checked.audio) }, notes: text(b.notes ?? '', '复核备注', 4000, true), issues: [] }));
  }
}
