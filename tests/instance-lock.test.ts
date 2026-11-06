import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireLock } from '../apps/server/src/instance-lock.ts';

const lockModule = new URL('../apps/server/src/instance-lock.ts', import.meta.url).href;
const childSource = `
import { acquireLock } from ${JSON.stringify(lockModule)};
let release;
process.on('message', async message => {
  if (message === 'start') {
    try { release = await acquireLock(process.argv[1]); process.send({ type: 'acquired', pid: process.pid }); }
    catch (error) { process.send({ type: 'blocked', code: error.code }); }
  } else if (message === 'release') {
    if (release) await release();
    process.send({ type: 'released' }, () => process.disconnect());
  }
});
process.send({ type: 'ready' });
`;

interface Reply { type: string; pid?: number; code?: string }
interface Fixture {
  child: ChildProcess;
  start(): Promise<Reply>;
  release(): Promise<void>;
  kill(): Promise<void>;
}
function message(child: ChildProcess, types: string[]): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => { clearTimeout(timer); child.off('message', receive); child.off('error', error); child.off('exit', exited); };
    const receive = (value: unknown): void => {
      if (value && typeof value === 'object' && types.includes((value as Reply).type)) { cleanup(); resolve(value as Reply); }
    };
    const error = (cause: Error): void => { cleanup(); reject(cause); };
    const exited = (): void => { cleanup(); reject(new Error('Lock fixture exited before replying')); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Lock fixture reply timed out')); }, 10_000);
    child.on('message', receive); child.once('error', error); child.once('exit', exited);
  });
}
async function contender(root: string): Promise<Fixture> {
  const child = spawn(process.execPath, ['--input-type=module', '--eval', childSource, root], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  child.stderr!.resume();
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  try { await message(child, ['ready']); }
  catch (error) { child.kill('SIGKILL'); await exited; throw error; }
  return {
    child,
    start: async () => { const response = message(child, ['acquired', 'blocked']); child.send('start'); return response; },
    release: async () => { const response = message(child, ['released']); child.send('release'); await response; await exited; },
    kill: async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; },
  };
}
async function directory(run: (root: string, children: Fixture[]) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'owntake 锁 $; [test]-'));
  const children: Fixture[] = [];
  try { await run(root, children); }
  finally { await Promise.all(children.map(child => child.kill())); await rm(root, { recursive: true, force: true }); }
}
async function crashedOwner(root: string, children: Fixture[]): Promise<number> {
  const owner = await contender(root); children.push(owner);
  const started = await owner.start(); assert.equal(started.type, 'acquired');
  const pid = started.pid!; await owner.kill();
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  return pid;
}

test('concurrent starters grant one owner and repeated release cannot remove the next owner', async () => {
  await directory(async root => {
    const attempts = await Promise.allSettled(Array.from({ length: 24 }, () => acquireLock(root)));
    const winners = attempts.filter((entry): entry is PromiseFulfilledResult<() => Promise<void>> => entry.status === 'fulfilled');
    assert.equal(winners.length, 1);
    for (const entry of attempts) if (entry.status === 'rejected') assert.equal(entry.reason.code, 'INSTANCE_LOCKED');
    const lock = JSON.parse(await readFile(join(root, 'instance.lock'), 'utf8'));
    assert.equal(lock.pid, process.pid); assert.equal(typeof lock.nonce, 'string');
    if (process.platform !== 'win32') assert.equal((await stat(join(root, 'instance.lock'))).mode & 0o777, 0o600);
    await assert.rejects(acquireLock(root), { code: 'INSTANCE_LOCKED' });
    const release = winners[0]!.value;
    await Promise.all(Array.from({ length: 12 }, () => release()));
    const next = await acquireLock(root);
    const replacement = await readFile(join(root, 'instance.lock'), 'utf8');
    await release(); assert.equal(await readFile(join(root, 'instance.lock'), 'utf8'), replacement);
    await next(); assert.deepEqual(await readdir(root), []);
  });
});

test('an active core blocks a second host and a genuinely hard-killed owner is recoverable', async () => {
  await directory(async (root, children) => {
    const owner = await contender(root); children.push(owner);
    const started = await owner.start(); assert.equal(started.type, 'acquired');
    const original = await readFile(join(root, 'instance.lock'), 'utf8');
    await assert.rejects(acquireLock(root), { code: 'INSTANCE_LOCKED' });
    assert.equal(await readFile(join(root, 'instance.lock'), 'utf8'), original);
    assert.equal(process.kill(started.pid!, 0), true, 'the conflict check never kills the active owner');
    await owner.kill();
    const release = await acquireLock(root);
    assert.equal(JSON.parse(await readFile(join(root, 'instance.lock'), 'utf8')).pid, process.pid);
    await assert.rejects(stat(join(root, 'instance-recovery.lock')), { code: 'ENOENT' });
    await release(); assert.deepEqual(await readdir(root), []);
  });
});

test('multiple real processes recovering one stale lock retain exactly one fresh owner', async () => {
  await directory(async (root, children) => {
    await crashedOwner(root, children);
    const contenders = await Promise.all(Array.from({ length: 8 }, () => contender(root)));
    children.push(...contenders);
    const replies = await Promise.all(contenders.map(child => child.start()));
    const winners = replies.map((reply, index) => ({ reply, index })).filter(item => item.reply.type === 'acquired');
    assert.equal(winners.length, 1, 'stale recovery may not unlink another starter’s fresh lock');
    for (const reply of replies) if (reply.type !== 'acquired') assert.equal(reply.code, 'INSTANCE_LOCKED');
    const winner = winners[0]!;
    const current = JSON.parse(await readFile(join(root, 'instance.lock'), 'utf8'));
    assert.equal(current.pid, winner.reply.pid);
    await assert.rejects(acquireLock(root), { code: 'INSTANCE_LOCKED' });
    await contenders[winner.index]!.release();
    assert.deepEqual(await readdir(root), []);
  });
});

test('parallel recovery calls in one host cannot duplicate ownership either', async () => {
  await directory(async (root, children) => {
    await crashedOwner(root, children);
    const attempts = await Promise.allSettled(Array.from({ length: 32 }, () => acquireLock(root)));
    const winners = attempts.filter((entry): entry is PromiseFulfilledResult<() => Promise<void>> => entry.status === 'fulfilled');
    assert.equal(winners.length, 1);
    for (const entry of attempts) if (entry.status === 'rejected') assert.equal(entry.reason.code, 'INSTANCE_LOCKED');
    assert.equal(JSON.parse(await readFile(join(root, 'instance.lock'), 'utf8')).pid, process.pid);
    await winners[0]!.value(); assert.deepEqual(await readdir(root), []);
  });
});

test('an existing recovery guard fails closed without deleting a stale or new owner', async () => {
  await directory(async (root, children) => {
    const deadPid = await crashedOwner(root, children);
    const stale = await readFile(join(root, 'instance.lock'), 'utf8');
    for (const guard of ['', 'malformed', JSON.stringify({ pid: deadPid, nonce: randomUUID() }), JSON.stringify({ pid: process.pid, nonce: randomUUID() })]) {
      await writeFile(join(root, 'instance-recovery.lock'), guard);
      await assert.rejects(acquireLock(root), { code: 'INSTANCE_LOCKED' });
      assert.equal(await readFile(join(root, 'instance.lock'), 'utf8'), stale);
      assert.equal(await readFile(join(root, 'instance-recovery.lock'), 'utf8'), guard);
    }
  });
});

test('malformed, oversized, symlink and directory locks are never adopted or removed', async () => {
  await directory(async root => {
    const path = join(root, 'instance.lock');
    for (const value of ['', 'bad JSON', '{}', 'null', JSON.stringify({ pid: 0, nonce: randomUUID() }), JSON.stringify({ pid: 2 ** 32, nonce: randomUUID() }), JSON.stringify({ pid: process.pid, nonce: '../other-file' }), 'x'.repeat(5000)]) {
      await writeFile(path, value);
      await assert.rejects(acquireLock(root), { code: 'INSTANCE_LOCKED' });
      assert.equal(await readFile(path, 'utf8'), value);
      await rm(path);
    }
    const outside = join(root, 'preserved.txt'); await writeFile(outside, 'never follow'); await symlink(outside, path);
    await assert.rejects(acquireLock(root), { code: 'INSTANCE_LOCKED' });
    assert.equal(await readFile(outside, 'utf8'), 'never follow'); await rm(path);
    await mkdir(path); await assert.rejects(acquireLock(root), { code: 'INSTANCE_LOCKED' });
    assert.equal((await stat(path)).isDirectory(), true);
  });
});

test('release refuses a replaced owner record', async () => {
  await directory(async root => {
    const release = await acquireLock(root);
    const path = join(root, 'instance.lock');
    await rename(path, join(root, 'previous.lock'));
    const replacement = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
    await writeFile(path, replacement);
    await release(); assert.equal(await readFile(path, 'utf8'), replacement);
  });
});
