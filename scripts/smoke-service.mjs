#!/usr/bin/env node
/**
 * Smoke the production service bundle after `npm run build:desktop`.
 * A Node IPC adapter supplies Electron's parentPort protocol. This checks the
 * standalone bundle and HTTP/lifecycle contract, not the native Electron host.
 */
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, copyFile, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const timeout = Object.freeze({ startup: 30_000, http: 15_000, shutdown: 20_000, exit: 5000 });
const diagnosticLimit = 16 * 1024;
let temporary;
let child;
let exited;
let diagnostics = '';
let cleaned = false;

function step(message) { console.log(`[service-smoke] ${message}`); }
async function exists(path) {
  try { await access(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function bounded(promise, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds} ms`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

function waitForMessage(predicate, label, milliseconds, outgoing) {
  return new Promise((resolveMessage, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('error', onError);
      child.off('exit', onExit);
    };
    const fail = error => { cleanup(); reject(error); };
    const onError = error => fail(error);
    const onExit = (code, signal) => fail(new Error(`${label}: service exited with code ${code}, signal ${signal}`));
    const onMessage = message => {
      if (!message || typeof message !== 'object') return;
      if (message.type === 'startup-error') { fail(new Error(`Service startup failed: ${JSON.stringify(message.error)}`)); return; }
      if (predicate(message)) { cleanup(); resolveMessage(message); }
    };
    const timer = setTimeout(() => fail(new Error(`${label} timed out after ${milliseconds} ms`)), milliseconds);
    child.on('message', onMessage);
    child.once('error', onError);
    child.once('exit', onExit);
    if (child.exitCode !== null || child.signalCode !== null) { onExit(child.exitCode, child.signalCode); return; }
    if (outgoing) {
      try { child.send(outgoing, error => { if (error) fail(error); }); }
      catch (error) { fail(error); }
    }
  });
}

async function assertNoModuleFallback(directory) {
  for (let current = directory; ; current = dirname(current)) {
    assert.equal(await exists(join(current, 'node_modules')), false, `Standalone smoke requires no node_modules at ${current}`);
    if (dirname(current) === current) break;
  }
}

function environment(dataDir, projectsDir) {
  // Keep tool lookup and platform essentials, without inheriting loaders, module
  // search overrides, credentials or another OwnTake installation's settings.
  const env = {};
  for (const key of ['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'TMP', 'TEMP']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return { ...env, OWNTAKE_DATA_DIR: dataDir, OWNTAKE_PROJECTS_DIR: projectsDir, OWNTAKE_PORT: '0', OWNTAKE_LOG_LEVEL: 'silent' };
}

async function request(base, path, { method = 'GET', headers = {}, body, status = 200 } = {}) {
  const target = new URL(path, base);
  assert.equal(target.origin, base, 'Smoke requests must remain on the owned loopback service');
  const response = await fetch(target, {
    method, headers, redirect: 'error', signal: AbortSignal.timeout(timeout.http),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status !== status) throw new Error(`${method} ${path}: expected ${status}, got ${response.status}: ${(await response.text()).slice(0, 2000)}`);
  return response;
}

async function stopOwnedChild() {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  try { await bounded(exited, timeout.exit, 'Failure cleanup'); }
  catch {
    child.kill('SIGKILL');
    await bounded(exited, timeout.exit, 'Forced failure cleanup');
  }
}

try {
  for (const path of ['apps/desktop/dist/service.mjs', 'apps/web/dist/index.html']) {
    assert.ok(await exists(join(repo, path)), `Missing ${path}; run npm run build:desktop first`);
  }
  temporary = await mkdtemp(join(tmpdir(), 'owntake-service-smoke-'));
  await assertNoModuleFallback(temporary);
  const dataDir = join(temporary, 'data'), projectsDir = join(temporary, 'projects'), webDir = join(temporary, 'web');
  const wrapper = join(temporary, 'owner.mjs');
  await Promise.all([
    copyFile(join(repo, 'apps/desktop/dist/service.mjs'), join(temporary, 'service.mjs')),
    cp(join(repo, 'apps/web/dist'), webDir, { recursive: true, dereference: true }),
    writeFile(wrapper, [
      "process.parentPort = {",
      "  on(name, listener) { process.on(name, data => listener({ data })); },",
      "  postMessage(message) { process.send(message); },",
      "};",
      "await import('./service.mjs');",
      '',
    ].join('\n'), { mode: 0o600 }),
  ]);
  step('Starting the copied production bundle with no local or global module fallback');
  child = fork(wrapper, [webDir], {
    cwd: temporary, env: environment(dataDir, projectsDir),
    execArgv: ['--no-global-search-paths'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
  });
  exited = new Promise(resolveExit => child.once('exit', (code, signal) => resolveExit({ code, signal })));
  const capture = chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-diagnosticLimit); };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  child.on('error', error => capture(Buffer.from(error.message)));
  const ready = await waitForMessage(message => message.type === 'ready', 'Service readiness', timeout.startup);
  const address = new URL(ready.url);
  assert.equal(address.protocol, 'http:');
  assert.equal(address.hostname, '127.0.0.1');
  assert.ok(Number(address.port) > 0 && Number(address.port) <= 65535);
  assert.equal(address.pathname, '/');
  assert.equal(address.username + address.password + address.search + address.hash, '');
  const base = address.origin;
  const lock = join(dataDir, 'instance.lock');
  assert.ok(await exists(lock), 'Running service must own the data directory lock');

  step('Checking built HTML/JavaScript, authentication, CSRF and SQLite-backed API writes');
  const homepage = await request(base, '/');
  assert.match(homepage.headers.get('content-type') ?? '', /^text\/html/);
  const html = await homepage.text();
  assert.equal(html, await readFile(join(webDir, 'index.html'), 'utf8'));
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc=(["'])(.*?)\1[^>]*>/g)].map(match => match[2]);
  assert.ok(scripts.length > 0, 'Built HTML must load the production JavaScript');
  for (const source of scripts) {
    const url = new URL(source, base);
    assert.equal(url.origin, base);
    const localFile = resolve(webDir, '.' + decodeURIComponent(url.pathname));
    assert.ok(localFile.startsWith(webDir + sep), 'Built JavaScript must remain inside the copied web directory');
    const response = await request(base, url.pathname);
    assert.match(response.headers.get('content-type') ?? '', /(?:java|ecma)script/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(localFile));
  }
  assert.equal((await (await request(base, '/api/projects', { status: 401 })).json()).error.code, 'AUTH_REQUIRED');
  const bootstrap = await request(base, '/api/session');
  const cookies = bootstrap.headers.getSetCookie();
  assert.ok(cookies.some(value => /HttpOnly/i.test(value) && /SameSite=Strict/i.test(value)), 'Session cookie must retain local protection');
  const cookie = cookies.map(value => value.split(';')[0]).join('; ');
  const { csrfToken } = await bootstrap.json();
  assert.equal(typeof csrfToken, 'string');
  assert.ok(csrfToken.length > 0 && cookie.length > 0);
  const headers = { Cookie: cookie, 'Content-Type': 'application/json' };
  const blocked = await request(base, '/api/projects', { method: 'POST', headers, body: { name: 'blocked' }, status: 403 });
  assert.equal((await blocked.json()).error.code, 'CSRF_INVALID');
  const project = await (await request(base, '/api/projects', {
    method: 'POST', headers: { ...headers, 'X-CSRF-Token': csrfToken }, status: 201,
    body: { name: 'Production service smoke', brief: 'Isolated fixture; no model or CLI is configured.' },
  })).json();
  assert.equal(project.name, 'Production service smoke');
  assert.equal(typeof project.id, 'string');
  const snapshot = await (await request(base, `/api/projects/${project.id}`, { headers })).json();
  assert.equal(snapshot.project.id, project.id);
  assert.equal(snapshot.project.name, project.name);
  const health = await (await request(base, '/api/health', { headers })).json();
  assert.ok(['ok', 'degraded'].includes(health.status));
  assert.equal(typeof health.ffmpeg.available, 'boolean');
  assert.equal(typeof health.ffprobe.available, 'boolean');
  assert.equal(health.dataDir, dataDir);
  assert.equal(health.projectsDir, projectsDir);
  const manifest = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'));
  assert.equal(health.version, manifest.version);

  step('Checking shutdown acknowledgement, successful process exit and lock release');
  const id = randomUUID();
  const reply = await waitForMessage(message => message.type === 'reply' && message.id === id, 'Shutdown reply', timeout.shutdown, { id, method: 'shutdown' });
  assert.equal(reply.error, undefined);
  assert.deepEqual(reply.result, { stopped: true });
  assert.deepEqual(await bounded(exited, timeout.exit, 'Service exit'), { code: 0, signal: null });
  assert.equal(await exists(lock), false, 'Shutdown must release the data directory lock');
  step('PASS: standalone Node service bundle, built web assets, HTTP contracts and orderly shutdown. Native Electron is checked separately.');
} catch (error) {
  console.error('[service-smoke] FAIL:', error.stack || error);
  if (diagnostics) console.error('[service-smoke] Child diagnostics:\n' + diagnostics);
  process.exitCode = 1;
} finally {
  try { await stopOwnedChild(); cleaned = true; }
  catch (error) { console.error('[service-smoke] Cleanup failed:', error.message); process.exitCode = 1; }
  if (temporary && cleaned) await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
  else if (temporary) console.error('[service-smoke] Retained fixture after failed process cleanup:', temporary);
}
