import type { Job } from '../../../packages/contracts/src/index.ts';
import { ProviderCallError } from '../../../packages/providers/src/index.ts';
import { NativeRuntime } from '../../../packages/runtimes/src/native.ts';
import type { ProviderRepository, StoredCall } from './provider-repository.ts';
export class ModelRunner {
  readonly repository: ProviderRepository;
  private timer?: ReturnType<typeof setInterval>;
  private active?: { id: string; controller: AbortController; promise: Promise<void> };
  private stopping = false;
  private runtime = new NativeRuntime();
  constructor(repository: ProviderRepository) { this.repository = repository; }
  start(): void {
    const { store } = this.repository;
    for (const call of this.repository.allCalls()) {
      if (call.status !== 'submitting') continue;
      store.transaction(() => {
        call.status = 'submission_unknown'; call.error = { code: 'SUBMISSION_UNKNOWN', message: '服务在请求期间中断，远端可能已处理；请核对，不会自动重发。' }; this.repository.saveCall(call);
        store.updateJob(call.jobId, { status: 'blocked', error: call.error });
      });
    }
    this.timer = setInterval(() => this.tick(), 500); this.timer.unref(); this.tick();
  }
  tick(): void {
    if (this.stopping || this.active) return;
    const call = this.repository.allCalls().find(c => c.status === 'queued'); if (!call) return;
    const controller = new AbortController();
    const promise = this.execute(call, controller.signal).catch(() => { console.error('[OwnTake] model state persistence failed; inspect the saved call before continuing'); }).finally(() => { this.active = undefined; });
    this.active = { id: call.id, controller, promise };
  }
  cancel(jobId: string): Job {
    const { store } = this.repository, job = store.getJob(jobId), call = this.repository.getCall(String(job.payload.callId));
    if (call.status === 'queued') store.transaction(() => {
      call.status = 'failed'; call.actualAmount = 0; call.error = { code: 'CALL_CANCELLED', message: '已在发送前停止，没有发起远端请求' }; this.repository.saveCall(call); store.updateJob(jobId, { status: 'cancelled' });
    });
    else if (call.status === 'submitting' && this.active?.id === call.id) this.active.controller.abort();
    return store.getJob(jobId);
  }
  private async execute(call: StoredCall, signal: AbortSignal): Promise<void> {
    const { store, board } = this.repository;
    try {
      const key = this.repository.vault.get(call.credentialRef);
      store.transaction(() => { call.status = 'submitting'; this.repository.saveCall(call); store.updateJob(call.jobId, { status: 'running' }); });
      const result = await this.runtime.run(call.id, call.provider, key, { brief: call.input.brief, shots: call.input.shots, signal });
      store.transaction(() => {
        const draft = board.createDraft(call.projectId, { operations: result.operations, baseRevision: call.input.boardRevision, source: 'model' });
        call.status = 'succeeded'; call.draftId = draft.id; call.error = null; this.repository.saveCall(call);
        store.updateJob(call.jobId, { status: 'succeeded', result: { draftId: draft.id, callId: call.id }, progress: 1, error: null });
      });
    } catch (error) {
      const classification = error instanceof ProviderCallError ? error.classification : call.status === 'queued' ? 'invalid_response' : 'submission_unknown';
      const unknown = classification === 'submission_unknown' || classification === 'cancelled';
      store.transaction(() => {
        call.status = unknown ? 'submission_unknown' : 'failed';
        call.error = { code: unknown ? 'SUBMISSION_UNKNOWN' : classification === 'http_rejected' ? 'PROVIDER_REJECTED' : 'INVALID_MODEL_RESPONSE', message: unknown ? '远端处理结果不明，预留额度保留。请核对账号记录；不会自动重发。' : classification === 'http_rejected' ? '模型接口返回拒绝响应，请检查连接、模型权限与参数；费用仍需核对。' : '模型结果或调用配置未通过校验，既有分镜没有变化；费用仍需核对。' };
        this.repository.saveCall(call); store.updateJob(call.jobId, { status: unknown ? 'blocked' : 'failed', error: call.error });
      });
    }
  }
  async stop(): Promise<void> { this.stopping = true; clearInterval(this.timer); this.active?.controller.abort(); await this.active?.promise; }
}
