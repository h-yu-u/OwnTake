import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../apps/server/src/app.ts';
import type { CallRecord } from '../packages/contracts/src/calls.ts';
import type { BoardSnapshot } from '../packages/contracts/src/storyboard.ts';
const fields = { title: '晨光', purpose: '建立氛围', description: '窗边暖光', action: '缓慢推进', durationMs: 3000, caption: '清晨', mode: 'import', referenceArtifactIds: [] };
test('reasoning API freezes one billed intent, applies only reviewed changes, and never resubmits unknown calls after restart', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'owntake-reasoning-')); let count = 0, drop = false;
  const fixture = createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume the exact POST before simulating loss */ }
    count++;
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.headers.authorization, 'Bearer private-test-key');
    if (drop) { res.destroy(); return; }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ operations: ['a','b','c','d'].map(id => ({ id, kind: 'add', fields: { ...fields, title: id } })) }) } }] }));
  });
  await new Promise<void>(r => fixture.listen(0, '127.0.0.1', r));
  let app = await startServer({ dataDir: join(root, 'app'), port: 0 });
  let cookie = '', csrf = '';
  async function login() { const r = await fetch(app.url + '/api/session'); cookie = r.headers.get('set-cookie')!.split(';')[0]!; csrf = (await r.json() as {csrfToken: string}).csrfToken; }
  async function api(path: string, method = 'GET', body?: unknown, status = 200): Promise<any> {
    const r = await fetch(app.url + path, { method, headers: { Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await r.json(); assert.equal(r.status, status, JSON.stringify(data)); return data;
  }
  async function terminal(id: string, projectId: string): Promise<CallRecord> {
    for (let i = 0; i < 100; i++) { const calls = await api(`/api/projects/${projectId}/calls`) as CallRecord[]; const call = calls.find(c => c.id === id)!; if (!['queued','submitting'].includes(call.status)) return call; await new Promise(r => setTimeout(r, 20)); }
    throw new Error('call did not finish');
  }
  try {
    await login(); const project = await api('/api/projects', 'POST', { name: '推理验证', brief: '四镜头晨光短片', ratio: '16:9' }, 201);
    const profile = await api('/api/providers', 'POST', { label: 'HTTP fixture', kind: 'chat-completions', baseUrl: `http://127.0.0.1:${(fixture.address() as AddressInfo).port}/v1`, model: 'contract-fixture', capabilities: { inputModes: ['text'], ratios: ['16:9'], durationsSec: [], maxReferences: 0 }, maxOutputTokens: 2048, timeoutMs: 1000, key: 'private-test-key' }, 201);
    assert.equal(profile.hasKey, true); assert(!JSON.stringify(profile).includes('private-test-key'));
    const { hasKey: _hasKey, verification: _verification, ...profileFields } = profile;
    await api(`/api/providers/${profile.id}`, 'PUT', { ...profileFields, baseUrl: 'https://another-service.invalid/v1', key: '' }, 400);
    assert.equal(app.providers.getProfile(profile.id).profile.baseUrl, profile.baseUrl, 'a different origin must not receive an old service key');
    const credentials = join(app.config.dataDir, 'provider-credentials.json'); assert.equal((await stat(credentials)).mode & 0o777, 0o600);
    assert((await readFile(credentials, 'utf8')).includes('private-test-key'));
    const request = { providerId: profile.id, expectedProviderUpdatedAt: profile.updatedAt, clientRequestId: 'one-intent', expectedBoardRevision: 0, expectedProjectRevision: project.revision, reservation: { currency: 'USD', amount: 1, singleLimit: 1, projectLimit: 2 } };
    const blank = await api('/api/projects', 'POST', { name: '未写简报', brief: '', ratio: '16:9' }, 201);
    await api(`/api/projects/${blank.id}/reasoning`, 'POST', request, 400); assert.equal((await api(`/api/projects/${blank.id}/calls`)).length, 0);
    const call = await api(`/api/projects/${project.id}/reasoning`, 'POST', request, 202);
    const duplicate = await api(`/api/projects/${project.id}/reasoning`, 'POST', request, 202); assert.equal(duplicate.id, call.id);
    assert.equal((await terminal(call.id, project.id)).status, 'succeeded'); assert.equal(count, 1);
    let board = await api(`/api/projects/${project.id}/storyboard`) as BoardSnapshot;
    assert.equal(board.shots.length, 0); assert.equal(board.drafts[0]!.operations.length, 4);
    board = await api(`/api/drafts/${board.drafts[0]!.id}/apply`, 'POST', { acceptedOperationIds: ['a','c'], expectedBoardRevision: 0 });
    assert.deepEqual(board.shots.map(s => s.title).sort(), ['a','c']);
    drop = true;
    const uncertainRequest = { ...request, clientRequestId: 'accepted-but-lost', expectedBoardRevision: board.revision };
    const uncertain = await api(`/api/projects/${project.id}/reasoning`, 'POST', uncertainRequest, 202);
    assert.equal((await terminal(uncertain.id, project.id)).status, 'submission_unknown'); assert.equal(count, 2);
    await api(`/api/projects/${project.id}/reasoning`, 'POST', { ...uncertainRequest, clientRequestId: 'over-budget' }, 409);
    await app.close(); app = await startServer({ dataDir: join(root, 'app'), port: 0 }); await login();
    const same = await api(`/api/projects/${project.id}/reasoning`, 'POST', uncertainRequest, 202); assert.equal(same.id, uncertain.id); assert.equal(same.status, 'submission_unknown');
    await new Promise(r => setTimeout(r, 600)); assert.equal(count, 2, 'startup must not replay a possible paid POST');
    const settled = await api(`/api/calls/${uncertain.id}/settle`, 'POST', { actualAmount: 0.5, currency: 'USD', note: '人工核对测试账单记录' }); assert.equal(settled.actualAmount, 0.5);
    const publicData = JSON.stringify(await api(`/api/projects/${project.id}/calls`)); assert(!publicData.includes('private-test-key')); assert(!publicData.includes('credentialRef'));
  } finally { await app.close(); fixture.closeAllConnections(); await new Promise<void>(r => fixture.close(() => r())); await rm(root, { recursive: true, force: true }); }
});
