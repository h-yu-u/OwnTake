import type { UtilityProcess, utilityProcess } from 'electron';
import { randomUUID } from 'node:crypto';
import { validateOwnedCoreUrl } from './policy.ts';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
export class CoreHost {
  private child: UtilityProcess | undefined;
  private pending = new Map<string, Pending>();
  private stopping: Promise<void> | undefined;
  private stopped = false;
  private log: (event: string) => void;
  private fork: typeof utilityProcess.fork;
  url = '';
  node = '';

  constructor(log: (event: string) => void, fork: typeof utilityProcess.fork) { this.log = log; this.fork = fork; }

  start(modulePath: string, webDir: string, env: Record<string, string>, onExit: () => void): Promise<void> {
    if (this.child || this.stopping || this.stopped) throw new Error('本地核心已经启动或停止，不能重复启动。');
    return new Promise((resolve, reject) => {
      let ready = false;
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true; clearTimeout(deadline); reject(error);
      };
      const deadline = setTimeout(() => {
        this.log('core.start.timeout');
        this.child?.kill();
        fail(new Error('本地核心启动超时；保留原数据。请关闭其他实例并重新启动。'));
      }, 30_000);
      let child: UtilityProcess;
      try {
        child = this.child = this.fork(modulePath, [webDir], {
          serviceName: 'OwnTake Local Core', env, stdio: 'pipe',
        });
      } catch { fail(new Error('无法创建本地核心进程，请检查应用安装。')); return; }
      // Drain without storing raw output, which could include third-party text.
      child.stdout?.on('data', () => undefined);
      child.stderr?.on('data', () => undefined);
      child.on('message', (raw: unknown) => {
        if (!raw || typeof raw !== 'object') return;
        const message = raw as Record<string, unknown>;
        if (message.type === 'ready' && !settled && !this.stopping && !this.stopped) {
          try {
            this.url = validateOwnedCoreUrl(message.url);
            this.node = typeof message.node === 'string' ? message.node : '';
            ready = settled = true; clearTimeout(deadline);
            this.log('core.ready'); resolve();
          } catch { child.kill(); fail(new Error('核心返回了无效的本机地址。')); }
        } else if (message.type === 'startup-error') {
          const error = message.error as { code?: string; message?: string } | undefined;
          this.log('core.start.failed');
          fail(new Error(error?.code === 'INSTANCE_LOCKED'
            ? '此数据目录已有 OwnTake 服务运行。请先退出终端中的 Web 服务或其他桌面实例，再重新启动；不会启动第二个调度器。'
            : error?.message || '本地核心启动失败；原数据没有被重置。'));
        } else if (message.type === 'reply' && typeof message.id === 'string') {
          const pending = this.pending.get(message.id);
          if (!pending) return;
          this.pending.delete(message.id); clearTimeout(pending.timer);
          if (message.error) {
            const error = message.error as { message?: string };
            pending.reject(new Error(error.message || '本地核心操作失败。'));
          } else pending.resolve(message.result);
        }
      });
      child.once('exit', () => {
        this.stopped = true;
        this.log(this.stopping ? 'core.stopped' : 'core.exited');
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer); pending.reject(new Error('本地核心已经停止。'));
        }
        this.pending.clear();
        fail(new Error('本地核心在就绪前退出；请查看数据目录权限与升级快照。'));
        if (ready && !this.stopping) onExit();
      });
    });
  }

  request(method: 'status' | 'projectPath' | 'artifactPath' | 'shutdown', resourceId?: string, timeoutMs = 10_000): Promise<unknown> {
    if (!this.child || this.stopped || !this.url) return Promise.reject(new Error('本地核心不可用。'));
    if (this.pending.size >= 32) return Promise.reject(new Error('桌面操作过于频繁，请稍后再试。'));
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('本地核心操作超时。')); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.child!.postMessage({ id, method, resourceId }); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(new Error('无法发送本地核心操作。')); }
    });
  }

  stop(): Promise<void> {
    return this.stopping ||= (async () => {
      if (!this.child || this.stopped) return;
      this.log('core.stopping');
      try { await this.request('shutdown', undefined, 20_000); }
      catch { this.log('core.stop.forced'); this.child.kill(); }
      if (!this.stopped) await new Promise<void>(resolve => {
        const deadline = setTimeout(() => { if (!this.stopped) this.child?.kill(); resolve(); }, 3_000);
        this.child!.once('exit', () => { clearTimeout(deadline); resolve(); });
      });
    })();
  }
}
