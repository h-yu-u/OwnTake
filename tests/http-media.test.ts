import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { readdirSync } from 'node:fs';
import { mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Store } from '../packages/storage/src/index.ts';
import type { ApiError } from '../packages/contracts/src/index.ts';
import { assertApiError, httpFixture, openInjectedSession } from './helpers/http.ts';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yL9sAAAAASUVORK5CYII=', 'base64');

async function seedAsset(store: Store) {
  const project = store.createProject({ name: 'HTTP media fixture' });
  const id = randomUUID();
  const relativePath = `assets/${id}/original.png`;
  const path = join(store.getProjectDir(project.id), relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, png);
  const artifact = store.addArtifact({
    id, projectId: project.id, name: '像素 图.png', kind: 'image', relativePath,
    sizeBytes: png.length, sha256: createHash('sha256').update(png).digest('hex'),
    media: { kind: 'image', durationMs: 0, width: 1, height: 1, hasAudio: false, format: 'png' },
    source: 'import', metadata: {},
  });
  return { project, artifact, path };
}

async function waitFor(check: () => Promise<boolean>, message: string): Promise<void> {
  const until = Date.now() + 3000;
  while (!await check()) {
    assert.ok(Date.now() < until, message);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test('registered media uses plugin Range and HEAD handling while retaining project file checks', async t => {
  const { app, root, host, inject } = await httpFixture(t);
  const { artifact, path } = await seedAsset(app.ownTake.store);
  const auth = await openInjectedSession(app, host);
  const url = `/api/artifacts/${artifact.id}/content`;
  const full = await inject({ url, headers: auth.headers });
  assert.equal(full.statusCode, 200, full.body);
  assert.deepEqual(full.rawPayload, png);
  assert.match(String(full.headers['content-type']), /^image\/png/);
  assert.equal(full.headers['cache-control'], 'private, max-age=3600');
  assert.match(String(full.headers['content-disposition']), /filename\*=UTF-8''/);
  const range = await inject({ url, headers: { ...auth.headers, range: 'bytes=0-7' } });
  assert.equal(range.statusCode, 206, range.body);
  assert.equal(range.headers['content-range'], `bytes 0-7/${png.length}`);
  assert.deepEqual(range.rawPayload, png.subarray(0, 8));
  const suffix = await inject({ url, headers: { ...auth.headers, range: 'bytes=-4' } });
  assert.equal(suffix.statusCode, 206, suffix.body);
  assert.deepEqual(suffix.rawPayload, png.subarray(-4));
  const invalid = await inject({ url, headers: { ...auth.headers, range: `bytes=${png.length}-` } });
  assertApiError(invalid, 416, 'INVALID_RANGE');
  assert.equal(invalid.headers['content-range'], `bytes */${png.length}`);
  const head = await inject({ method: 'HEAD', url, headers: auth.headers });
  assert.equal(head.statusCode, 200, head.body);
  assert.equal(head.headers['content-length'], String(png.length));
  assert.equal(head.rawPayload.length, 0);

  await writeFile(path, Buffer.concat([png, Buffer.of(0)]));
  assertApiError(await inject({ url, headers: auth.headers }), 409, 'ASSET_CHANGED');
  await rm(path);
  assertApiError(await inject({ url, headers: auth.headers }), 409, 'ASSET_UNAVAILABLE');
  const outside = join(root, 'outside.png');
  await writeFile(outside, png);
  await symlink(outside, path);
  assertApiError(await inject({ url, headers: auth.headers }), 403, 'FORBIDDEN_PATH');
});

test('octet-stream uploads enforce declared and chunked limits and remove incomplete files', { timeout: 15_000 }, async t => {
  const { app, inject } = await httpFixture(t, { port: 0, maxUploadBytes: 64 });
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  const host = new URL(base).host;
  const auth = await openInjectedSession(app, host);
  const project = app.ownTake.store.createProject({ name: 'Streaming upload bounds' });
  const path = `/api/projects/${project.id}/assets?name=image.png`;
  const headers = { ...auth.headers, 'content-type': 'application/octet-stream' };
  assertApiError(await inject({ method: 'POST', url: path, headers, payload: Buffer.alloc(65) }), 413, 'BODY_TOO_LARGE');
  const work = join(app.ownTake.store.getProjectDir(project.id), '.work');
  const workEntries = async () => readdir(work).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  assert.deepEqual(await workEntries(), []);

  const chunked = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const outgoing = httpRequest(base + path, { method: 'POST', headers }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', value => { body += value; });
      response.once('end', () => resolve({ status: response.statusCode!, body }));
      response.once('error', reject);
    });
    outgoing.once('error', reject);
    outgoing.write(Buffer.alloc(40));
    outgoing.end(Buffer.alloc(40));
  });
  assert.equal(chunked.status, 413, chunked.body);
  assert.equal((JSON.parse(chunked.body) as ApiError).error.code, 'BODY_TOO_LARGE');
  assert.deepEqual(await workEntries(), []);

  const interrupted = httpRequest(base + path, { method: 'POST', headers });
  interrupted.on('error', () => { /* A deliberately aborted client socket. */ });
  t.after(() => interrupted.destroy());
  interrupted.write(png.subarray(0, 16));
  await waitFor(async () => (await workEntries()).length === 1, 'streaming upload did not start writing before EOF');
  interrupted.destroy();
  await waitFor(async () => (await workEntries()).length === 0, 'aborted upload left temporary files');
  assert.deepEqual(app.ownTake.store.listArtifacts(project.id), []);
  assertApiError(await inject({ method: 'POST', url: path, headers: auth.headers, payload: {} }), 415, 'INVALID_CONTENT_TYPE');
});

test('static plugin serves the SPA without exposing API paths or symlinks outside the web build', async t => {
  const { app, root, host, inject } = await httpFixture(t);
  const web = join(root, 'web');
  await writeFile(join(web, 'bundle.js'), 'const bundled = true;');
  await mkdir(join(web, 'api'));
  await writeFile(join(web, 'api', 'secret.txt'), 'never serve this API shadow');
  const asset = await inject({ url: '/bundle.js' });
  assert.equal(asset.statusCode, 200, asset.body);
  assert.equal(asset.body, 'const bundled = true;');
  assert.equal(asset.headers['cache-control'], 'public, max-age=3600');
  const page = await inject({ url: '/projects/a-workspace' });
  assert.equal(page.statusCode, 200, page.body);
  assert.match(page.body, /OwnTake HTTP fixture/);
  assert.equal(page.headers['cache-control'], 'no-cache');
  assertApiError(await inject({ url: '/api/secret.txt' }), 401, 'AUTH_REQUIRED');
  const auth = await openInjectedSession(app, host);
  assertApiError(await inject({ url: '/api/secret.txt', headers: auth.headers }), 404, 'NOT_FOUND');
  const outside = join(root, 'private.txt');
  await writeFile(outside, 'private fixture bytes');
  await symlink(outside, join(web, 'escape.txt'));
  const escaped = await inject({ url: '/escape.txt' });
  assertApiError(escaped, 403, 'FORBIDDEN_PATH');
  assert.ok(!escaped.body.includes('private fixture bytes'));
  await rm(join(web, 'index.html'));
  await symlink(outside, join(web, 'index.html'));
  assertApiError(await inject({ url: '/nested/route' }), 403, 'FORBIDDEN_PATH');
});

test('shutdown aborts an unfinished upload and removes its work files before closing the Store', { timeout: 10_000 }, async t => {
  const { app } = await httpFixture(t, { port: 0 });
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  const auth = await openInjectedSession(app, new URL(base).host);
  const { store } = app.ownTake;
  const project = store.createProject({ name: 'Slow upload shutdown' });
  const work = join(store.getProjectDir(project.id), '.work');
  const outgoing = httpRequest(base + `/api/projects/${project.id}/assets?name=image.png`, {
    method: 'POST', headers: { ...auth.headers, 'content-type': 'application/octet-stream' },
  });
  outgoing.on('error', () => { /* Shutdown deliberately aborts this incomplete request. */ });
  const disconnected = new Promise<void>(resolve => { outgoing.once('close', resolve); });
  t.after(() => outgoing.destroy());
  outgoing.write(png.subarray(0, 16));
  await waitFor(async () => (await readdir(work)).length === 1, 'the incomplete upload did not create its staging file');
  const closeStore = store.close.bind(store);
  let closedAfterCleanup = false;
  t.mock.method(store, 'close', () => {
    assert.deepEqual(readdirSync(work), [], 'the Store closed before upload cleanup settled');
    assert.deepEqual(store.listArtifacts(project.id), []);
    closedAfterCleanup = true;
    closeStore();
  });
  await app.close();
  await disconnected;
  assert.equal(closedAfterCleanup, true);
  assert.equal(app.server.listening, false);
});

async function readThrough(reader: ReadableStreamDefaultReader<Uint8Array>, id: number): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  while (!text.includes(`id: ${id}\n`)) {
    const next = await reader.read();
    assert.equal(next.done, false, 'SSE closed before the expected persisted event');
    text += decoder.decode(next.value, { stream: true });
  }
  return text;
}

test('SSE replays persisted cursors, cleans up a disconnect and closes active connections on shutdown', { timeout: 15_000 }, async t => {
  const { app } = await httpFixture(t, { port: 0 });
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  const auth = await openInjectedSession(app, new URL(base).host);
  const { store } = app.ownTake;
  const project = store.createProject({ name: 'SSE replay' });
  assertApiError(await app.inject({ url: '/api/events?projectId=../outside', headers: auth.headers }), 400, 'INVALID_ID');
  assertApiError(await app.inject({ url: `/api/events?projectId=${project.id}&after=invalid`, headers: auth.headers }), 400, 'INVALID_INPUT');
  const before = store.getEventCursor();
  const first = store.appendEvent(project.id, 'test.first', {});
  const second = store.appendEvent(project.id, 'test.second', {});
  const url = base + `/api/events?projectId=${project.id}&after=${before}`;
  const initial = await fetch(url, { headers: { cookie: auth.cookie } });
  assert.equal(initial.status, 200);
  assert.equal(initial.headers.get('cache-control'), 'no-cache, no-transform');
  const initialReader = initial.body!.getReader();
  t.after(() => initialReader.cancel().catch(() => undefined));
  const messages = await readThrough(initialReader, second.seq);
  assert.match(messages, /retry: 1500/);
  assert.match(messages, new RegExp(`id: ${first.seq}\\n`));
  assert.match(messages, /event: change/);
  assert.ok(!messages.includes(`id: ${before}\n`));
  const job = store.createJob({ projectId: project.id, type: 'export', payload: {}, dedupeKey: 'sse-independent-task' });
  store.updateJob(job.id, { status: 'running' });
  await initialReader.cancel();
  assert.equal(store.getJob(job.id).status, 'running');
  const last = store.appendEvent(project.id, 'test.last', {});
  const reconnected = await fetch(url, { headers: { cookie: auth.cookie, 'last-event-id': String(second.seq) } });
  const reader = reconnected.body!.getReader();
  t.after(() => reader.cancel().catch(() => undefined));
  const replay = await readThrough(reader, last.seq);
  assert.ok(!replay.includes(`id: ${first.seq}\n`));
  assert.ok(!replay.includes(`id: ${second.seq}\n`));
  const live = store.appendEvent(project.id, 'test.live', {});
  assert.match(await readThrough(reader, live.seq), new RegExp(`id: ${live.seq}\\n`));
  assert.equal(store.getJob(job.id).status, 'running');
  const closing = app.close();
  while (!(await reader.read()).done) { /* Drain the finite shutdown tail. */ }
  await closing;
  assert.equal(app.server.listening, false);
});
