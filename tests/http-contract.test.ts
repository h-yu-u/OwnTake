import test from 'node:test';
import assert from 'node:assert/strict';
import type { Project, ProjectSnapshot } from '../packages/contracts/src/index.ts';
import { assertApiError, httpFixture, openInjectedSession } from './helpers/http.ts';

test('HTTP parsers reject malformed, unsupported and oversized bodies using the API error contract', async t => {
  const { app, host, inject } = await httpFixture(t);
  const { headers } = await openInjectedSession(app, host);
  const post = (payload: string, contentType = 'application/json') => inject({
    method: 'POST',
    url: '/api/projects',
    headers: { ...headers, 'content-type': contentType },
    payload,
  });

  assertApiError(await post('{"name":'), 400, 'INVALID_JSON');
  for (const contentType of ['application/jsonx', 'text/plain', 'application/octet-stream']) {
    assertApiError(await post('{"name":"unsupported"}', contentType), 415, 'INVALID_CONTENT_TYPE');
  }
  assertApiError(await post(JSON.stringify({ name: 'x'.repeat(1024 * 1024) })), 413, 'BODY_TOO_LARGE');
  for (const value of [null, [], { name: 123 }]) {
    assertApiError(await post(JSON.stringify(value)), 400, 'INVALID_INPUT');
  }
  const created = await post('{"name":"有效 JSON"}', 'application/json; charset=utf-8');
  assert.equal(created.statusCode, 201, created.body);
  const projects = await inject({ url: '/api/projects', headers });
  assert.deepEqual(projects.json<Project[]>().map(project => project.name), ['有效 JSON']);
});

test('schemas preserve defaults and normalization without coercing JSON values or removing rejected fields', async t => {
  const { app, host, inject } = await httpFixture(t);
  const { headers } = await openInjectedSession(app, host);
  const created = await inject({
    method: 'POST',
    url: '/api/projects',
    headers,
    payload: { name: '  独立创作  ', brief: null, ratio: null, ignoredClientField: true },
  });
  assert.equal(created.statusCode, 201, created.body);
  const project = created.json<Project>();
  assert.equal(project.name, '独立创作');
  assert.equal(project.brief, '');
  assert.equal(project.ratio, '16:9');
  assert.equal('ignoredClientField' in project, false);

  for (const expectedRevision of [String(project.revision), true]) {
    assertApiError(await inject({
      method: 'PUT',
      url: '/api/projects/' + project.id,
      headers,
      payload: { name: 'must not save', expectedRevision },
    }), 400, 'INVALID_INPUT');
  }
  assertApiError(await inject({ url: '/api/projects/invalid!', headers }), 400, 'INVALID_ID');

  const clip = { artifactId: 'missing_asset', sourceInMs: 0, durationMs: 1000, fit: 'contain', muteSource: false };
  const timeline = { width: 320, height: 180, fps: 24, clips: [clip], captions: [], audio: [], expectedVersion: 0 };
  const saveTimeline = (payload: unknown) => inject({
    method: 'PUT',
    url: '/api/projects/' + project.id + '/timeline',
    headers,
    payload: JSON.stringify(payload),
  });
  assertApiError(await saveTimeline({ ...timeline, clips: [{ ...clip, muteSource: 'false' }] }), 400, 'INVALID_INPUT');
  assertApiError(await saveTimeline({
    ...timeline,
    captions: [{ startMs: 0, endMs: 1000, text: '字幕', unexpected: true }],
  }), 400, 'INVALID_TIMELINE');
  assertApiError(await saveTimeline({
    ...timeline,
    audio: [{ artifactId: 'missing_audio', startMs: 0, sourceInMs: 0, gainDb: 0, unexpected: true }],
  }), 400, 'INVALID_TIMELINE');
  const snapshot = await inject({ url: '/api/projects/' + project.id, headers });
  assert.equal(snapshot.json<ProjectSnapshot>().timeline, null, 'invalid input must not publish a timeline');
  assert.equal(snapshot.json<ProjectSnapshot>().project.revision, project.revision);
});

test('Fastify validation retains the application conflict response and complete project snapshot', async t => {
  const { app, host, inject } = await httpFixture(t);
  const { headers } = await openInjectedSession(app, host);
  const created = await inject({ method: 'POST', url: '/api/projects', headers, payload: { name: '原项目' } });
  assert.equal(created.statusCode, 201, created.body);
  const project = created.json<Project>();
  const update = { name: '新项目', brief: '保留版本语义', ratio: '9:16', expectedRevision: project.revision };
  const saved = await inject({ method: 'PUT', url: '/api/projects/' + project.id, headers, payload: update });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json<Project>().revision, project.revision + 1);
  assertApiError(await inject({
    method: 'PUT', url: '/api/projects/' + project.id, headers, payload: { ...update, name: '迟到更新' },
  }), 409, 'REVISION_CONFLICT');
  const snapshot = (await inject({ url: '/api/projects/' + project.id, headers })).json<ProjectSnapshot>();
  assert.equal(snapshot.project.name, '新项目');
  assert.equal(snapshot.project.brief, '保留版本语义');
  assert.equal(snapshot.project.ratio, '9:16');
  assert.deepEqual(snapshot.artifacts, []);
  assert.deepEqual(snapshot.jobs, []);
  assert.equal(snapshot.timeline, null);
  assert.ok(Number.isSafeInteger(snapshot.eventCursor) && snapshot.eventCursor > 0);
});

test('every API module including media and events requires a session before parsing or application work', { timeout: 15_000 }, async t => {
  const { app, host, inject } = await httpFixture(t);
  const protectedReads = [
    '/api/projects', '/api/providers', '/api/runtimes', '/api/settings', '/api/health', '/api/diagnostics',
    '/api/projects/missing/storyboard', '/api/projects/missing/generations',
    '/api/projects/missing/studio-operations', '/api/projects/missing/calls', '/api/projects/missing/jobs',
    '/api/artifacts/missing/content', '/api/artifacts/missing/thumbnail',
    '/api/studio-operations/missing/frames/missing', '/api/events?projectId=missing', '/api/unknown',
  ];
  for (const url of protectedReads) {
    const response = await inject({ url });
    assert.equal(response.statusCode, 401, url + ': ' + response.body);
    assertApiError(response, 401, 'AUTH_REQUIRED');
  }
  assertApiError(await inject({
    method: 'POST', url: '/api/projects', headers: { 'content-type': 'application/json' }, payload: '{',
  }), 401, 'AUTH_REQUIRED');

  const session = await openInjectedSession(app, host);
  const protectedWrites = [
    '/api/projects', '/api/providers', '/api/runtimes', '/api/projects/missing/shots',
    '/api/projects/missing/exports', '/api/projects/missing/reasoning',
    '/api/shots/missing/generations', '/api/projects/missing/studio-operations',
    '/api/jobs/missing/cancel', '/api/projects/missing/assets', '/api/artifacts/missing/restore',
  ];
  for (const url of protectedWrites) {
    const response = await inject({
      method: 'POST', url, headers: { cookie: session.cookie, 'content-type': 'application/json' }, payload: '{',
    });
    assert.equal(response.statusCode, 403, url + ': ' + response.body);
    assertApiError(response, 403, 'CSRF_INVALID');
  }
  const homepage = await inject({ url: '/' });
  assert.equal(homepage.statusCode, 200, homepage.body);
  assert.match(homepage.body, /OwnTake HTTP fixture/);
});

test('local Host, Origin and Fetch Metadata policies apply before session bootstrap and authenticated API access', async t => {
  const { app, host, inject } = await httpFixture(t, { devOrigin: 'http://localhost:5173' });
  const { headers } = await openInjectedSession(app, host);
  for (const url of ['/', '/api/session', '/api/projects']) {
    assertApiError(await inject({ url, headers: { ...headers, host: 'attacker.invalid:4317' } }), 403, 'FORBIDDEN_HOST');
    assertApiError(await inject({ url, headers: { ...headers, origin: 'https://attacker.invalid' } }), 403, 'FORBIDDEN_ORIGIN');
    assertApiError(await inject({
      url, headers: { ...headers, origin: 'http://' + host, 'sec-fetch-site': 'cross-site' },
    }), 403, 'FORBIDDEN_ORIGIN');
  }
  for (const origin of ['http://' + host, 'http://localhost:5173']) {
    const response = await inject({ url: '/api/projects', headers: { ...headers, origin } });
    assert.equal(response.statusCode, 200, response.body);
  }
  const localhost = await inject({ url: '/api/session', headers: { host: 'localhost:4317' } });
  assert.equal(localhost.statusCode, 200, localhost.body);
  assert.equal(localhost.headers['access-control-allow-origin'], undefined);
});

test('session cookies and CSRF tokens are scoped to their own session and malformed credentials never produce 500', async t => {
  const { app, host, inject } = await httpFixture(t);
  const session = await openInjectedSession(app, host);
  const another = await openInjectedSession(app, host);
  for (const token of ['', 'invalid', 'é'.repeat(session.token.length), another.token]) {
    assertApiError(await inject({
      method: 'POST',
      url: '/api/projects',
      headers: { ...session.headers, 'x-csrf-token': token },
      payload: { name: '拒绝越过会话' },
    }), 403, 'CSRF_INVALID');
  }
  assertApiError(await inject({
    url: '/api/projects', headers: { cookie: 'owntake_session=tampered-session-value' },
  }), 401, 'AUTH_REQUIRED');
  // Refreshing the bootstrap token must not invalidate another open tab's token.
  await openInjectedSession(app, host, session.cookie);
  const accepted = await inject({
    method: 'POST', url: '/api/projects', headers: session.headers, payload: { name: '同一会话仍可写入' },
  });
  assert.equal(accepted.statusCode, 201, accepted.body);
});

test('local sessions retain HttpOnly and SameSite protections and expire after twelve hours', async t => {
  const now = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now });
  const { app, host, inject } = await httpFixture(t);
  const bootstrap = await inject({ url: '/api/session' });
  assert.equal(bootstrap.statusCode, 200, bootstrap.body);
  const setCookie = bootstrap.headers['set-cookie'];
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
  const issued = cookies.find(value => value?.startsWith('owntake_session='));
  assert.ok(issued);
  assert.match(issued, /;\s*HttpOnly\b/i);
  assert.match(issued, /;\s*SameSite=Strict\b/i);
  assert.match(issued, /;\s*Path=\//i);
  const cookie = issued.split(';')[0]!;
  const { csrfToken } = bootstrap.json<{ csrfToken: string }>();
  t.mock.timers.setTime(now + 12 * 60 * 60 * 1000 + 1);
  assertApiError(await inject({ url: '/api/projects', headers: { cookie } }), 401, 'AUTH_REQUIRED');
  assertApiError(await inject({
    method: 'POST', url: '/api/projects',
    headers: { cookie, 'x-csrf-token': csrfToken, 'content-type': 'application/json' },
    payload: { name: '过期令牌' },
  }), 401, 'AUTH_REQUIRED');
  const refreshed = await openInjectedSession(app, host, cookie);
  const response = await inject({ url: '/api/projects', headers: refreshed.headers });
  assert.equal(response.statusCode, 200, response.body);
});

test('unknown API routes stay JSON errors while unexpected errors hide sensitive messages and stacks', async t => {
  const { app, host, inject } = await httpFixture(t);
  const privateMessage = 'fixture-provider-key /private/example/path?signature=fixture-secret';
  app.get('/test-unexpected-failure', async () => { throw new Error(privateMessage); });
  const { headers } = await openInjectedSession(app, host);
  for (const url of ['/api', '/api/', '/api/unknown', '/api/projects/missing/unknown']) {
    assertApiError(await inject({ url, headers }), 404, 'NOT_FOUND');
  }
  const failed = await inject({ url: '/test-unexpected-failure' });
  assertApiError(failed, 500, 'INTERNAL_ERROR');
  assert.equal(failed.body.includes(privateMessage), false);
  assert.equal(failed.body.includes('http-contract.test.ts'), false);
  const recovered = await inject({ url: '/api/projects', headers });
  assert.equal(recovered.statusCode, 200, recovered.body);
});
