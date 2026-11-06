import { existsSync } from 'node:fs';
import { link, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { JobStatus } from '../../../packages/contracts/src/index.ts';
import { AppError, invariant } from '../../../packages/contracts/src/errors.ts';
import { probe } from '../../../packages/media/src/index.ts';
import { cancelGeneration, compileGenerationRequest, pollGeneration, submitGeneration } from '../../../packages/providers/src/generation.ts';
import { ProviderCallError } from '../../../packages/providers/src/errors.ts';
import type { GenerationRepository, StoredGeneration } from './generation-repository.ts';
import { hashFile, resolveAsset } from './assets.ts';
import { downloadResult } from './download.ts';
import { describeInline, findInlineReceipt, writeInlineReceipt } from './inline-receipt.ts';
const terminal = new Set(['succeeded','failed','cancelled','submission_unknown','download_failed']);
function jobStatus(g: StoredGeneration): JobStatus {
  if (g.status === 'succeeded') return 'succeeded';
  if (g.status === 'failed' || g.status === 'cancelled') return g.status;
  if (g.status === 'submission_unknown' || g.status === 'download_failed') return 'blocked';
  if (g.status === 'waiting_remote') return 'waiting_external';
  return g.status === 'queued' ? 'queued' : 'running';
}
export class GenerationRunner {
  readonly repository: GenerationRepository;
  private timer?: ReturnType<typeof setInterval>;
  private active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private stopping = false;
  constructor(repository: GenerationRepository) { this.repository = repository; }
  private relative(g: StoredGeneration): string { return `assets/${g.outputArtifactId}/received.${g.plan.kind === 'image' ? 'png' : 'mp4'}`; }
  private path(g: StoredGeneration): string { return join(this.repository.store.getProjectDir(g.projectId), this.relative(g)); }
  /** Keep user controls/settlements made while awaiting I/O; a late poll must not overwrite them. */
  private persist(g: StoredGeneration): void {
    const { store } = this.repository;
    store.transaction(() => {
      const current = this.repository.get(g.id);
      if (current.status === 'cancelled' || current.status === 'succeeded') return;
      g.cancelRequested = current.cancelRequested; g.pollingPaused = current.pollingPaused;
      g.actualAmount = current.actualAmount ?? g.actualAmount; g.settlementNote = current.settlementNote ?? g.settlementNote;
      this.repository.save(g);
      store.updateJob(g.jobId, { status: jobStatus(g), error: g.error, ...(g.status === 'succeeded' ? { progress: 1, result: { artifactId: g.artifactId, candidateId: g.candidateId, generationId: g.id } } : {}) });
    });
  }
  start(): void {
    for (const g of this.repository.all()) {
      if (terminal.has(g.status)) continue;
      let staged = false; try { staged = existsSync(this.path(g)); } catch { /* Missing project directory remains an explicit recovery error. */ }
      if (staged) { g.stagedRelativePath = this.relative(g); g.status = 'ingesting'; this.persist(g); }
      else if (g.inlineReceipt) { g.status = 'ingesting'; this.persist(g); }
      else if (g.status === 'submitting') { g.status = 'submission_unknown'; g.error = { code: 'SUBMISSION_UNKNOWN', message: '服务在提交期间中断。远端可能已受理，请核对原任务；不会自动重发。' }; this.persist(g); }
      else if (g.status === 'ingesting') { g.status = g.remoteTaskId ? 'waiting_remote' : 'submission_unknown'; g.nextPollAt = 0; this.persist(g); }
    }
    this.timer = setInterval(() => this.tick(), 300); this.timer.unref(); this.tick();
  }
  tick(): void {
    if (this.stopping || this.active.size) return;
    const g = this.repository.all().find(g => !terminal.has(g.status) && g.status !== 'submitting' && !(g.status === 'waiting_remote' && (g.pollingPaused || g.nextPollAt > Date.now())));
    if (!g) return;
    const controller = new AbortController();
    const promise = this.run(g, controller.signal).catch(() => { console.error('[OwnTake] generation state persistence failed; saved intent requires inspection'); }).finally(() => this.active.delete(g.id));
    this.active.set(g.id, { controller, promise });
  }
  private async references(g: StoredGeneration, signal: AbortSignal): Promise<Record<string,string>> {
    const data: Record<string,string> = {};
    for (const id of g.plan.referenceArtifactIds) {
      const { artifact, path } = await resolveAsset(this.repository.store, id);
      invariant(artifact.projectId === g.projectId && artifact.kind === 'image' && artifact.sizeBytes <= 16 * 1024 * 1024, 'INVALID_REFERENCE', '参考图片已变化或不属于当前项目');
      const bytes = await readFile(path, { signal });
      invariant(createHash('sha256').update(bytes).digest('hex') === artifact.sha256, 'REFERENCE_CHANGED', '参考图片内容与已审阅版本不同，请恢复原文件');
      const mime: Record<string,string> = { '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp' };
      const kind = mime[extname(path).toLowerCase()]; invariant(kind, 'INVALID_REFERENCE', '当前本地参考上传支持 PNG/JPEG/WebP');
      data[id] = `data:${kind};base64,${bytes.toString('base64')}`;
    }
    return data;
  }
  private async stage(g: StoredGeneration, source: string): Promise<void> {
    const target = this.path(g); await mkdir(join(this.repository.store.getProjectDir(g.projectId), 'assets', g.outputArtifactId), { recursive: true, mode: 0o700 });
    if (!existsSync(target)) await link(source, target);
    g.stagedRelativePath = this.relative(g); g.status = 'ingesting'; g.error = null; this.persist(g);
  }
  private async run(g: StoredGeneration, signal: AbortSignal): Promise<void> {
    const { store, providers } = this.repository;
    let temporary: string | undefined;
    try {
      if (g.status === 'queued') {
        const key = providers.vault.get(g.credentialRef), data = await this.references(g, signal);
        const request = compileGenerationRequest(g.provider, g.plan, data);
        invariant(Buffer.byteLength(JSON.stringify(request.body)) <= 32 * 1024 * 1024, 'REQUEST_TOO_LARGE', '图片参考超过本次请求上限');
        if (signal.aborted || this.repository.get(g.id).status === 'cancelled') return;
        g.status = 'submitting'; this.persist(g);
        const submitted = await submitGeneration(g.provider, key, g.plan, data, { signal });
        if (submitted.kind === 'remote') { g.remoteTaskId = submitted.remoteTaskId; g.status = 'waiting_remote'; g.nextPollAt = 0; g.error = null; this.persist(g); }
        else {
          // Persist the received bytes' identity BEFORE writing. A complete .part can
          // then be recovered after a crash without another paid submission.
          const root = store.getProjectDir(g.projectId); g.inlineReceipt = describeInline(submitted.bytes); g.status = 'ingesting'; g.error = null; this.persist(g);
          try { await writeInlineReceipt(root, g.outputArtifactId, g.attemptId, g.inlineReceipt, submitted.bytes); }
          catch (error) { if (!await findInlineReceipt(root, g.outputArtifactId, g.attemptId, g.inlineReceipt)) throw error; }
          const received = await findInlineReceipt(root, g.outputArtifactId, g.attemptId, g.inlineReceipt);
          invariant(received, 'INLINE_RESULT_UNAVAILABLE', '已收到图片回复，但本地没有完整结果。请检查保留文件和供应商记录；不会自动重新生成。', 409);
          await this.stage(g, received);
        }
      } else if (g.status === 'waiting_remote') {
        const key = providers.vault.get(g.credentialRef);
        if (g.cancelRequested && !g.cancelSent) {
          g.cancelSent = true; this.persist(g);
          try { const cancellation = await cancelGeneration(g.provider, key, g.remoteTaskId!, { signal }); if (!cancellation.acknowledged) g.error = { code: 'CANCEL_NOT_ACKNOWLEDGED', message: '此协议没有可安全确认的条件取消。请在供应商端处理；本地继续查询原任务并保存完成结果，费用仍需核对。' }; }
          catch { g.error = { code: 'CANCEL_UNCONFIRMED', message: '取消请求结果不明，继续查询原任务，费用仍需核对。' }; }
        }
        const result = await pollGeneration(g.provider, key, g.remoteTaskId!, { signal });
        g.lastRemoteStatus = result.status; g.pollFailures = 0; g.nextPollAt = Date.now() + 3000;
        if (result.status === 'succeeded') { invariant(result.outputUrl, 'RESULT_UNAVAILABLE', '远端已成功，但结果地址暂不可用', 502); g.outputUrl = result.outputUrl; g.status = 'remote_succeeded'; g.error = null; }
        else if (result.status === 'failed' || result.status === 'expired') { g.status = 'failed'; g.error = { code: 'REMOTE_FAILED', message: `供应商原任务状态为 ${result.status}；实际费用仍需对照账单确认。` }; }
        else if (result.status === 'cancelled') { g.status = 'cancelled'; g.error = null; }
        else if (!g.cancelRequested) g.error = null;
        this.persist(g);
      } else if (g.status === 'remote_succeeded' || g.status === 'ingesting') {
        if (!existsSync(this.path(g))) {
          if (g.inlineReceipt) {
            const received = await findInlineReceipt(store.getProjectDir(g.projectId), g.outputArtifactId, g.attemptId, g.inlineReceipt);
            invariant(received, 'INLINE_RESULT_UNAVAILABLE', '图片回复已收到，但本地结果文件不完整。原文件已保留；此同步协议无法重新下载，不会自动重新生成。', 409);
            await this.stage(g, received);
          } else {
            invariant(g.outputUrl, 'RESULT_UNAVAILABLE', '原结果文件不可用，请核对供应商输出', 409);
            const work = join(store.getProjectDir(g.projectId), '.work', g.id); await mkdir(work, { recursive: true, mode: 0o700 });
            temporary = join(work, `download-${randomUUID()}.mp4`); g.status = 'ingesting'; this.persist(g);
            await downloadResult(g.outputUrl, temporary, { providerBaseUrl: g.provider.baseUrl, signal }); await this.stage(g, temporary);
          }
        }
        await this.ingest(g, signal);
      }
    } catch (error) {
      const current = this.repository.get(g.id); if (current.status === 'cancelled' || current.status === 'succeeded') return;
      if (g.status === 'submitting') {
        const knownRejection = error instanceof ProviderCallError && ['http_rejected','invalid_response'].includes(error.classification);
        g.status = knownRejection ? 'failed' : 'submission_unknown'; g.error = { code: knownRejection ? 'GENERATION_REJECTED' : 'SUBMISSION_UNKNOWN', message: knownRejection ? '供应商拒绝请求或返回结果不符合合同。不会重发；费用仍需核对。' : '提交结果不明，远端可能已受理。保留预留，请关联原任务或核对账单；不会自动重发。' };
      } else if (g.status === 'waiting_remote') {
        g.pollFailures++; g.nextPollAt = Date.now() + Math.min(30000, 3000 * 2 ** Math.min(g.pollFailures, 4)); g.error = { code: 'POLL_UNAVAILABLE', message: '暂时无法确认原远端任务状态，将退避查询；未重新提交生成。' };
      } else if (this.stopping && g.status === 'queued') return;
      else if (g.status === 'queued') { g.status = 'failed'; g.actualAmount = 0; g.error = { code: error instanceof AppError ? error.code : 'INPUT_UNAVAILABLE', message: error instanceof AppError ? error.message : '本地输入不可用，尚未提交生成' }; }
      else { g.status = 'download_failed'; g.error = { code: error instanceof AppError ? error.code : 'INGEST_FAILED', message: error instanceof AppError ? error.message : '原结果未完整入库，请重试原下载；不会重新生成。' }; }
      this.persist(g);
    } finally { if (temporary) await rm(temporary, { force: true }).catch(() => undefined); }
  }
  private async ingest(g: StoredGeneration, signal: AbortSignal): Promise<void> {
    const { store, board } = this.repository, path = this.path(g);
    let media;
    try {
      media = await probe(path, { ffprobePath: store.getSettings().ffprobePath, signal });
      invariant(media.kind === g.plan.kind, 'RESULT_KIND_MISMATCH', '供应商结果媒体类型与冻结计划不一致', 422);
    } catch (error) {
      if (g.remoteTaskId && error instanceof AppError && ['INVALID_MEDIA','UNSUPPORTED_MEDIA','MEDIA_TOOL_FAILED','RESULT_KIND_MISMATCH'].includes(error.code)) {
        // A 200 HTML/error response must not poison every subsequent download retry.
        // Quarantine only an unregistered result, retaining it for diagnosis.
        const quarantine = join(store.getProjectDir(g.projectId), '.work', g.id); await mkdir(quarantine, { recursive: true, mode: 0o700 });
        await rename(path, join(quarantine, `invalid-${randomUUID()}.bin`)); delete g.stagedRelativePath;
        throw new AppError('INVALID_GENERATED_MEDIA', '原下载不是有效的计划媒体，已隔离保留。可重试同一远端任务的下载；不会重新生成。', 422);
      }
      throw error;
    }
    const sha256 = await hashFile(path, signal), sizeBytes = (await stat(path)).size;
    if (g.inlineReceipt) invariant(sha256 === g.inlineReceipt.sha256 && sizeBytes === g.inlineReceipt.sizeBytes, 'INLINE_RECEIPT_MISMATCH', '保存的图片与收到的完整回复不一致，已保留文件供检查', 409);
    const expectedRatio = g.plan.ratio === '16:9' ? 16/9 : g.plan.ratio === '9:16' ? 9/16 : 1;
    const issues: string[] = [];
    if (!media.width || !media.height || Math.abs(media.width / media.height - expectedRatio) > 0.03) issues.push('实际画幅与计划不同，请人工复核并在时间线选择留边或裁切。');
    if (g.plan.kind === 'video' && Math.abs(media.durationMs - (g.plan.durationSec ?? 0) * 1000) > 250) issues.push('实际时长与计划不同，请检查并调整使用区间。');
    store.transaction(() => {
      const current = this.repository.get(g.id);
      if (current.status === 'succeeded') return;
      invariant(current.status !== 'cancelled', 'GENERATION_CANCELLED', '生成已结束，迟到结果不会改写状态', 409);
      store.addArtifact({ id: g.outputArtifactId, projectId: g.projectId, name: `${g.plan.kind === 'image' ? '图片' : '视频'}-${g.id.slice(0,8)}.${g.plan.kind === 'image' ? 'png' : 'mp4'}`, kind: media.kind, relativePath: this.relative(g), sha256, sizeBytes, media, source: 'generated', metadata: { generationId: g.id, planId: g.planId, attemptId: g.attemptId, providerId: g.providerId, model: g.providerModel, shotId: g.shotId, visualRevision: g.visualRevision } });
      const candidate = board.addCandidate({ projectId: g.projectId, shotId: g.shotId, visualRevision: g.visualRevision, artifactId: g.outputArtifactId, planId: g.planId });
      this.repository.addReview({ projectId: g.projectId, shotId: g.shotId, artifactId: g.outputArtifactId, visualRevision: g.visualRevision, planId: g.planId, kind: 'technical', ruleVersion: 'media-v1', verdict: issues.length ? 'needs_review' : 'pass', checked: { technical: true, visual: false, motion: false, audio: false }, notes: '检查文件摘要、容器与媒体信息、尺寸和时长；未检查画面语义、完整动作或声音内容。', issues });
      g.status = 'succeeded'; g.artifactId = g.outputArtifactId; g.candidateId = candidate.id; g.error = null; delete g.stagedRelativePath; delete g.outputUrl; this.persist(g);
    });
  }
  cancel(id: string): StoredGeneration {
    const g = this.repository.get(id); if (terminal.has(g.status)) return g;
    this.repository.store.transaction(() => {
      g.cancelRequested = true; g.pollingPaused = false;
      if (g.status === 'queued') { g.status = 'cancelled'; g.actualAmount = 0; this.repository.store.updateJob(g.jobId, { status: 'cancelled' }); this.active.get(g.id)?.controller.abort(); }
      this.repository.save(g);
    }); this.tick(); return this.repository.get(id);
  }
  async reconcile(id: string, remoteTaskId: string, note: string): Promise<StoredGeneration> {
    const g = this.repository.get(id);
    if (g.remoteTaskId === remoteTaskId && g.status !== 'submission_unknown') return g;
    invariant(g.status === 'submission_unknown' && g.provider.kind === 'ark-video', 'CANNOT_RECONCILE', '只有未知的视频提交可关联原远端任务', 409);
    await pollGeneration(g.provider, this.repository.providers.vault.get(g.credentialRef), remoteTaskId);
    this.repository.store.transaction(() => { const current = this.repository.get(id); invariant(current.status === 'submission_unknown', 'GENERATION_CHANGED', '任务已经被核对，请刷新', 409); current.remoteTaskId = remoteTaskId; current.status = 'waiting_remote'; current.nextPollAt = 0; current.error = null; this.repository.save(current); this.repository.store.updateJob(current.jobId, { status: 'waiting_external', error: null }); this.repository.store.appendEvent(g.projectId, 'generation.reconciled', { generationId: id, remoteTaskId, note }); });
    this.tick(); return this.repository.get(id);
  }
  retryDownload(id: string): StoredGeneration {
    const g = this.repository.get(id); invariant(g.status === 'download_failed', 'CANNOT_RETRY_DOWNLOAD', '任务不处于可恢复下载状态', 409);
    g.status = existsSync(this.path(g)) || g.inlineReceipt ? 'ingesting' : g.remoteTaskId ? 'waiting_remote' : 'submission_unknown'; g.nextPollAt = 0; g.error = null; this.persist(g); this.tick(); return this.repository.get(id);
  }
  pause(id: string, paused: boolean): StoredGeneration {
    const g = this.repository.get(id); invariant(g.status === 'waiting_remote' && g.remoteTaskId, 'CANNOT_PAUSE', '当前没有可暂停查询的远端任务', 409); g.pollingPaused = paused; if (!paused) g.nextPollAt = 0; this.repository.save(g); this.tick(); return this.repository.get(id);
  }
  async stop(): Promise<void> { this.stopping = true; clearInterval(this.timer); for (const task of this.active.values()) task.controller.abort(); await Promise.allSettled([...this.active.values()].map(task => task.promise)); }
}
