import { invariant } from '../../contracts/src/errors.ts';
import type { ProviderProfile, ReasoningInput, ReasoningResult } from '../../contracts/src/providers.ts';
import { callReasoning } from '../../providers/src/reasoning.ts';

/** A one-call drafting runtime. It has no filesystem, terminal or tool executor. */
export class NativeRuntime {
  private active = new Map<string, AbortController>();
  capabilities() { return { id: 'native', maxSteps: 1, tools: [] as never[], permissions: [] as never[] }; }
  async run(taskId: string, profile: ProviderProfile, key: string, input: ReasoningInput): Promise<ReasoningResult> {
    invariant(typeof taskId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(taskId), 'INVALID_TASK', '运行任务标识无效。');
    invariant(!this.active.has(taskId), 'TASK_ALREADY_RUNNING', '同一任务正在运行，不能重复调用模型。', 409);
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    this.active.set(taskId, controller);
    input.signal?.addEventListener('abort', abort, { once: true });
    if (input.signal?.aborted) controller.abort();
    try { return await callReasoning(profile, key, { ...input, signal: controller.signal }); }
    finally { input.signal?.removeEventListener('abort', abort); this.active.delete(taskId); }
  }
  cancel(taskId: string): boolean {
    const task = this.active.get(taskId);
    if (!task) return false;
    task.abort(); return true;
  }
}
