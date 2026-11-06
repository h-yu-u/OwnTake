import { startServer } from '../../server/src/app.ts';
import { AppError } from '../../../packages/contracts/src/errors.ts';
import { validateId } from '../../../packages/storage/src/validation.ts';

// Only the owning Electron main process has this port. The renderer uses the
// same authenticated HTTP API as a browser, never this privileged channel.
interface ParentPort {
  on(name: 'message', listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}
const port = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort;
if (!port) throw new Error('Desktop core requires an owning parent process');
const send = (message: unknown) => port.postMessage(message);
let core: Awaited<ReturnType<typeof startServer>> | undefined;
let closing = false;

function safeError(error: unknown) {
  if (error instanceof AppError) return { code: error.code, message: error.message };
  return { code: 'CORE_ERROR', message: '本地核心操作失败，请检查工具、数据目录及升级快照。' };
}

port.on('message', ({ data }) => {
  void (async () => {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return;
    const request = data as Record<string, unknown>;
    if (typeof request.id !== 'string' || !/^[a-f0-9-]{36}$/.test(request.id)) return;
    const reply = (result: unknown) => send({ type: 'reply', id: request.id, result });
    try {
      if (!core || closing) throw new AppError('CORE_UNAVAILABLE', '本地核心尚未就绪或正在退出。');
      if (request.method === 'status') {
        const row = core.store.db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE status IN ('queued','running','waiting_external','cancel_requested')").get();
        reply({ activeJobs: Number(row?.count ?? 0) });
      } else if (request.method === 'projectPath') {
        validateId(request.resourceId);
        reply(core.store.getProjectDir(request.resourceId));
      } else if (request.method === 'artifactPath') {
        validateId(request.resourceId);
        reply(core.store.resolveArtifactPath(request.resourceId));
      } else if (request.method === 'shutdown') {
        closing = true;
        await core.close();
        reply({ stopped: true });
        setImmediate(() => process.exit(0));
      } else throw new AppError('INVALID_REQUEST', '桌面核心不支持此操作。');
    } catch (error) { send({ type: 'reply', id: request.id, error: safeError(error) }); }
  })();
});

async function stop() {
  if (closing) return;
  closing = true;
  await core?.close();
  process.exit(0);
}
process.once('SIGTERM', () => void stop());
process.once('SIGINT', () => void stop());

try {
  if (!process.argv[2]) throw new Error('Missing web bundle');
  core = await startServer({ port: 0, webDir: process.argv[2], devOrigin: undefined });
  if (closing) { await core.close(); process.exit(0); }
  send({ type: 'ready', url: core.url, node: process.versions.node });
} catch (error) {
  send({ type: 'startup-error', error: safeError(error) });
  setImmediate(() => process.exit(1));
}
