import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../packages/contracts/src/errors.ts';
import { fetchProviderModels, parseProviderModelList } from '../packages/providers/src/provider-models.ts';
import { providerModelsForKind } from '../apps/web/src/lib/provider-models.ts';

const key = 'fixture-model-directory-key';
const video = { id: 'doubao-seedance-fixture', object: 'model', name: '视频夹具', domain: 'VideoGeneration', modalities: { output_modalities: ['video', 'audio'] }, privateField: 'discarded' };
const envelope = { object: 'list', data: [video] };
function safe(code: string) { return (error: unknown): boolean => error instanceof AppError && error.code === code && !error.message.includes(key) && !error.message.includes('private-upstream'); }

test('compatible catalogs accept Ark metadata and minimal model lists without inventing permissions', () => {
  const raw = { object: 'list', data: [video, { id: 'chat', domain: 'LLM', modalities: { output_modalities: ['text'] } }, { id: 'future' }, video] };
  const before = structuredClone(raw), models = parseProviderModelList(raw);
  assert.deepEqual(raw, before); assert.equal(models.length, 3); assert(!JSON.stringify(models).includes('privateField'));
  assert.deepEqual(providerModelsForKind(models, 'ark-video').map(x => x.id), ['doubao-seedance-fixture', 'future']);
  assert.deepEqual(providerModelsForKind(models, 'chat-completions').map(x => x.id), ['chat', 'future']);
  assert.deepEqual(providerModelsForKind(models, 'openai-speech').map(x => x.id), ['future']);
  assert.deepEqual(parseProviderModelList({ data: [] }), []);
  for (const data of [null, [], { data: {} }, { data: [{ id: '../bad id' }] }, { data: [{ id: 'valid', name: {} }] }, { data: [{ id: 'valid', modalities: { output_modalities: [1] } }] }, { data: Array.from({ length: 10001 }, () => video) }]) assert.throws(() => parseProviderModelList(data), safe('PROVIDER_MODELS_INVALID_RESPONSE'));
});

test('catalog lookup uses one GET at the configured base URL and only exposes bounded metadata', async () => {
  for (const base of ['https://ark.cn-beijing.volces.com/api/v3/', 'https://compatible.invalid/v1']) {
    let count = 0;
    const result = await fetchProviderModels(base, key, { fetch: async (url, init) => {
      ++count; assert.equal(String(url), base.replace(/\/$/, '') + '/models');
      assert.equal(init?.method, 'GET'); assert.equal(init?.body, undefined); assert.equal(init?.redirect, 'manual');
      assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${key}`);
      return Response.json(envelope);
    } });
    assert.equal(count, 1); assert.equal(result.models[0]?.id, video.id); assert(!JSON.stringify(result).includes(key));
  }
  let count = 0;
  for (const base of ['http://remote.invalid/v1', 'https://user:password@remote.invalid/v1', 'https://remote.invalid/v1?key=secret']) await assert.rejects(fetchProviderModels(base, key, { fetch: async () => { ++count; return Response.json(envelope); } }));
  await assert.rejects(fetchProviderModels('https://remote.invalid/v1', '', { fetch: async () => { ++count; return Response.json(envelope); } }), safe('CREDENTIAL_REQUIRED'));
  assert.equal(count, 0);
  await fetchProviderModels('http://127.0.0.1:1234/v1', '', { fetch: async (_url, init) => { assert.equal(new Headers(init?.headers).has('Authorization'), false); return Response.json(envelope); } });
});

test('redirects, supplier errors and echoed credentials stay redacted with no fallback request', async () => {
  for (const status of [301, 307, 401, 403, 404, 405, 429, 500]) {
    let count = 0;
    await assert.rejects(fetchProviderModels('https://directory.invalid/api/v3', key, { fetch: async () => { ++count; return new Response(key + ' private-upstream', { status, headers: { Location: 'https://other.invalid' } }); } }), safe('PROVIDER_MODELS_HTTP_ERROR'));
    assert.equal(count, 1);
  }
  await assert.rejects(fetchProviderModels('https://directory.invalid/v1', key, { fetch: async () => { throw new Error(key + ' private-upstream'); } }), safe('PROVIDER_MODELS_UNAVAILABLE'));
  for (const response of [new Response('private-upstream ' + key), Response.json({ data: [{ id: key }] }), Response.json({ data: [{ id: 'safe', name: key }] })]) await assert.rejects(fetchProviderModels('https://directory.invalid/v1', key, { fetch: async () => response }), safe('PROVIDER_MODELS_INVALID_RESPONSE'));
});

test('catalog response limits apply to declared and actual bytes', async () => {
  for (const declared of [true, false]) {
    let signal: AbortSignal | null | undefined;
    const bytes = new Uint8Array(2 * 1024 * 1024 + 1);
    await assert.rejects(fetchProviderModels('https://directory.invalid/v1', key, { fetch: async (_url, init) => { signal = init?.signal; return new Response(bytes, { headers: declared ? { 'Content-Length': String(bytes.length) } : {} }); } }), safe('PROVIDER_MODELS_TOO_LARGE'));
    assert(signal?.aborted);
  }
});

test('catalog deadlines cover stalled response bodies and cancellation stays a single read', { timeout: 5000 }, async () => {
  for (const cancel of [false, true]) {
    const caller = new AbortController(); let requests = 0;
    const guard = setTimeout(() => caller.abort(), 1000);
    try {
      const pending = fetchProviderModels('https://directory.invalid/v1', key, { signal: caller.signal, timeoutMs: 25, fetch: async (_url, init) => {
        ++requests;
        const stream = new ReadableStream({ start(controller) { init?.signal?.addEventListener('abort', () => controller.error(new Error(key)), { once: true }); } });
        return new Response(stream);
      } });
      if (cancel) caller.abort();
      await assert.rejects(pending, safe(cancel ? 'PROVIDER_MODELS_CANCELLED' : 'PROVIDER_MODELS_TIMEOUT'));
      assert.equal(requests, 1);
    } finally { clearTimeout(guard); }
  }
});


test('catalog header timeout terminates the request without attempting another address', { timeout: 5000 }, async () => {
  let requests = 0;
  const guard = setTimeout(() => undefined, 1000);
  try {
    await assert.rejects(fetchProviderModels('https://directory.invalid/v1', key, { timeoutMs: 20, fetch: async (_url, init) => {
      ++requests;
      return new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(new Error('private-upstream')), { once: true }); });
    } }), safe('PROVIDER_MODELS_TIMEOUT'));
    assert.equal(requests, 1);
  } finally { clearTimeout(guard); }
});
