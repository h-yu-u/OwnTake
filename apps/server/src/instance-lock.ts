import { constants } from 'node:fs';
import { mkdir, open, link, lstat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError } from '../../../packages/contracts/src/errors.ts';

interface LockRecord { pid: number; nonce: string }
interface ObservedLock extends LockRecord { dev: number; ino: number }
const noncePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function locked(message = '该数据目录已有 OwnTake 服务运行，或实例锁无法安全核实。'): AppError {
  return new AppError('INSTANCE_LOCKED', message, 409);
}

/** Publish a complete record without replacing any existing owner's inode. */
async function publish(path: string, value: LockRecord): Promise<boolean> {
  const pending = `${path}.${randomUUID()}.pending`;
  const file = await open(pending, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
    await file.close();
    try { await link(pending, path); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error; }
  } finally {
    await file.close().catch(() => undefined);
    await unlink(pending).catch(() => undefined);
  }
}

async function observe(path: string): Promise<ObservedLock | null> {
  try {
    if (!(await lstat(path)).isFile()) throw locked('实例锁不是普通文件，已阻止启动。');
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > 4096) throw locked();
      const buffer = Buffer.alloc(4097);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 4096) throw locked();
      const value: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw locked();
      const record = value as Partial<LockRecord>;
      if (!Number.isInteger(record.pid) || record.pid! < 1 || record.pid! > 2_147_483_647 || typeof record.nonce !== 'string' || !noncePattern.test(record.nonce)) throw locked();
      return { pid: record.pid!, nonce: record.nonce, dev: stat.dev, ino: stat.ino };
    } finally { await file.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (error instanceof AppError) throw error;
    throw locked('实例锁无法核实，请确认没有其他 OwnTake 服务后检查 instance.lock。');
  }
}

function requireDead(pid: number): void {
  // Signal zero is only a liveness query. Never terminate another process.
  try { process.kill(pid, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return; }
  // EPERM, PID reuse and all unverifiable states fail closed.
  throw locked();
}

function sameOwner(a: ObservedLock, b: ObservedLock): boolean {
  return a.pid === b.pid && a.nonce === b.nonce && a.dev === b.dev && a.ino === b.ino;
}

function releaseOnce(path: string, value: LockRecord): () => Promise<void> {
  let released: Promise<void> | undefined;
  return () => released ??= (async () => {
    try {
      const current = await observe(path);
      if (current?.pid === value.pid && current.nonce === value.nonce) await unlink(path);
    } catch { /* Never remove an unreadable or replaced lock. */ }
  })();
}

export async function acquireLock(dataDir: string): Promise<() => Promise<void>> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const path = join(dataDir, 'instance.lock');
  const guardPath = join(dataDir, 'instance-recovery.lock');
  const owner: LockRecord = { pid: process.pid, nonce: randomUUID() };

  for (let attempt = 0; attempt < 3; attempt++) {
    if (await publish(path, owner)) return releaseOnce(path, owner);
    const stale = await observe(path);
    if (!stale) continue; // Another owner finished releasing before observation.
    requireDead(stale.pid);

    // Only one stale-lock remover may run. Never reclaim this guard based on an
    // old PID observation: that would reproduce the same unlink/new-owner race.
    // A crash during this very short section leaves a fail-closed recovery guard.
    const guard: LockRecord = { pid: process.pid, nonce: randomUUID() };
    if (!await publish(guardPath, guard)) throw locked('实例恢复正在进行或恢复锁需要检查；确认所有 OwnTake 服务已停止后检查 instance-recovery.lock。');
    const releaseGuard = releaseOnce(guardPath, guard);
    try {
      const current = await observe(path);
      if (!current || !sameOwner(stale, current)) throw locked('实例锁已变化，请重试启动；未删除新实例的锁。');
      requireDead(current.pid);
      await unlink(path);
      // A regular starter can win immediately after the unlink. Exclusive
      // publication then loses safely; never delete that newly published lock.
      if (!await publish(path, owner)) throw locked();
      return releaseOnce(path, owner);
    } finally { await releaseGuard(); }
  }
  throw locked('无法取得数据目录独占锁，请稍后重试。');
}
