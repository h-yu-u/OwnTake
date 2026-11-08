import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../packages/contracts/src/errors.ts';
import { classifyOpenAIModel, parseOpenAIModelList } from '../packages/providers/src/openai-model-catalog.ts';
import { fetchOpenAIModels } from '../packages/providers/src/openai-models-client.ts';

const key = 'test-only-model-discovery-key';
const privateDetail = 'private-upstream-error-detail';
const model = { id: 'gpt-6.1-sol', object: 'model', created: 1794000000, owned_by: 'openai' };
const listed = { id: model.id, created: model.created, ownedBy: model.owned_by, shutdownDate: null };
function response(value: unknown): Response { return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } }); }
function safeFailure(code: string, status = 502): (error: unknown) => boolean {
  return error => {
    assert(error instanceof AppError);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    for (const secret of [key, privateDetail]) assert.equal((error.message + JSON.stringify(error)).includes(secret), false);
    return true;
  };
}

test('model lists retain only metadata, deduplicate and sort without changing or verifying the input', () => {
  const input = {
    object: 'list', data: [
      { ...model, id: 'tts-1', shutdown_date: '2027-01-06', capabilities: ['all'], verified: true },
      { ...model, capabilities: { reasoning: true }, permission: [{ allow_create_engine: true }], secret: privateDetail },
      { ...model, id: 'gpt-image-2.6', shutdown_date: null },
      { ...model },
    ],
  };
  const before = structuredClone(input);
  assert.deepEqual(parseOpenAIModelList(input), [
    listed,
    { ...listed, id: 'gpt-image-2.6' },
    { ...listed, id: 'tts-1', shutdownDate: '2027-01-06' },
  ]);
  assert.deepEqual(input, before);
  assert.deepEqual(parseOpenAIModelList({ object: 'list', data: [] }), []);
});

test('model-list parsing rejects malformed metadata and excessive results as a whole', () => {
  const maximum = Array.from({ length: 10000 }, (_, index) => ({ ...model, id: `fixture-${index}` }));
  assert.equal(parseOpenAIModelList({ object: 'list', data: maximum }).length, 10000);
  const invalid = [
    null, [], { object: 'model', data: [model] }, { object: 'list', data: {} },
    { object: 'list', data: [null] },
    ...[
      { ...model, object: 'completion' }, { ...model, id: '' }, { ...model, created: 'yesterday' },
      { ...model, created: -1 }, { ...model, created: 1.5 }, { ...model, owned_by: {} },
      { ...model, shutdown_date: 17 }, { ...model, shutdown_date: '2027-02-30' },
    ].map(value => ({ object: 'list', data: [model, value] })),
    { object: 'list', data: [...maximum, { ...model, id: 'extra-model' }] },
  ];
  for (const input of invalid) assert.throws(() => parseOpenAIModelList(input), safeFailure('OPENAI_MODELS_INVALID_RESPONSE'));
});

test('name-based grouping includes current model families while separating incompatible and unknown names', () => {
  const groups = {
    reasoning: ['gpt-6.1-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6.1-luna', 'gpt-6.2-sol', 'gpt-6.1-sol-2026-11-06', 'gpt-5.4-mini', 'gpt-5-nano', 'gpt-4.1', 'gpt-4o-2024-11-20', 'o1', 'o3', 'o4-mini'],
    image: ['gpt-image-2.6', 'gpt-image-2.5-flare', 'gpt-image-1.5'],
    speech: ['gpt-4o-mini-tts', 'gpt-4o-mini-tts-2025-12-15', 'tts-1', 'tts-1-hd'],
    other: ['text-embedding-3-large', 'gpt-realtime', 'gpt-6.1-audio', 'gpt-4o-mini-transcribe', 'gpt-6-live', 'whisper-1', 'gpt-6.1-codex', 'gpt-6.1-pro', 'gpt-6-cyber', 'gpt-6-rosalind', 'gpt-4o-search-preview', 'o3-deep-research', 'gpt-5-chat-latest'],
    unknown: ['future-model-2027', 'my-custom-model'],
  } as const;
  for (const [group, ids] of Object.entries(groups)) {
    for (const id of ids) assert.equal(classifyOpenAIModel(id), group, id);
  }
});

test('model discovery sends one authenticated GET to the fixed official endpoint and returns only catalog metadata', async () => {
  let requests = 0;
  const fetcher: typeof fetch = async (input, init) => {
    requests += 1;
    assert.equal(String(input), 'https://api.openai.com/v1/models');
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'manual');
    assert.equal(init?.body, undefined);
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${key}`);
    assert(init?.signal instanceof AbortSignal);
    return response({ object: 'list', data: [model] });
  };
  const catalog = await fetchOpenAIModels(key, { fetch: fetcher });
  assert.deepEqual(catalog.models, [listed]);
  assert.ok(Number.isFinite(Date.parse(catalog.fetchedAt)));
  assert.deepEqual(Object.keys(catalog).sort(), ['fetchedAt', 'models']);
  assert.equal(requests, 1);
  assert.equal(JSON.stringify(catalog).includes(key), false);
});

test('HTTP rejections, redirects and network errors stay redacted and never trigger another metadata request', async () => {
  for (const status of [401, 403, 429, 302, 307, 500]) {
    let requests = 0;
    const fetcher: typeof fetch = async () => {
      requests += 1;
      return new Response(`${key} ${privateDetail}`, { status, headers: { location: 'https://other-service.invalid/collect-key' } });
    };
    const code = status === 401 ? 'OPENAI_MODELS_AUTH_FAILED' : status === 403 ? 'OPENAI_MODELS_FORBIDDEN' : status === 429 ? 'OPENAI_MODELS_RATE_LIMITED' : 'OPENAI_MODELS_HTTP_ERROR';
    await assert.rejects(fetchOpenAIModels(key, { fetch: fetcher }), safeFailure(code));
    assert.equal(requests, 1, String(status));
  }
  let requests = 0;
  await assert.rejects(fetchOpenAIModels(key, { fetch: async () => {
    requests += 1; throw new Error(`${privateDetail} ${key}`);
  } }), safeFailure('OPENAI_MODELS_UNAVAILABLE'));
  assert.equal(requests, 1);
});

test('invalid JSON and malformed model envelopes fail without exposing the upstream body or retrying', async () => {
  for (const body of [`not JSON: ${key} ${privateDetail}`, JSON.stringify({ object: 'list', data: [{ ...model, created: `${key} ${privateDetail}` }] })]) {
    let requests = 0;
    await assert.rejects(fetchOpenAIModels(key, { fetch: async () => {
      requests += 1; return new Response(body, { headers: { 'content-type': 'application/json' } });
    } }), safeFailure('OPENAI_MODELS_INVALID_RESPONSE'));
    assert.equal(requests, 1);
  }
});

test('the catalog response limit covers streamed bytes without trusting Content-Length', async () => {
  for (const withContentLength of [false, true]) {
    let requests = 0, cancelled = false;
    let requestSignal: AbortSignal | null | undefined;
    const bytes = new Uint8Array(1024 * 1024 + 1).fill(32);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(bytes); controller.enqueue(bytes); },
      cancel() { cancelled = true; },
    });
    await assert.rejects(fetchOpenAIModels(key, { fetch: async (_input, init) => {
      requests += 1;
      requestSignal = init?.signal;
      return new Response(stream, { headers: { ...(withContentLength ? { 'content-length': String(bytes.byteLength * 2) } : {}), 'content-type': 'application/json' } });
    } }), safeFailure('OPENAI_MODELS_TOO_LARGE'));
    assert.equal(requests, 1);
    assert.ok(cancelled || requestSignal?.aborted, 'an oversized response must cancel its stream or abort the owning fetch');
  }
});

test('the request deadline covers headers and stalled body reads and caller cancellation ends the same request', { timeout: 5000 }, async () => {
  for (const phase of ['headers', 'body', 'cancel'] as const) {
    let requests = 0, aborted = false;
    const caller = new AbortController();
    const fetcher: typeof fetch = async (_input, init) => {
      requests += 1;
      const signal = init?.signal;
      assert(signal);
      if (phase === 'headers') {
        return new Promise<Response>((_resolve, reject) => {
          const guard = setTimeout(() => reject(new Error('fixture deadline guard expired')), 1000);
          signal.addEventListener('abort', () => { aborted = true; clearTimeout(guard); reject(signal.reason); }, { once: true });
        });
      }
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"object":"list","data":['));
          const guard = setTimeout(() => controller.error(new Error('fixture body guard expired')), 1000);
          signal.addEventListener('abort', () => { aborted = true; clearTimeout(guard); controller.error(signal.reason); }, { once: true });
        },
      });
      if (phase === 'cancel') queueMicrotask(() => caller.abort(new Error(`${key} ${privateDetail}`)));
      return new Response(stream, { headers: { 'content-type': 'application/json' } });
    };
    await assert.rejects(fetchOpenAIModels(key, { fetch: fetcher, timeoutMs: phase === 'cancel' ? 1000 : 20, signal: caller.signal }),
      safeFailure(phase === 'cancel' ? 'OPENAI_MODELS_CANCELLED' : 'OPENAI_MODELS_TIMEOUT', phase === 'cancel' ? 409 : 504));
    assert.equal(requests, 1);
    assert.equal(aborted, true, `${phase} must terminate through the request abort signal`);
  }
});
