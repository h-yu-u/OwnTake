import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OpenAIModelCatalog } from '../packages/contracts/src/openai.ts';
import { OPENAI_DEFAULT_MODELS } from '../packages/providers/src/openai-presets.ts';
import { assertApiError, httpFixture, openInjectedSession } from './helpers/http.ts';

const url = '/api/openai-connections/models';
const savedKey = 'test-only-saved-discovery-key';
const temporaryKey = 'test-only-temporary-discovery-key';
const privateDetail = 'private-upstream-discovery-detail';
const upstream = { object: 'list', data: [{ id: 'gpt-6.1-sol', object: 'model', created: 1794000000, owned_by: 'openai' }] };

test('metadata discovery requires a local session and CSRF and rejects keys or endpoint injection before any request', async t => {
  const { app, host, inject, dataDir } = await httpFixture(t);
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests += 1; return Response.json(upstream); });
  assertApiError(await inject({ method: 'POST', url, payload: { key: temporaryKey } }), 401, 'AUTH_REQUIRED');
  const session = await openInjectedSession(app, host);
  assertApiError(await inject({ method: 'POST', url, headers: { cookie: session.cookie }, payload: { key: temporaryKey } }), 403, 'CSRF_INVALID');
  for (const { payload, code } of [
    { payload: { key: temporaryKey, baseUrl: 'https://other-service.invalid/v1' }, code: 'INVALID_OPENAI_MODEL_REQUEST' },
    { payload: { key: temporaryKey, url: 'https://other-service.invalid/models' }, code: 'INVALID_OPENAI_MODEL_REQUEST' },
    { payload: { key: temporaryKey, headers: { authorization: 'injected' } }, code: 'INVALID_OPENAI_MODEL_REQUEST' },
    { payload: { key: { value: temporaryKey } }, code: 'INVALID_KEY' },
    { payload: { key: 'test-only-invalid\nkey' }, code: 'INVALID_KEY' },
    { payload: { key: temporaryKey, connectionId: 7 }, code: 'INVALID_ID' },
  ]) {
    const response = await inject({ method: 'POST', url, headers: session.headers, payload });
    assertApiError(response, 400, code);
    assert.equal(response.body.includes(temporaryKey), false);
  }
  assertApiError(await inject({ method: 'POST', url, headers: session.headers, payload: {} }), 409, 'CREDENTIAL_REQUIRED');
  assertApiError(await inject({ method: 'POST', url, headers: session.headers, payload: { key: '  ' } }), 409, 'CREDENTIAL_REQUIRED');
  assertApiError(await inject({ method: 'POST', url, headers: session.headers, payload: { connectionId: 'missing-account' } }), 404, 'OPENAI_CONNECTION_NOT_FOUND');
  assert.equal(requests, 0);
  assert.deepEqual(app.ownTake.openaiConnections.list(), []);
  assert.deepEqual(app.ownTake.providers.listProfiles(), []);
  assert.equal(existsSync(join(dataDir, 'provider-credentials.json')), false);
});

test('saved or temporary discovery credentials return metadata without persisting keys, rotating profiles or claiming verification', async t => {
  const { app, host, inject, dataDir } = await httpFixture(t);
  const { headers } = await openInjectedSession(app, host);
  const connection = app.ownTake.openaiConnections.save({ label: '已有账号', models: { ...OPENAI_DEFAULT_MODELS }, key: savedKey });
  const before = {
    connections: app.ownTake.openaiConnections.list(), profiles: app.ownTake.providers.listProfiles(),
    changes: app.ownTake.store.db.prepare('SELECT total_changes() AS count').get()?.count,
    vault: readFileSync(join(dataDir, 'provider-credentials.json'), 'utf8'),
  };
  const credentials: Array<string | null> = [];
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    assert.equal(String(input), 'https://api.openai.com/v1/models');
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'manual');
    assert.equal(init?.body, undefined);
    credentials.push(new Headers(init?.headers).get('authorization'));
    return Response.json({ ...upstream, data: [{ ...upstream.data[0], capabilities: ['all'], verified: true }] });
  });
  const requests = [
    { payload: { connectionId: connection.id }, key: savedKey },
    { payload: { connectionId: connection.id, key: '' }, key: savedKey },
    { payload: { connectionId: connection.id, key: '  ' }, key: savedKey },
    { payload: { connectionId: connection.id, key: temporaryKey }, key: temporaryKey },
    { payload: { connectionId: 'missing-account', key: temporaryKey }, key: temporaryKey },
    { payload: { key: `  ${temporaryKey}  ` }, key: temporaryKey },
  ];
  for (const request of requests) {
    const response = await inject({ method: 'POST', url, headers, payload: request.payload });
    assert.equal(response.statusCode, 200, response.body);
    const catalog = response.json<OpenAIModelCatalog>();
    assert.deepEqual(catalog.models, [{ id: 'gpt-6.1-sol', created: 1794000000, ownedBy: 'openai', shutdownDate: null }]);
    assert.ok(Number.isFinite(Date.parse(catalog.fetchedAt)));
    assert.equal(credentials.at(-1), `Bearer ${request.key}`);
    for (const secret of [savedKey, temporaryKey, 'credentialRef', 'capabilities', 'verified']) assert.equal(response.body.includes(secret), false);
    assert.deepEqual({
      connections: app.ownTake.openaiConnections.list(), profiles: app.ownTake.providers.listProfiles(),
      changes: app.ownTake.store.db.prepare('SELECT total_changes() AS count').get()?.count,
      vault: readFileSync(join(dataDir, 'provider-credentials.json'), 'utf8'),
    }, before);
  }
  assert.equal(credentials.length, requests.length);
  assert.equal(app.ownTake.store.db.prepare('SELECT COUNT(*) AS count FROM jobs').get()?.count, 0);
  assert.ok(app.ownTake.providers.listProfiles().every(profile => profile.verification === 'unverified'));
});

test('discovery errors do not expose either credential or upstream details and leave saved configuration unchanged', async t => {
  const { app, host, inject, dataDir } = await httpFixture(t);
  const { headers } = await openInjectedSession(app, host);
  const connection = app.ownTake.openaiConnections.save({ label: '保留账号', models: { ...OPENAI_DEFAULT_MODELS }, key: savedKey });
  const vault = readFileSync(join(dataDir, 'provider-credentials.json'), 'utf8');
  const changes = app.ownTake.store.db.prepare('SELECT total_changes() AS count').get()?.count;
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests += 1;
    const details = `${privateDetail} ${savedKey} ${temporaryKey}`;
    if (requests === 1) return new Response(details, { status: 401 });
    throw new Error(details);
  });
  for (const key of [undefined, temporaryKey]) {
    const response = await inject({ method: 'POST', url, headers, payload: { connectionId: connection.id, ...(key ? { key } : {}) } });
    assertApiError(response, 502, key ? 'OPENAI_MODELS_UNAVAILABLE' : 'OPENAI_MODELS_AUTH_FAILED');
    for (const secret of [savedKey, temporaryKey, privateDetail]) assert.equal(response.body.includes(secret), false);
    assert.equal('stack' in response.json<{ error: object }>().error, false);
    assert.deepEqual(app.ownTake.openaiConnections.get(connection.id), connection);
    assert.equal(readFileSync(join(dataDir, 'provider-credentials.json'), 'utf8'), vault);
    assert.equal(app.ownTake.store.db.prepare('SELECT total_changes() AS count').get()?.count, changes);
  }
  assert.equal(requests, 2, 'an upstream error must not trigger a metadata retry');
});
