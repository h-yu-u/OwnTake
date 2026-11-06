import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { renderTimeline } from '../../../packages/media/src/index.ts';
import type { Store } from '../../../packages/storage/src/index.ts';
import type { Job } from '../../../packages/contracts/src/index.ts';
import { AppError } from '../../../packages/contracts/src/errors.ts';
import { hashFile, resolveAsset } from './assets.ts';
export class Scheduler {
  readonly store: Store;
  private timer?: ReturnType<typeof setInterval>;
  private active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private stopping = false;
  constructor(store: Store) { this.store = store; }
  start(): void {
    for (const job of this.store.listRecoverableJobs()) {
      if (job.type !== 'export') continue;
      if (job.status === 'running') this.store.updateJob(job.id, { status: 'queued', progress: 0 });
      if (job.status === 'cancel_requested') this.store.updateJob(job.id, { status: 'cancelled' });
    }
    this.timer = setInterval(() => this.tick(), 250); this.timer.unref(); this.tick();
  }
  tick(): void {
    if (this.stopping || this.active.size) return;
    const job = this.store.listRecoverableJobs().find(job => job.type === 'export' && job.status === 'queued');
    if (!job) return;
    const controller = new AbortController();
    this.store.updateJob(job.id, { status: 'running', progress: 0 });
    const promise = this.runExport(job, controller.signal).finally(() => { this.active.delete(job.id); });
    this.active.set(job.id, { controller, promise });
  }
  cancel(id: string): Job {
    const job = this.store.getJob(id);
    if (['succeeded', 'cancelled', 'failed'].includes(job.status)) return job;
    if (job.status === 'queued') return this.store.updateJob(id, { status: 'cancelled' });
    const updated = this.store.updateJob(id, { status: 'cancel_requested' });
    this.active.get(id)?.controller.abort(); return updated;
  }
  private async runExport(job: Job, signal: AbortSignal): Promise<void> {
    let workDir: string | undefined;
    let unpublishedPath: string | undefined;
    try {
      const runId = randomUUID(), root = this.store.getProjectDir(job.projectId);
      workDir = join(root, '.work', job.id, runId);
      const outputPath = join(workDir, 'result.mp4');
      await mkdir(workDir, { recursive: true, mode: 0o700 });
      const timeline = this.store.getTimeline(String(job.payload.timelineId));
      const settings = this.store.getSettings(); let lastUpdate = 0;
      const media = await renderTimeline({ timeline, outputPath, workDir, ...settings, signal, resolveArtifact: async id => {
        const result = await resolveAsset(this.store, id);
        if (result.artifact.projectId !== job.projectId) throw new AppError('FORBIDDEN_ASSET', '时间线引用了其他项目的素材', 403);
        return result;
      }, onProgress: progress => { if (Date.now() - lastUpdate > 500) { lastUpdate = Date.now(); this.store.updateJob(job.id, { progress: Math.min(0.99, Math.max(0, progress)) }); } } });
      if (signal.aborted) throw new AppError('CANCELLED', '已停止本地渲染');
      const id = randomUUID(), relativePath = `exports/${id}/output.mp4`, sha256 = await hashFile(outputPath), sizeBytes = (await stat(outputPath)).size;
      await mkdir(join(root, 'exports', id), { recursive: true }); unpublishedPath = join(root, relativePath); await rename(outputPath, unpublishedPath);
      this.store.transaction(() => {
        if (signal.aborted || this.store.getJob(job.id).status === 'cancel_requested') throw new AppError('CANCELLED', '已停止本地渲染');
        this.store.addArtifact({ id, projectId: job.projectId, name: `OwnTake-v${timeline.version}.mp4`, kind: 'video', relativePath, sha256, sizeBytes, media, source: 'render', metadata: { timelineId: timeline.id, jobId: job.id } });
        this.store.updateJob(job.id, { status: 'succeeded', progress: 1, result: { artifactId: id, timelineId: timeline.id }, error: null });
      });
      unpublishedPath = undefined;
    } catch (error) {
      const current = this.store.getJob(job.id);
      if (this.stopping && current.status !== 'cancel_requested') this.store.updateJob(job.id, { status: 'queued', progress: 0 });
      else if (signal.aborted || current.status === 'cancel_requested') this.store.updateJob(job.id, { status: 'cancelled' });
      else this.store.updateJob(job.id, { status: 'failed', error: { code: error instanceof AppError ? error.code : 'RENDER_FAILED', message: error instanceof Error ? error.message.slice(0, 1200) : '本地渲染未完成' } });
    } finally {
      if (unpublishedPath) await rm(unpublishedPath, { force: true }).catch(() => undefined);
      if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  async stop(): Promise<void> {
    this.stopping = true; clearInterval(this.timer);
    for (const task of this.active.values()) task.controller.abort();
    await Promise.allSettled([...this.active.values()].map(task => task.promise));
  }
}
