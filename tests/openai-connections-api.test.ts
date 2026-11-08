import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OpenAIConnectionSummary } from '../packages/contracts/src/openai.ts';
import type { ProviderProfile, ProviderSummary } from '../packages/contracts/src/providers.ts';
import { OPENAI_DEFAULT_MODELS } from '../packages/providers/src/openai-presets.ts';
import { assertApiError, httpFixture, openInjectedSession } from './helpers/http.ts';

const key = 'test-only-openai-http-key';
const updatedKey = 'test-only-openai-http-rotated-key';
const payload = { label: 'OpenAI 统一入口', models: { ...OPENAI_DEFAULT_MODELS }, key };

test('OpenAI connection reads and writes inherit the local session and CSRF policies', async t => {
  const { app, host, inject } = await httpFixture(t);
  assertApiError(await inject({ url: '/api/openai-connections' }), 401, 'AUTH_REQUIRED');
  assertApiError(await inject({
    method: 'POST', url: '/api/openai-connections', headers: { 'content-type': 'application/json' }, payload,
  }), 401, 'AUTH_REQUIRED');
  const session = await openInjectedSession(app, host);
  for (const request of [
    { method: 'POST' as const, url: '/api/openai-connections' },
    { method: 'PUT' as const, url: '/api/openai-connections/missing-connection' },
  ]) {
    assertApiError(await inject({ ...request, headers: { cookie: session.cookie }, payload }), 403, 'CSRF_INVALID');
  }
  assert.deepEqual(app.ownTake.openaiConnections.list(), []);
  assert.deepEqual(app.ownTake.providers.listProfiles(), []);
});

test('the unified API saves one account, refreshes all capability targets and leaves protocol-compatible connections editable', async t => {
  const { app, host, inject, dataDir } = await httpFixture(t);
  const { headers } = await openInjectedSession(app, host);
  const created = await inject({ method: 'POST', url: '/api/openai-connections', headers, payload });
  assert.equal(created.statusCode, 201, created.body);
  const connection = created.json<OpenAIConnectionSummary>();
  assert.equal(connection.hasKey, true);
  assert.equal(connection.verification, 'unverified');
  assert.equal(connection.revision, 1);
  assert.equal(created.body.includes(key), false);
  assert.equal(created.body.includes('credentialRef'), false);

  const listed = await inject({ url: '/api/openai-connections', headers });
  assert.deepEqual(listed.json<OpenAIConnectionSummary[]>(), [connection]);
  const providersResponse = await inject({ url: '/api/providers', headers });
  assert.equal(providersResponse.statusCode, 200, providersResponse.body);
  const providers = providersResponse.json<ProviderSummary[]>();
  assert.equal(providers.length, 3);
  assert.ok(providers.every(profile => profile.connectionId === connection.id && profile.hasKey));
  assert.equal(providersResponse.body.includes(key), false);
  assert.equal(Object.keys(JSON.parse(readFileSync(join(dataDir, 'provider-credentials.json'), 'utf8'))).length, 1);
  assert.equal(app.ownTake.store.db.prepare('SELECT COUNT(*) AS count FROM jobs').get()?.count, 0,
    'saving settings must not create a model invocation or media job');

  const managed = providers.find(profile => profile.id === connection.profileIds.reasoning)!;
  const { hasKey: _hasKey, verification: _verification, connectionId: _connectionId, ...profileFields } = managed;
  assertApiError(await inject({
    method: 'PUT', url: `/api/providers/${managed.id}`, headers, payload: { ...profileFields, label: '不能拆散共同连接' },
  }), 409, 'MANAGED_PROVIDER');

  const compatible: Omit<ProviderProfile, 'id' | 'createdAt' | 'updatedAt'> = {
    label: '自定义兼容模型', kind: 'chat-completions', baseUrl: 'http://127.0.0.1:9401/v1', model: 'fixture-model',
    capabilities: { inputModes: ['text'], ratios: [], durationsSec: [], maxReferences: 0 },
    maxOutputTokens: 2048, timeoutMs: 1000,
  };
  const legacyCreated = await inject({ method: 'POST', url: '/api/providers', headers, payload: compatible });
  assert.equal(legacyCreated.statusCode, 201, legacyCreated.body);
  const legacy = legacyCreated.json<ProviderSummary>();
  const legacyEdited = await inject({ method: 'PUT', url: `/api/providers/${legacy.id}`, headers, payload: { ...compatible, label: '仍然可以独立修改' } });
  assert.equal(legacyEdited.statusCode, 200, legacyEdited.body);
  assert.equal(legacyEdited.json<ProviderSummary>().label, '仍然可以独立修改');

  const updated = await inject({
    method: 'PUT', url: `/api/openai-connections/${connection.id}`, headers,
    payload: { ...payload, label: '更新后的 OpenAI', key: updatedKey, expectedRevision: connection.revision },
  });
  assert.equal(updated.statusCode, 200, updated.body);
  const current = updated.json<OpenAIConnectionSummary>();
  assert.equal(current.revision, 2);
  assert.deepEqual(current.profileIds, connection.profileIds);
  const currentProfiles = (await inject({ url: '/api/providers', headers })).json<ProviderSummary[]>();
  assert.equal(currentProfiles.length, 4);
  assert.equal(currentProfiles.filter(profile => profile.connectionId === current.id).length, 3);
  const credentialRefs = Object.values(current.profileIds).map(id => app.ownTake.providers.getProfile(id).credentialRef);
  assert.equal(new Set(credentialRefs).size, 1);
  assert.equal(app.ownTake.providers.vault.get(credentialRefs[0]!), updatedKey);
  assertApiError(await inject({
    method: 'PUT', url: `/api/openai-connections/${connection.id}`, headers,
    payload: { ...payload, key: 'test-only-stale-must-not-save', expectedRevision: connection.revision },
  }), 409, 'REVISION_CONFLICT');
  assert.equal(Object.keys(JSON.parse(readFileSync(join(dataDir, 'provider-credentials.json'), 'utf8'))).length, 2);
  for (const secret of [key, updatedKey]) assert.equal(JSON.stringify([current, currentProfiles]).includes(secret), false);
});

test('unified connection schemas reject partial models, injected endpoints and invalid key fields before saving', async t => {
  const { app, host, inject, dataDir } = await httpFixture(t);
  const { headers } = await openInjectedSession(app, host);
  for (const input of [
    { ...payload, models: { reasoning: payload.models.reasoning, image: payload.models.image } },
    { ...payload, models: { ...payload.models, speech: 7 } },
    { ...payload, baseUrl: 'https://other-service.invalid/v1' },
    { ...payload, key: { secret: key } },
    { ...payload, key: 'test-only-key\ninvalid' },
  ]) {
    const response = await inject({ method: 'POST', url: '/api/openai-connections', headers, payload: input });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.body.includes(key), false);
    assert.deepEqual(app.ownTake.openaiConnections.list(), []);
    assert.deepEqual(app.ownTake.providers.listProfiles(), []);
  }
  const missingKey = await inject({ method: 'POST', url: '/api/openai-connections', headers, payload: { ...payload, key: '' } });
  assertApiError(missingKey, 409, 'CREDENTIAL_REQUIRED');
  const created = await inject({ method: 'POST', url: '/api/openai-connections', headers, payload });
  assert.equal(created.statusCode, 201, created.body);
  const connection = created.json<OpenAIConnectionSummary>();
  const missingVersion = await inject({ method: 'PUT', url: `/api/openai-connections/${connection.id}`, headers, payload });
  assert.equal(missingVersion.statusCode, 400, missingVersion.body);
  assert.equal(app.ownTake.openaiConnections.get(connection.id).revision, 1);
  assert.equal(Object.keys(JSON.parse(readFileSync(join(dataDir, 'provider-credentials.json'), 'utf8'))).length, 1);
});
