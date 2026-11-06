import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import type { UtilityProcess, utilityProcess } from 'electron';
import { CoreHost } from '../apps/desktop/src/core-host.ts';

interface Request {
  id: string;
  method: string;
  resourceId?: string;
}

// Exercise the actual host with a controlled IPC transport. This is a pure
// Node lifecycle test; it does not assert that Electron itself has launched.
class ChildTransport extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  sent: Request[] = [];
  postAttempts = 0;
  postError: Error | undefined;
  onPost: ((request: Request) => void) | undefined;
  killCalls = 0;
  exited = false;

  postMessage(raw: unknown): void {
    this.postAttempts++;
    if (this.postError) throw this.postError;
    const request = raw as Request;
    this.sent.push(request);
    this.onPost?.(request);
  }

  kill(): boolean {
    this.killCalls++;
    queueMicrotask(() => this.exit(0));
    return true;
  }

  ready(port = 4317): void {
    this.emit('message', { type: 'ready', url: `http://127.0.0.1:${port}`, node: '24.12.0' });
  }

  reply(request: Request, result: unknown): void {
    this.emit('message', { type: 'reply', id: request.id, result });
  }

  exit(code: number): void {
    if (this.exited) return;
    this.exited = true;
    this.emit('exit', code);
  }
}

function fixture() {
  const child = new ChildTransport();
  const launches: Parameters<typeof utilityProcess.fork>[] = [];
  const log: string[] = [];
  let unexpectedExits = 0;
  const fork: typeof utilityProcess.fork = (...args) => {
    launches.push(args);
    return child as unknown as UtilityProcess;
  };
  const host = new CoreHost(event => { log.push(event); }, fork);
  const start = () => host.start('/application/core.mjs', '/application/web', { OWNTAKE_DATA_DIR: '/local/data' }, () => { unexpectedExits++; });
  return { child, launches, log, host, start, unexpectedExits: () => unexpectedExits };
}

test('stop before start permanently prevents a later core spawn', { timeout: 1_000 }, async () => {
  const f = fixture();
  const stopped = f.host.stop();
  assert.strictEqual(f.host.stop(), stopped);
  assert.throws(f.start, /不能重复启动/);
  await stopped;
  assert.throws(f.start, /不能重复启动/);
  await assert.rejects(f.host.request('status'), /本地核心不可用/);
  await setImmediate();
  assert.equal(f.launches.length, 0);
  assert.equal(f.child.postAttempts, 0);
  assert.equal(f.child.killCalls, 0);
});

test('stopping during startup ignores late readiness and terminates only the owned child', { timeout: 1_000 }, async t => {
  const f = fixture();
  t.after(async () => { f.child.exit(0); await f.host.stop(); });
  const startup = f.start();
  const rejected = assert.rejects(startup, /在就绪前退出/);
  const stopped = f.host.stop();
  // Readiness can already be queued when the user requests application exit.
  f.child.ready();
  await Promise.all([stopped, rejected]);
  assert.equal(f.launches.length, 1);
  assert.equal(f.child.killCalls, 1);
  assert.equal(f.child.exited, true);
  assert.equal(f.child.postAttempts, 0);
  assert.equal(f.host.url, '');
  assert.equal(f.unexpectedExits(), 0);
  assert(!f.log.includes('core.ready'));
  assert(f.log.includes('core.stopped'));
  assert.throws(f.start, /不能重复启动/);
});

test('synchronous IPC send failures release pending capacity for subsequent requests', { timeout: 1_000 }, async t => {
  const f = fixture();
  t.after(async () => { f.child.exit(0); await f.host.stop(); });
  const startup = f.start(); f.child.ready(); await startup;
  f.child.postError = new Error('transport closed');
  // More than the 32-request quota: a leaked failed send would poison the host.
  for (let i = 0; i < 40; i++) await assert.rejects(f.host.request('status', undefined, 500), /无法发送本地核心操作/);
  assert.equal(f.child.postAttempts, 40);
  assert.equal(f.child.sent.length, 0);
  f.child.postError = undefined;
  f.child.onPost = request => f.child.reply(request, { activeJobs: 2 });
  assert.deepEqual(await f.host.request('status', undefined, 500), { activeJobs: 2 });
  assert.equal(f.child.postAttempts, 41);
  assert.deepEqual(f.child.sent.map(request => request.method), ['status']);
  assert.equal(f.launches.length, 1);
});

test('unexpected core exit rejects all pending requests without replay or automatic restart', { timeout: 1_000 }, async t => {
  const f = fixture();
  t.after(async () => { f.child.exit(0); await f.host.stop(); });
  const startup = f.start(); f.child.ready(); await startup;
  const rejected = [
    assert.rejects(f.host.request('status', undefined, 500), /本地核心已经停止/),
    assert.rejects(f.host.request('projectPath', 'project-id', 500), /本地核心已经停止/),
    assert.rejects(f.host.request('artifactPath', 'artifact-id', 500), /本地核心已经停止/),
  ];
  f.child.exit(17);
  await Promise.all(rejected);
  for (const request of f.child.sent) f.child.reply(request, { late: true });
  await assert.rejects(f.host.request('status'), /本地核心不可用/);
  assert.throws(f.start, /不能重复启动/);
  await f.host.stop();
  await setImmediate();
  assert.equal(f.unexpectedExits(), 1);
  assert.equal(f.launches.length, 1);
  assert.deepEqual(f.child.sent.map(request => request.method), ['status', 'projectPath', 'artifactPath']);
  assert.equal(f.child.killCalls, 0);
  assert(f.log.includes('core.exited'));
});

test('normal shutdown is idempotent, waits for exit, and leaves an independently owned core running', { timeout: 1_000 }, async t => {
  const own = fixture();
  const other = fixture();
  t.after(async () => {
    own.child.exit(0); other.child.exit(0);
    await Promise.all([own.host.stop(), other.host.stop()]);
  });
  const ownStartup = own.start(); own.child.ready(4317);
  const otherStartup = other.start(); other.child.ready(4318);
  await Promise.all([ownStartup, otherStartup]);
  own.child.onPost = request => own.child.reply(request, { stopped: true });
  other.child.onPost = request => other.child.reply(request, { activeJobs: 1 });
  let completed = false;
  const stopping = own.host.stop();
  assert.strictEqual(own.host.stop(), stopping);
  void stopping.then(() => { completed = true; });
  await setImmediate();
  assert.equal(completed, false, 'a shutdown reply alone is not evidence of child exit');
  assert.deepEqual(own.child.sent.map(request => request.method), ['shutdown']);
  assert.equal(other.child.postAttempts, 0);
  assert.equal(other.child.killCalls, 0);
  assert.equal(other.child.exited, false);
  assert.deepEqual(await other.host.request('status'), { activeJobs: 1 });
  own.child.exit(0);
  await stopping;
  assert.equal(completed, true);
  assert.strictEqual(own.host.stop(), stopping);
  assert.equal(own.unexpectedExits(), 0);
  assert.equal(own.child.killCalls, 0);
  assert.equal(own.launches.length, 1);
  assert.equal(other.launches.length, 1);
  assert.equal(other.child.exited, false);
  assert.deepEqual(other.child.sent.map(request => request.method), ['status']);
  assert(own.log.includes('core.stopped'));
});
