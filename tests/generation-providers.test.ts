import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Artifact } from '../packages/contracts/src/index.ts';
import type { GenerationPlan, ProviderProfile } from '../packages/contracts/src/providers.ts';
import { ProviderCallError } from '../packages/providers/src/errors.ts';
import { describeConnectionFailure } from '../packages/providers/src/http-error.ts';
import { cancelGeneration, compileGenerationRequest, pollGeneration, submitGeneration, validateGeneration } from '../packages/providers/src/generation.ts';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6akAAAAASUVORK5CYII=', 'base64');
const pngUrl = `data:image/png;base64,${png.toString('base64')}`;
const imagePlan: GenerationPlan = { kind: 'image', inputMode: 'text', prompt: '窗边的清晨', ratio: '16:9', referenceArtifactIds: [] };
const videoPlan: GenerationPlan = { kind: 'video', inputMode: 'text', prompt: '缓慢推进镜头', ratio: '16:9', durationSec: 5, referenceArtifactIds: [] };

function profile(kind: 'openai-images' | 'ark-video', baseUrl = 'https://provider.example/v1'): ProviderProfile {
  return { id: 'provider_fixture', label: '用户配置连接', kind, baseUrl, model: 'configured-model', capabilities: { inputModes: ['text', 'first_frame', 'first_last_frame', 'references'], ratios: ['16:9', '9:16', '1:1'], durationsSec: [5, 10], maxReferences: 16 }, maxOutputTokens: 4096, timeoutMs: 1000, createdAt: '2026-11-06T00:00:00.000Z', updatedAt: '2026-11-06T00:00:00.000Z' };
}

function reference(id: string, patch: Partial<Artifact> = {}): Artifact {
  return { id, projectId: 'project_a', name: '参考.png', kind: 'image', relativePath: `assets/${id}/original.png`, sha256: '0'.repeat(64), sizeBytes: png.length, source: 'import', createdAt: '2026-11-06T00:00:00.000Z', metadata: {}, media: { kind: 'image', durationMs: 0, width: 1280, height: 720, format: 'png_pipe', codec: 'png', hasAudio: false }, ...patch };
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

function reply(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body));
}

test('image requests preserve configured models and exact ratios without deprecated response_format', () => {
  for (const [ratio, size] of [['16:9', '1536x864'], ['9:16', '864x1536'], ['1:1', '1024x1024']] as const) {
    const request = compileGenerationRequest(profile('openai-images'), { ...imagePlan, ratio }, {});
    assert.equal(request.endpoint, '/images/generations');
    assert.deepEqual(request.body, { model: 'configured-model', prompt: imagePlan.prompt, n: 1, output_format: 'png', size });
    assert.equal(Object.hasOwn(request.body, 'response_format'), false);
  }
  assert.equal(validateGeneration({ ...profile('openai-images'), model: 'gpt-image-1' }, imagePlan, []).status, 'needs_replan');
  assert.equal(validateGeneration({ ...profile('openai-images'), model: 'gpt-image-1' }, { ...imagePlan, ratio: '1:1' }, []).status, 'valid');
  assert.equal(validateGeneration({ ...profile('openai-images'), model: 'dall-e-3' }, { ...imagePlan, ratio: '1:1' }, []).status, 'needs_replan');
  assert.throws(() => compileGenerationRequest(profile('openai-images'), { ...imagePlan, inputMode: 'first_frame', referenceArtifactIds: ['ref_a'] }, { ref_a: pngUrl }), { code: 'GENERATION_NEEDS_REPLAN' });
});

test('image quality is explicit and preserved while legacy plans retain provider defaults', () => {
  for (const quality of ['low', 'medium', 'high'] as const) {
    const request = compileGenerationRequest(profile('openai-images'), { ...imagePlan, imageQuality: quality }, {});
    assert.equal(request.body.quality, quality);
  }
  assert.equal(Object.hasOwn(compileGenerationRequest(profile('openai-images'), imagePlan, {}).body, 'quality'), false);
  for (const imageQuality of [null, 'auto', '--tools', { toString: 'low' }, 1]) {
    assert.throws(() => compileGenerationRequest(profile('openai-images'), { ...imagePlan, imageQuality } as GenerationPlan, {}), { code: 'INVALID_PLAN' });
  }
  assert.throws(() => compileGenerationRequest(profile('ark-video'), { ...videoPlan, imageQuality: 'low' }, {}), { code: 'INVALID_PLAN' });
});

test('Ark compilation preserves first/last order and explicit reference roles without emitting external URLs', () => {
  const plan: GenerationPlan = { ...videoPlan, inputMode: 'first_last_frame', referenceArtifactIds: ['first', 'last'] };
  const secondUrl = `data:image/png;base64,${Buffer.concat([png, Buffer.from('last')]).toString('base64')}`;
  const request = compileGenerationRequest(profile('ark-video'), plan, { last: secondUrl, first: pngUrl });
  assert.equal(request.endpoint, '/contents/generations/tasks');
  assert.deepEqual(request.body, { model: 'configured-model', content: [{ type: 'text', text: videoPlan.prompt }, { type: 'image_url', image_url: { url: pngUrl }, role: 'first_frame' }, { type: 'image_url', image_url: { url: secondUrl }, role: 'last_frame' }], ratio: '16:9', duration: 5 });
  const references = compileGenerationRequest(profile('ark-video'), { ...plan, inputMode: 'references' }, { first: pngUrl, last: secondUrl });
  assert.deepEqual((references.body.content as any[]).slice(1).map(item => item.role), ['reference_image', 'reference_image']);
  const first = compileGenerationRequest(profile('ark-video'), { ...videoPlan, inputMode: 'first_frame', referenceArtifactIds: ['first'] }, { first: pngUrl });
  assert.equal((first.body.content as any[])[1].role, 'first_frame');
  assert.throws(() => compileGenerationRequest(profile('ark-video'), plan, { first: pngUrl, last: 'https://third-party.invalid/private.png' }), { code: 'INVALID_REFERENCE_DATA' });
  assert.throws(() => compileGenerationRequest(profile('ark-video'), plan, { first: pngUrl, last: pngUrl, secret_file: pngUrl }), { code: 'INVALID_REFERENCE_DATA' });
});

test('generation validation rejects incompatible modes, malformed references and unreviewed weak parameters', () => {
  const plan: GenerationPlan = { ...videoPlan, inputMode: 'first_frame', referenceArtifactIds: ['ref_a'] };
  const connection = profile('ark-video');
  assert.equal(validateGeneration(connection, plan, [reference('ref_a')]).status, 'valid');
  const variants: Artifact[] = [
    reference('ref_a', { kind: 'video', media: { kind: 'video', durationMs: 5000, width: 1280, height: 720, format: 'mp4', hasAudio: false } }),
    reference('ref_a', { sizeBytes: 16 * 1024 * 1024 + 1 }),
    reference('ref_a', { media: { kind: 'image', durationMs: 0, width: 299, height: 300, format: 'png', hasAudio: false } }),
    reference('ref_a', { media: { kind: 'image', durationMs: 0, width: 1000, height: 300, format: 'png', hasAudio: false } }),
    reference('ref_a', { media: { kind: 'image', durationMs: 0, width: 1000, height: 500, format: 'svg', hasAudio: false } }),
  ];
  for (const artifact of variants) assert.equal(validateGeneration(connection, plan, [artifact]).status, 'needs_replan');
  assert.equal(validateGeneration(connection, plan, []).status, 'needs_replan');
  assert.equal(validateGeneration({ ...connection, capabilities: { ...connection.capabilities, inputModes: ['text'] } }, plan, [reference('ref_a')]).status, 'needs_replan');
  assert.equal(validateGeneration({ ...connection, capabilities: { ...connection.capabilities, durationsSec: [5.5] } }, { ...videoPlan, durationSec: 5.5 }, []).status, 'needs_replan');
  assert.equal(validateGeneration(connection, { ...videoPlan, prompt: 'scene --frames 99999' }, []).status, 'needs_replan');
  const largePlan: GenerationPlan = { ...videoPlan, inputMode: 'references', referenceArtifactIds: ['a', 'b'] };
  assert.equal(validateGeneration(connection, largePlan, [reference('a', { sizeBytes: 16 * 1024 * 1024 }), reference('b', { sizeBytes: 16 * 1024 * 1024 })]).status, 'needs_replan');
});

test('OpenAI Images submits once and decodes one bounded PNG response', async () => {
  let posts = 0;
  await localServer(async (request, response) => {
    posts += 1; assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/images/generations');
    assert.equal(request.headers.authorization, 'Bearer image-key');
    const body = await readJson(request);
    assert.equal(body.model, 'configured-model'); assert.equal(body.output_format, 'png'); assert.equal(body.n, 1); assert.equal(body.response_format, undefined);
    reply(response, { data: [{ b64_json: png.toString('base64') }] });
  }, async url => {
    const result = await submitGeneration(profile('openai-images', url), 'image-key', imagePlan, {});
    assert.equal(result.kind, 'inline');
    if (result.kind !== 'inline') assert.fail();
    assert.equal(result.mime, 'image/png'); assert.deepEqual(Buffer.from(result.bytes), png);
  });
  assert.equal(posts, 1);
});

test('Ark returns the original remote ID and subsequent polls only GET that exact task', async () => {
  const calls: string[] = [];
  let polls = 0;
  await localServer(async (request, response) => {
    calls.push(`${request.method} ${request.url}`);
    assert.equal(request.headers.authorization, 'Bearer video-key');
    if (request.method === 'POST') { await readJson(request); reply(response, { id: 'cgt-original_123' }); }
    else { polls += 1; reply(response, { id: 'cgt-original_123', status: polls === 1 ? 'running' : 'succeeded', content: { video_url: 'https://media.example/output.mp4?signature=signed' } }); }
  }, async url => {
    const connection = profile('ark-video', url);
    assert.deepEqual(await submitGeneration(connection, 'video-key', videoPlan, {}), { kind: 'remote', remoteTaskId: 'cgt-original_123' });
    assert.deepEqual(await pollGeneration(connection, 'video-key', 'cgt-original_123'), { status: 'running' });
    assert.deepEqual(await pollGeneration(connection, 'video-key', 'cgt-original_123'), { status: 'succeeded', outputUrl: 'https://media.example/output.mp4?signature=signed' });
  });
  assert.deepEqual(calls, ['POST /v1/contents/generations/tasks', 'GET /v1/contents/generations/tasks/cgt-original_123', 'GET /v1/contents/generations/tasks/cgt-original_123']);
});

test('successful Ark responses without a reliable ID remain submission_unknown and never retry', async () => {
  for (const body of ['not JSON', '{}', '{"id":""}', '{"id":"../private"}', '{"id":"secret-key"}', 'null']) {
    let posts = 0;
    await localServer((_request, response) => { posts += 1; response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(body); }, async url => {
      await assert.rejects(submitGeneration(profile('ark-video', url), 'secret-key', videoPlan, {}), error => {
        assert(error instanceof ProviderCallError); assert.equal(error.classification, 'submission_unknown');
        assert.doesNotMatch(error.message + JSON.stringify(error), /secret-key|private|not JSON/); return true;
      });
    });
    assert.equal(posts, 1);
  }
});

test('submission HTTP refusals and ambiguous errors are redacted, and redirects never receive credentials', async () => {
  for (const status of [400, 429, 307, 408, 500, 503]) {
    let requests = 0;
    await localServer((_request, response) => {
      requests += 1; response.writeHead(status, { Location: '/v1/credential-leak' }); response.end('secret-key private-prompt');
    }, async url => {
      await assert.rejects(submitGeneration(profile('ark-video', url), 'secret-key', videoPlan, {}), error => {
        assert(error instanceof ProviderCallError); assert.equal(error.httpStatus, status);
        assert.equal(error.classification, status === 408 || status >= 500 ? 'submission_unknown' : 'http_rejected');
        assert.doesNotMatch(error.message + JSON.stringify(error), /secret-key|private-prompt|credential-leak/); return true;
      });
    });
    assert.equal(requests, 1);
  }
});

test('timeout includes incomplete response bodies and connection loss after POST remains unknown', async () => {
  let posts = 0;
  await localServer((_request, response) => { posts += 1; response.writeHead(200, { 'Content-Type': 'application/json' }); response.write('{'); }, async url => {
    await assert.rejects(submitGeneration({ ...profile('ark-video', url), timeoutMs: 150 }, '', videoPlan, {}), { classification: 'submission_unknown' });
  });
  assert.equal(posts, 1);
  posts = 0;
  await localServer(async (request, response) => { posts += 1; await readJson(request); response.destroy(); }, async url => {
    await assert.rejects(submitGeneration(profile('ark-video', url), '', videoPlan, {}), { classification: 'submission_unknown' });
  });
  assert.equal(posts, 1);
});

test('connection diagnostics retain only known network codes and redact messages, URLs and unknown codes', () => {
  assert.match(describeConnectionFailure({ cause: { code: 'ECONNRESET', message: 'secret-key private-prompt' } }), /连接被重置.*ECONNRESET/);
  assert.match(describeConnectionFailure({ cause: { code: 'CERT_HAS_EXPIRED' } }), /TLS 证书已过期/);
  for (const error of [null, { message: 'secret-key' }, { code: 'private-prompt', cause: { code: 'secret-key' } }]) {
    assert.doesNotMatch(describeConnectionFailure(error), /secret-key|private-prompt/);
  }
});

test('poll failures retain query semantics and cannot trigger a new generation submission', async () => {
  for (const mode of ['disconnect', 'timeout', 'mismatch', 'unknown-status', 'http500'] as const) {
    const calls: string[] = [];
    await localServer((request, response) => {
      calls.push(request.method!);
      if (mode === 'disconnect') response.destroy();
      else if (mode === 'timeout') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.write('{'); }
      else if (mode === 'mismatch') reply(response, { id: 'other-task', status: 'running' });
      else if (mode === 'unknown-status') reply(response, { id: 'cgt-known', status: 'maybe-finished' });
      else reply(response, { error: { message: 'secret-key' } }, 500);
    }, async url => {
      await assert.rejects(pollGeneration({ ...profile('ark-video', url), timeoutMs: 150 }, 'secret-key', 'cgt-known'), error => {
        assert(error instanceof ProviderCallError); assert.notEqual(error.classification, 'submission_unknown');
        assert.doesNotMatch(error.message + JSON.stringify(error), /secret-key|other-task|maybe-finished/); return true;
      });
    });
    assert.deepEqual(calls, ['GET']);
  }
});

test('nonconditional Ark DELETE is never used to cancel because it can delete a completed result', async () => {
  const calls: string[] = [];
  let status = 'queued';
  await localServer((request, response) => {
    calls.push(request.method!);
    if (request.method === 'DELETE') reply(response, {});
    else reply(response, { id: 'cgt-cancel', status, content: { video_url: 'https://media.example/done.mp4' } });
  }, async url => {
    const connection = profile('ark-video', url);
    assert.deepEqual(await cancelGeneration(connection, '', 'cgt-cancel'), { acknowledged: false });
    assert.deepEqual(await pollGeneration(connection, '', 'cgt-cancel'), { status: 'queued' });
    status = 'running'; assert.deepEqual(await cancelGeneration(connection, '', 'cgt-cancel'), { acknowledged: false });
    status = 'succeeded'; assert.deepEqual(await cancelGeneration(connection, '', 'cgt-cancel'), { acknowledged: false });
    status = 'cancelled'; assert.deepEqual(await pollGeneration(connection, '', 'cgt-cancel'), { status: 'cancelled' });
  });
  assert.deepEqual(calls, ['GET', 'GET', 'GET', 'GET', 'GET']);
});

test('malformed images, oversized responses, unsafe output URLs and provider error text never enter results', async () => {
  for (const body of [{ data: [{ b64_json: 'not-base64' }] }, { data: [{ b64_json: Buffer.from('private text').toString('base64') }] }, { data: [{ url: 'https://unwanted.example/image.png' }] }]) {
    await localServer((_request, response) => reply(response, body), async url => {
      await assert.rejects(submitGeneration(profile('openai-images', url), '', imagePlan, {}), { classification: 'invalid_response' });
    });
  }
  await localServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': 100 * 1024 * 1024 }); response.write('{'); }, async url => {
    await assert.rejects(submitGeneration(profile('openai-images', url), '', imagePlan, {}), { classification: 'invalid_response', code: 'PROVIDER_RESPONSE_TOO_LARGE' });
  });
  await localServer((_request, response) => reply(response, { id: 'cgt-failed', status: 'failed', error: { code: 'secret-key', message: 'private prompt and secret-key' } }), async url => {
    assert.deepEqual(await pollGeneration(profile('ark-video', url), 'secret-key', 'cgt-failed'), { status: 'failed', errorCode: 'PROVIDER_GENERATION_FAILED' });
  });
  await localServer((_request, response) => reply(response, { id: 'cgt-result', status: 'succeeded', content: { video_url: 'https://user:secret@media.example/output.mp4' } }), async url => {
    await assert.rejects(pollGeneration(profile('ark-video', url), '', 'cgt-result'), { code: 'PROVIDER_INVALID_OUTPUT_URL' });
  });
});

test('aborted calls and invalid task IDs or oversized reference inputs are blocked before network activity', async () => {
  let calls = 0;
  await localServer((_request, response) => { calls += 1; reply(response, {}); }, async url => {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(submitGeneration(profile('ark-video', url), '', videoPlan, {}, { signal: controller.signal }), { classification: 'cancelled' });
    await assert.rejects(pollGeneration(profile('ark-video', url), '', '../private'), { code: 'INVALID_REMOTE_TASK_ID' });
    await assert.rejects(cancelGeneration(profile('openai-images', url), '', 'image-id'), { code: 'GENERATION_OPERATION_UNSUPPORTED' });
    const plan: GenerationPlan = { ...videoPlan, inputMode: 'first_frame', referenceArtifactIds: ['a'] };
    await assert.rejects(submitGeneration(profile('ark-video', url), '', plan, { a: 'data:image/png;base64,' + 'A'.repeat(33 * 1024 * 1024) }), { code: 'GENERATION_REQUEST_TOO_LARGE' });
  });
  assert.equal(calls, 0);
});
