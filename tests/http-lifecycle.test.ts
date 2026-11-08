import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { buildApp, startServer } from '../apps/server/src/app.ts';
import { acquireLock } from '../apps/server/src/instance-lock.ts';
import { Store } from '../packages/storage/src/index.ts';
import type { Job, Project } from '../packages/contracts/src/index.ts';
import { assertApiError, openInjectedSession } from './helpers/http.ts';

test('a plugin boot failure during construction releases the data owner for a corrected configuration', { timeout: 10_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'owntake-http-boot-failure-'));
  const dataDir = join(root, 'data');
  const invalidWebRoot = join(root, 'web-file');
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  t.after(async () => {
    try { await app?.close(); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  await writeFile(invalidWebRoot, 'A regular file cannot be a static root');
  await assert.rejects(buildApp({ dataDir, webDir: invalidWebRoot, logLevel: 'silent' }), { code: 'FST_STATIC_INVALID_OPTION' });
  const release = await acquireLock(dataDir);
  await release();

  app = await buildApp({ dataDir, port: 4317, logLevel: 'silent' });
  const session = await openInjectedSession(app, '127.0.0.1:4317');
  const projects = await app.inject({ url: '/api/projects', headers: session.headers });
  assert.equal(projects.statusCode, 200, projects.body);
  assert.deepEqual(projects.json(), []);
});

test('relative web directory overrides remain usable by the Fastify static plugin', { timeout: 10_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'owntake-http-relative-web-'));
  const webDir = join(root, 'web');
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  t.after(async () => {
    try { await app?.close(); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  await mkdir(webDir);
  await writeFile(join(webDir, 'index.html'), '<!doctype html><title>Relative web root</title>');
  app = await buildApp({
    dataDir: join(root, 'data'), webDir: relative(process.cwd(), webDir), port: 4317, logLevel: 'silent',
  });
  const response = await app.inject({ url: '/', headers: { host: '127.0.0.1:4317' } });
  assert.equal(response.statusCode, 200, response.body);
  assert.match(String(response.headers['content-type']), /^text\/html/);
  assert.match(response.body, /Relative web root/);
});

test('building and injecting the app holds one data owner without listening or executing saved jobs', { timeout: 10_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'owntake-http-build-'));
  const dataDir = join(root, 'data');
  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
  t.after(async () => {
    try { await Promise.all(apps.map(app => app.close())); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  const seed = new Store({ dataDir, projectsDir: join(dataDir, 'projects') });
  let project: Project;
  let job: Job;
  try {
    project = seed.createProject({ name: '只构造不执行', brief: '', ratio: '16:9' });
    job = seed.createJob({
      projectId: project.id,
      type: 'export',
      payload: { timelineId: 'fixture_not_to_be_executed' },
      dedupeKey: 'construct-without-background-work',
    });
  } finally { seed.close(); }

  const app = await buildApp({ dataDir, port: 4317, logLevel: 'silent' });
  apps.push(app);
  assert.equal(app.server.listening, false);
  assert.equal(app.server.address(), null);
  await assert.rejects(acquireLock(dataDir), { code: 'INSTANCE_LOCKED' });
  const session = await openInjectedSession(app, '127.0.0.1:4317');
  const response = await app.inject({ url: '/api/jobs/' + job.id, headers: session.headers });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json<Job>().status, 'queued');
  assert.equal(app.server.listening, false, 'inject must not open a real listener');
  assert.equal(app.server.address(), null);

  await Promise.all([app.close(), app.close()]);
  const release = await acquireLock(dataDir);
  await release();
  const next = await buildApp({ dataDir, port: 4317, logLevel: 'silent' });
  apps.push(next);
  const nextSession = await openInjectedSession(next, '127.0.0.1:4317');
  const restored = await next.inject({ url: '/api/jobs/' + job.id, headers: nextSession.headers });
  assert.equal(restored.statusCode, 200, restored.body);
  assert.equal(restored.json<Job>().status, 'queued');
  const projects = await next.inject({ url: '/api/projects', headers: nextSession.headers });
  assert.equal(projects.json<Project[]>()[0]?.id, project.id);
});

test('a failed listen releases its database lock and does not interfere with the server owning that port', { timeout: 15_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'owntake-http-port-conflict-'));
  const dataDir = join(root, 'data');
  const owner = createServer((_request, response) => { response.end('independent port owner'); });
  let app: Awaited<ReturnType<typeof startServer>> | undefined;
  t.after(async () => {
    try {
      await app?.close();
      owner.closeAllConnections();
      await new Promise<void>((resolve, reject) => owner.close(error => error ? reject(error) : resolve()));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  await new Promise<void>((resolve, reject) => {
    owner.once('error', reject);
    owner.listen(0, '127.0.0.1', () => { owner.off('error', reject); resolve(); });
  });
  const port = (owner.address() as AddressInfo).port;
  await assert.rejects(startServer({ dataDir, port, logLevel: 'silent' }), { code: 'EADDRINUSE' });
  const release = await acquireLock(dataDir);
  await release();
  const unaffected = await fetch('http://127.0.0.1:' + port);
  assert.equal(await unaffected.text(), 'independent port owner');

  app = await startServer({ dataDir, port: 0, logLevel: 'silent' });
  assert.equal(app.server.listening, true);
  const response = await fetch(app.url + '/api/session');
  assert.equal(response.status, 200);
  assert.equal(typeof (await response.json() as { csrfToken: string }).csrfToken, 'string');
  await Promise.all([app.close(), app.close()]);
  assert.equal(app.server.listening, false);
});

test('closing a server invalidates its session while preserving the saved project for the next instance', { timeout: 10_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'owntake-http-session-restart-'));
  const dataDir = join(root, 'data');
  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
  t.after(async () => {
    try { await Promise.all(apps.map(app => app.close())); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  const app = await buildApp({ dataDir, port: 4317, logLevel: 'silent' });
  apps.push(app);
  const session = await openInjectedSession(app, '127.0.0.1:4317');
  const created = await app.inject({
    method: 'POST', url: '/api/projects', headers: session.headers, payload: { name: '跨服务重启' },
  });
  assert.equal(created.statusCode, 201, created.body);
  const project = created.json<Project>();
  await app.close();

  const next = await buildApp({ dataDir, port: 4317, logLevel: 'silent' });
  apps.push(next);
  assertApiError(await next.inject({ url: '/api/projects', headers: session.headers }), 401, 'AUTH_REQUIRED');
  assertApiError(await next.inject({
    method: 'POST', url: '/api/projects', headers: session.headers, payload: { name: '过期会话禁止写入' },
  }), 401, 'AUTH_REQUIRED');
  const fresh = await openInjectedSession(next, '127.0.0.1:4317', session.cookie);
  assert.notEqual(fresh.cookie, session.cookie);
  const projects = await next.inject({ url: '/api/projects', headers: fresh.headers });
  assert.equal(projects.statusCode, 200, projects.body);
  assert.deepEqual(projects.json<Project[]>().map(value => value.id), [project.id]);
});

test('shutdown waits for async application work after its socket closes and preserves callback handler behavior', { timeout: 10_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'owntake-http-drain-'));
  const dataDir = join(root, 'data');
  function gate() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
  }
  const entered = gate();
  const finishWork = gate();
  const closeHooksEntered = gate();
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  let pendingRequest: Promise<unknown> | undefined;
  let savedProject: Project | undefined;
  let databaseClosedAfterWork = false;
  t.after(async () => {
    finishWork.resolve();
    try {
      await app?.close();
      await pendingRequest;
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  app = await buildApp({ dataDir, port: 0, logLevel: 'silent' });
  // A normal callback-style Fastify route must not become an empty async reply.
  app.get('/fixture-callback', (_request, reply) => {
    setImmediate(() => reply.send({ callback: true }));
  });
  app.get('/fixture-async-save', async function () {
    assert.equal(this.ownTake.store, app!.ownTake.store, 'handler wrapping must preserve its Fastify receiver');
    entered.resolve();
    await finishWork.promise;
    savedProject = this.ownTake.store.createProject({ name: '退出时完成已开始的写入', brief: '', ratio: '16:9' });
    return savedProject;
  });
  const closeDatabase = app.ownTake.store.close.bind(app.ownTake.store);
  t.mock.method(app.ownTake.store, 'close', () => {
    databaseClosedAfterWork = savedProject !== undefined;
    closeDatabase();
  });
  app.addHook('onClose', async () => { closeHooksEntered.resolve(); });
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  const callback = await fetch(url + '/fixture-callback');
  assert.deepEqual(await callback.json(), { callback: true });

  // Use a real socket: inject() alone cannot reproduce forced connection closure.
  pendingRequest = fetch(url + '/fixture-async-save').then(response => response.text()).catch(error => error);
  await entered.promise;
  let closed = false;
  const closing = app.close();
  void closing.then(() => { closed = true; }, () => { closed = true; });
  await closeHooksEntered.promise;
  await pendingRequest;
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(closed, false, 'socket closure must not release an application operation still awaiting I/O');
  await assert.rejects(acquireLock(dataDir), { code: 'INSTANCE_LOCKED' });

  finishWork.resolve();
  await closing;
  assert.ok(savedProject, 'the accepted operation completes while its database is open');
  assert.equal(databaseClosedAfterWork, true);
  const persisted = new Store({ dataDir, projectsDir: join(dataDir, 'projects') });
  try { assert.equal(persisted.getProject(savedProject.id).name, '退出时完成已开始的写入'); }
  finally { persisted.close(); }
});

test('a worker shutdown failure still closes HTTP and releases the database owner before reporting the error', { timeout: 10_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'owntake-http-stop-failure-'));
  const dataDir = join(root, 'data');
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  let next: Awaited<ReturnType<typeof buildApp>> | undefined;
  t.after(async () => {
    try {
      // close() retains the recorded shutdown failure, including on repeated calls.
      await app?.close().catch(() => undefined);
      await next?.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  app = await buildApp({ dataDir, port: 0, logLevel: 'silent' });
  await app.listen({ port: 0, host: '127.0.0.1' });
  t.mock.method(app.ownTake.scheduler, 'stop', async () => { throw new Error('fixture stop failure'); });
  await assert.rejects(app.close());
  assert.equal(app.server.listening, false);
  const release = await acquireLock(dataDir);
  await release();
  next = await buildApp({ dataDir, port: 4317, logLevel: 'silent' });
  const session = await openInjectedSession(next, '127.0.0.1:4317');
  const projects = await next.inject({ url: '/api/projects', headers: session.headers });
  assert.equal(projects.statusCode, 200, projects.body);
});
