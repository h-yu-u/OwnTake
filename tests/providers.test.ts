import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { GenerationPlan, ProviderProfile } from '../packages/contracts/src/providers.ts';
import { callReasoning, normalizeBaseUrl, parseGenerationPlan, ProviderCallError, validateAndCompile, validateProfile } from '../packages/providers/src/index.ts';
import { NativeRuntime } from '../packages/runtimes/src/native.ts';
import { describeHttpRejection } from '../packages/providers/src/http-error.ts';

const fields = { title: '清晨', purpose: '建立环境', description: '街道泛起晨光', action: '镜头缓缓前移', durationMs: 4000, caption: '早安', mode: 'generate_video', referenceArtifactIds: [] };
const operations = [{ id: 'operation_1', kind: 'add', fields }];
function completion(content = JSON.stringify({ operations })) {
  return { choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }], usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 } };
}
function profile(baseUrl = 'https://example.com/v1'): ProviderProfile {
  return { id: 'provider_test', label: '测试连接', kind: 'chat-completions', baseUrl, model: 'user-selected-model', capabilities: { inputModes: ['text'], ratios: [], durationsSec: [], maxReferences: 0 }, maxOutputTokens: 4096, timeoutMs: 1000, createdAt: '2026-11-06T00:00:00.000Z', updatedAt: '2026-11-06T00:00:00.000Z' };
}
async function localServer(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>, run: (url: string) => Promise<void>): Promise<void> {
  const server = createServer((request, response) => { Promise.resolve(handler(request, response)).catch(() => { response.writeHead(500); response.end(); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
async function readJson(request: IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function reply(response: ServerResponse, value: unknown): void { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); }

test('provider configuration is normalised, bounded and rejects endpoint or field injection', () => {
  assert.equal(normalizeBaseUrl('https://example.com/v1/'), 'https://example.com/v1');
  assert.equal(normalizeBaseUrl('http://localhost:9000/v1/'), 'http://localhost:9000/v1');
  const defaults = { ...profile(), maxOutputTokens: undefined, timeoutMs: undefined };
  assert.equal(validateProfile(defaults).maxOutputTokens, 4096); assert.equal(validateProfile(defaults).timeoutMs, 60_000);
  for (const baseUrl of ['http://example.com', 'https://user:secret@example.com/v1', 'https://example.com?key=secret', 'https://example.com/#fragment', 'not a URL', 'file:///etc/passwd']) {
    assert.throws(() => validateProfile({ ...profile(), baseUrl }), { code: 'INVALID_PROVIDER' });
  }
  assert.throws(() => validateProfile({ ...profile(), headers: { Authorization: 'injected' } }), { code: 'INVALID_PROVIDER' });
  assert.throws(() => validateProfile({ ...profile(), maxOutputTokens: 8193 }), { code: 'INVALID_PROVIDER' });
  assert.throws(() => validateProfile({ ...profile(), timeoutMs: 120001 }), { code: 'INVALID_PROVIDER' });
});

test('capability compilation preserves both frames and explicitly requires replanning for incompatible profiles', () => {
  const connection: ProviderProfile = { ...profile(), kind: 'ark-video', capabilities: { inputModes: ['text', 'first_frame'], ratios: ['16:9'], durationsSec: [5], maxReferences: 1 } };
  const plan: GenerationPlan = { kind: 'video', inputMode: 'first_last_frame', prompt: '从起点到终点', ratio: '16:9', durationSec: 5, referenceArtifactIds: ['first_frame', 'last_frame'] };
  const result = validateAndCompile(connection, plan);
  assert.equal(result.status, 'needs_replan');
  if (result.status !== 'needs_replan') assert.fail();
  assert(result.issues.some(issue => issue.code === 'INPUT_MODE_UNSUPPORTED'));
  assert.deepEqual(result.requestedPlan.referenceArtifactIds, ['first_frame', 'last_frame']);
  const supported = { ...connection, capabilities: { ...connection.capabilities, inputModes: ['first_last_frame'] as const, maxReferences: 2 } };
  const valid = validateAndCompile({ ...supported, capabilities: { ...supported.capabilities, inputModes: [...supported.capabilities.inputModes] } }, plan);
  assert.equal(valid.status, 'valid');
  if (valid.status !== 'valid') assert.fail();
  assert.deepEqual(valid.compiled.input, { mode: 'first_last_frame', firstFrameArtifactId: 'first_frame', lastFrameArtifactId: 'last_frame' });
  assert.deepEqual(plan.referenceArtifactIds, ['first_frame', 'last_frame']);
  assert.throws(() => parseGenerationPlan({ ...plan, shell: 'run this' }), { code: 'INVALID_PLAN' });
  assert.throws(() => parseGenerationPlan({ ...plan, referenceArtifactIds: ['https://untrusted.invalid/media'] }), { code: 'INVALID_PLAN' });
});

test('reasoning makes one bounded POST without unsupported tool controls and returns validated operations and safe usage', async () => {
  let calls = 0;
  await localServer(async (request, response) => {
    calls += 1;
    assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/chat/completions');
    assert.equal(request.headers.authorization, 'Bearer test-key');
    const body = await readJson(request);
    assert.equal(body.model, 'user-selected-model'); assert.equal(body.max_completion_tokens, 4096);
    assert.equal(body.n, 1); assert.equal(body.stream, false); assert.equal(body.store, false);
    assert.equal(body.tool_choice, undefined); assert.equal(body.tools, undefined);
    assert.equal(body.response_format.json_schema.strict, true);
    assert.equal(body.response_format.json_schema.schema.additionalProperties, false);
    assert.equal(JSON.parse(body.messages[1].content).brief, '拍一段清晨街景');
    reply(response, completion());
  }, async url => {
    const result = await callReasoning(profile(url), 'test-key', { brief: '拍一段清晨街景', shots: [] });
    assert.deepEqual(result.operations, operations); assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 200, totalTokens: 300 });
  });
  assert.equal(calls, 1);
});

test('malformed JSON, truncated output and injected model commands are rejected without another POST', async () => {
  const variants = [
    'not JSON and secret-test-key',
    JSON.stringify(completion(JSON.stringify({ operations: [{ ...operations[0], shell: 'do not execute' }] }))),
    JSON.stringify(completion(JSON.stringify({ operations: [{ ...operations[0], fields: { ...fields, command: 'do not execute' } }] }))),
    JSON.stringify({ choices: [{ ...completion().choices[0], finish_reason: 'length' }] }),
    JSON.stringify({ choices: [{ ...completion().choices[0], message: { ...completion().choices[0]!.message, tool_calls: [{ type: 'function', function: { name: 'shell', arguments: '{}' } }] } }] }),
    JSON.stringify(completion(JSON.stringify({ operations: [{ id: 'delete_missing', kind: 'delete', shotId: 'not_in_snapshot' }] }))),
  ];
  for (const body of variants) {
    let calls = 0;
    await localServer((_request, response) => { calls += 1; response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(body); }, async url => {
      await assert.rejects(callReasoning(profile(url), 'secret-test-key', { brief: '创作简报', shots: [] }), error => {
        assert(error instanceof ProviderCallError); assert.equal(error.classification, 'invalid_response');
        assert.doesNotMatch(JSON.stringify(error) + error.message, /secret-test-key|do not execute/); return true;
      });
    });
    assert.equal(calls, 1);
  }
});

test('HTTP errors are redacted, ambiguous server errors remain unknown and redirects are not followed', async () => {
  for (const status of [429, 307, 408, 500]) {
    let calls = 0;
    await localServer((_request, response) => { calls += 1; response.writeHead(status, { Location: '/unexpected-second-call' }); response.end('secret-key and private request'); }, async url => {
      await assert.rejects(callReasoning(profile(url), 'secret-key', { brief: '创作简报', shots: [] }), error => {
        assert(error instanceof ProviderCallError); assert.equal(error.classification, status === 408 || status >= 500 ? 'submission_unknown' : 'http_rejected'); assert.equal(error.httpStatus, status);
        assert.doesNotMatch(error.message + JSON.stringify(error), /secret-key|private request/); return true;
      });
    });
    assert.equal(calls, 1);
  }
});

test('HTTP rejection diagnostics allow only known codes and parameters, never supplier prose or arbitrary fields', () => {
  for (const [status, code, explanation] of [
    [401, 'invalid_api_key', /API Key 无效/], [429, 'insufficient_quota', /余额或额度不足/],
    [429, 'rate_limit_exceeded', /限流/], [404, 'model_not_found', /模型不存在或当前账号无权/],
    [400, 'unsupported_parameter', /不支持请求中的某个参数/], [400, 'invalid_json_schema', /JSON Schema/],
  ] as const) {
    const message = describeHttpRejection(status, { error: { code, param: 'response_format', message: 'secret-key and private brief', request: 'private brief' } });
    assert.match(message, new RegExp(`HTTP ${status}`)); assert(message.includes(code)); assert.match(message, explanation);
    assert.match(message, /response_format/); assert.doesNotMatch(message, /secret-key|private brief/);
  }
  for (const raw of [null, [], 'secret-key', { error: { code: 'secret-key', param: 'private brief', type: '__proto__', message: 'secret-key' } }]) {
    assert.doesNotMatch(describeHttpRejection(400, raw), /secret-key|private brief|__proto__/);
  }
  assert.match(describeHttpRejection(429, { error: { code: null, type: 'insufficient_quota' } }), /余额或额度不足/);
  assert.match(describeHttpRejection(429, {}), /未取得具体原因/);
});

test('a rejected POST retains bounded safe diagnostics and its HTTP classification even with broken or slow bodies', async () => {
  for (const mode of ['json', 'malformed', 'oversized', 'declared-oversized', 'slow', 'disconnect']) {
    let calls = 0;
    await localServer((_request, response) => {
      calls++;
      const body = JSON.stringify({ error: { code: 'insufficient_quota', message: 'secret-key private brief' } });
      response.writeHead(429, { 'Content-Type': 'application/json', ...(mode === 'declared-oversized' ? { 'Content-Length': 20_000 } : {}) });
      if (mode === 'slow' || mode === 'disconnect') { response.write('{'); if (mode === 'disconnect') setTimeout(() => response.destroy(), 20); return; }
      response.end(mode === 'json' ? body : mode === 'malformed' ? '{secret-key' : 'x'.repeat(20_000));
    }, async url => {
      await assert.rejects(callReasoning({ ...profile(url), timeoutMs: 2000 }, 'secret-key', { brief: 'private brief', shots: [] }), error => {
        assert(error instanceof ProviderCallError);
        assert.equal(error.classification, 'http_rejected'); assert.equal(error.httpStatus, 429);
        assert.match(error.message, /HTTP 429/);
        if (mode === 'json') assert.match(error.message, /insufficient_quota/);
        assert.doesNotMatch(JSON.stringify(error) + error.message, /secret-key|private brief/);
        return true;
      });
    });
    assert.equal(calls, 1, mode);
  }
});

test('timeout covers response body reads and records submission_unknown without retrying', async () => {
  let calls = 0;
  await localServer((_request, response) => { calls += 1; response.writeHead(200, { 'Content-Type': 'application/json' }); response.write('{'); }, async url => {
    await assert.rejects(callReasoning({ ...profile(url), timeoutMs: 150 }, '', { brief: '创作简报', shots: [] }), { classification: 'submission_unknown', code: 'PROVIDER_SUBMISSION_UNKNOWN' });
  });
  assert.equal(calls, 1);
});

test('connection loss after POST is submission_unknown and an oversized body is not accepted', async () => {
  let calls = 0;
  await localServer(async (request, response) => { calls += 1; await readJson(request); response.destroy(); }, async url => {
    await assert.rejects(callReasoning(profile(url), '', { brief: '创作简报', shots: [] }), { classification: 'submission_unknown' });
  });
  assert.equal(calls, 1);
  await localServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('x'.repeat(1024 * 1024 + 1)); }, async url => {
    await assert.rejects(callReasoning(profile(url), '', { brief: '创作简报', shots: [] }), { classification: 'invalid_response', code: 'PROVIDER_RESPONSE_TOO_LARGE' });
  });
});

test('NativeRuntime has one active call per task, no tools and explicit cancellability', async () => {
  const runtime = new NativeRuntime(); let received!: () => void;
  const arrival = new Promise<void>(resolve => { received = resolve; }); let calls = 0;
  await localServer(async (request, _response) => { calls += 1; await readJson(request); received(); }, async url => {
    const running = runtime.run('task_1', profile(url), '', { brief: '创作简报', shots: [] });
    const rejected = assert.rejects(running, { classification: 'submission_unknown' });
    await arrival;
    await assert.rejects(runtime.run('task_1', profile(url), '', { brief: '创作简报', shots: [] }), { code: 'TASK_ALREADY_RUNNING' });
    assert.equal(runtime.cancel('task_1'), true); await rejected; assert.equal(runtime.cancel('task_1'), false);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(runtime.run('task_2', profile(url), '', { brief: '创作简报', shots: [], signal: controller.signal }), { classification: 'cancelled' });
  });
  assert.equal(calls, 1); assert.deepEqual(runtime.capabilities(), { id: 'native', maxSteps: 1, tools: [], permissions: [] });
});
