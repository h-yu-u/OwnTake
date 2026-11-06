import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError } from '../../../packages/contracts/src/errors.ts';
export async function acquireLock(dataDir: string): Promise<() => Promise<void>> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const path = join(dataDir, 'instance.lock'), nonce = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const file = await open(path, 'wx', 0o600);
      await file.writeFile(JSON.stringify({ pid: process.pid, nonce })); await file.close();
      return async () => { try { const value = JSON.parse(await readFile(path, 'utf8')); if (value.nonce === nonce) await unlink(path); } catch { /* already released */ } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let pid: number;
      try { const value = JSON.parse(await readFile(path, 'utf8')); pid = value.pid; if (!Number.isInteger(pid) || pid <= 0) throw new Error(); } catch { throw new AppError('INSTANCE_LOCKED', '实例锁无法核实，请确认没有其他 OwnTake 服务后检查 instance.lock', 409); }
      try { process.kill(pid, 0); throw new AppError('INSTANCE_LOCKED', '该数据目录已有 OwnTake 服务运行', 409); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      await unlink(path).catch(() => undefined);
    }
  }
  throw new AppError('INSTANCE_LOCKED', '无法取得数据目录独占锁', 409);
}
