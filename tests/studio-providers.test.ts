import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ProviderProfile } from '../packages/contracts/src/providers.ts';
import type { FrameReviewInput, FrameReviewResult, SpeechInput } from '../packages/contracts/src/studio-provider.ts';
import { ProviderCallError } from '../packages/providers/src/errors.ts';
import { validateProfile } from '../packages/providers/src/profiles.ts';
import { compileSpeechRequest, submitSpeech, validateSpeechInput } from '../packages/providers/src/speech.ts';
import { callFrameReview, compileFrameReviewRequest } from '../packages/providers/src/frame-review.ts';
import { MAX_SPEECH_BYTES, MAX_STUDIO_JSON_BYTES, MAX_STUDIO_REQUEST_BYTES } from '../packages/providers/src/studio-http.ts';

const timestamp = '2026-11-06T00:00:00.000Z';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6akAAAAASUVORK5CYII=', 'base64');
const pngUrl = `data:image/png;base64,${png.toString('base64')}`;
const pngHash = createHash('sha256').update(png).digest('hex');
const speech: SpeechInput = { text: '早晨，阳光照进房间。\n新的一天开始。', voice: 'configured-voice', speed: 1.1, instructions: '自然、平静地讲述。' };
const review: FrameReviewInput = {
  expected: { purpose: '建立清晨氛围', description: '窗边的人物与桌面', action: '缓慢转身' },
  frames: [
    { id: 'frame_first', requestedTimeMs: 200, sha256: pngHash, width: 1, height: 1, mime: 'image/png', dataUrl: pngUrl },
    { id: 'frame_last', requestedTimeMs: 1800, sha256: pngHash, width: 1, height: 1, mime: 'image/png', dataUrl: pngUrl },
  ],
};
const report: FrameReviewResult = {
  summary: '所给抽样帧需要人工复核。', sampledVerdict: 'needs_review',
  issues: [{ category: 'composition', severity: 'warning', frameIds: ['frame_last'], observation: '该证据帧未提供足够可见细节。' }],
  uncertainties: ['这些帧无法判断连续动作或声音。'],
};

function profile(kind: 'openai-speech' | 'chat-completions', baseUrl = 'https://configured.example/v1'): ProviderProfile {
  return {
    id: 'studio_provider', label: '用户声明连接', kind, baseUrl, model: 'user-chosen-model',
    capabilities: { inputModes: ['text'], ratios: [], durationsSec: [], maxReferences: 0,
      ...(kind === 'openai-speech' ? { speech: { voices: ['configured-voice', 'another-voice'], supportsInstructions: true, minSpeed: 0.25, maxSpeed: 4, maxInputChars: 4096 } } : { frameReview: { maxImages: 3 } }),
    },
    maxOutputTokens: 2048, timeoutMs: 1500, createdAt: timestamp, updatedAt: timestamp,
  };
}

function wav(streaming = false): Buffer {
  const samples = 2400, bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(streaming ? 0xffffffff : bytes.length - 8, 4); bytes.write('WAVE', 8);
  bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(streaming ? 0xffffffff : samples * 2, 40);
  for (let i = 0; i < samples; i += 1) bytes.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / 24000) * 12000), 44 + i * 2);
  return bytes;
}

async function localServer(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>, run: (url: string) => Promise<void>): Promise<void> {
  let fixtureError: unknown;
  const server = createServer((request, response) => { void Promise.resolve().then(() => handler(request, response)).catch(error => { fixtureError = error; response.destroy(); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
    if (fixtureError) throw fixtureError;
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

async function readJson(request: IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function reply(response: ServerResponse, result: unknown, status = 200): void {
  response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(result));
}
function completion(content: unknown = report): Record<string, unknown> {
  return { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(content) } }] };
}
function safeFailure(classification: string, code?: string): (error: unknown) => boolean {
  return error => {
    assert(error instanceof ProviderCallError); assert.equal(error.classification, classification);
    if (code) assert.equal(error.code, code);
    assert.doesNotMatch(error.message + JSON.stringify(error), /private-key|private-prompt|credential-leak/);
    return true;
  };
}

test('optional studio capabilities preserve legacy profiles and reject ambiguous capability declarations', () => {
  const legacy = profile('chat-completions'); delete legacy.capabilities.frameReview;
  assert.deepEqual(validateProfile(legacy), legacy);
  assert.deepEqual(validateProfile(profile('openai-speech')), profile('openai-speech'));
  const base = profile('openai-speech'), capabilities = base.capabilities.speech!;
  for (const patch of [
    { voices: [] }, { voices: ['v', 'v'] }, { voices: [' v ', 'v'] }, { voices: ['a\nvoice'] },
    { supportsInstructions: 'yes' }, { minSpeed: 0.24 }, { maxSpeed: 4.01 }, { minSpeed: 2, maxSpeed: 1 },
    { maxInputChars: 4097 }, { maxInputChars: 0 }, { extra: true },
  ]) assert.throws(() => validateProfile({ ...base, capabilities: { ...base.capabilities, speech: { ...capabilities, ...patch } } }), { code: 'INVALID_PROVIDER' });
  for (const maxImages of [0, 17, 1.5, '3']) assert.throws(() => validateProfile({ ...legacy, capabilities: { ...legacy.capabilities, frameReview: { maxImages } } }), { code: 'INVALID_PROVIDER' });
  assert.throws(() => validateProfile({ ...base, kind: 'chat-completions' }), { code: 'INVALID_PROVIDER' });
  assert.throws(() => validateProfile({ ...profile('chat-completions'), kind: 'openai-speech' }), { code: 'INVALID_PROVIDER' });
});

test('speech preflight keeps the configured model and explicitly enforces voices, text and instructions', async () => {
  const connection = profile('openai-speech');
  assert.deepEqual(compileSpeechRequest(connection, speech), { endpoint: '/audio/speech', body: { model: 'user-chosen-model', input: speech.text, voice: speech.voice, response_format: 'wav', speed: 1.1, instructions: speech.instructions } });
  assert.equal(Object.hasOwn(compileSpeechRequest(connection, { ...speech, instructions: null }).body, 'instructions'), false);
  assert.equal(validateSpeechInput(connection, { ...speech, instructions: '  ' }).instructions, null);
  assert.equal(validateSpeechInput(connection, { ...speech, text: '字'.repeat(4096), instructions: '字'.repeat(4096) }).text.length, 4096);
  let requests = 0;
  await localServer((_request, response) => { requests += 1; response.end(wav()); }, async url => {
    const configured = profile('openai-speech', url);
    for (const patch of [{ text: '' }, { text: 'x'.repeat(4097) }, { text: 'a\0b' }, { voice: 'undeclared' }, { speed: 0.1 }, { speed: Infinity }, { instructions: 'x'.repeat(4097) }, { instructions: undefined }, { command: 'private-prompt' }]) {
      await assert.rejects(submitSpeech(configured, '', { ...speech, ...patch } as SpeechInput));
    }
    await assert.rejects(submitSpeech({ ...configured, capabilities: { ...configured.capabilities, speech: undefined } }, '', speech), { code: 'PROVIDER_CAPABILITY_UNSUPPORTED' });
    await assert.rejects(submitSpeech({ ...configured, capabilities: { ...configured.capabilities, speech: { ...configured.capabilities.speech!, supportsInstructions: false } } }, '', speech), { code: 'PROVIDER_CAPABILITY_UNSUPPORTED' });
    await assert.rejects(submitSpeech(configured, 'bad\nkey', speech), { code: 'INVALID_PROVIDER_KEY' });
  });
  assert.equal(requests, 0);
});

test('speech performs one POST and returns WAV bytes with either bounded or streaming RIFF lengths', async () => {
  for (const streaming of [false, true]) {
    const audio = wav(streaming); let requests = 0;
    await localServer(async (request, response) => {
      requests += 1;
      assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/audio/speech'); assert.equal(request.headers.authorization, 'Bearer private-key');
      assert.deepEqual(await readJson(request), { model: 'user-chosen-model', input: speech.text, voice: speech.voice, response_format: 'wav', speed: 1.1, instructions: speech.instructions });
      response.writeHead(200, { 'Content-Type': 'application/octet-stream' }); response.write(audio.subarray(0, 44)); response.end(audio.subarray(44));
    }, async url => {
      const result = await submitSpeech(profile('openai-speech', url), 'private-key', speech);
      assert.equal(result.mime, 'audio/wav'); assert.deepEqual(Buffer.from(result.bytes), audio);
    });
    assert.equal(requests, 1);
  }
});

test('speech rejects HTML, JSON, other media and truncated WAV without retrying', async () => {
  const invalid = [Buffer.from('<html>private-key private-prompt</html>'), Buffer.from('{"error":"private-key"}'), png, wav().subarray(0, 80), Buffer.from('RIFF0000WAVEprivate-key')];
  let requests = 0;
  await localServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'audio/wav' }); response.end(invalid[requests++]); }, async url => {
    for (const _ of invalid) await assert.rejects(submitSpeech(profile('openai-speech', url), 'private-key', speech), safeFailure('invalid_response', 'PROVIDER_INVALID_AUDIO'));
  });
  assert.equal(requests, invalid.length);
});

test('speech responses enforce the 32 MiB bound for both declared and actual streamed bytes', async () => {
  for (const declared of [true, false]) {
    let requests = 0;
    await localServer((_request, response) => {
      requests += 1;
      response.writeHead(200, { 'Content-Type': 'audio/wav', ...(declared ? { 'Content-Length': String(MAX_SPEECH_BYTES + 1) } : { 'Transfer-Encoding': 'chunked' }) });
      if (declared) response.write('RIFF'); else response.end(Buffer.alloc(MAX_SPEECH_BYTES + 1));
    }, async url => {
      await assert.rejects(submitSpeech({ ...profile('openai-speech', url), timeoutMs: 5000 }, '', speech), safeFailure('invalid_response', 'PROVIDER_RESPONSE_TOO_LARGE'));
    });
    assert.equal(requests, 1);
  }
});

test('studio HTTP refusal, ambiguity and redirects retain safe classifications and never follow a second URL', async () => {
  for (const status of [400, 429, 307, 408, 500, 503]) {
    let requests = 0;
    await localServer((_request, response) => {
      requests += 1; response.writeHead(status, { Location: '/v1/credential-leak' }); response.end('private-key private-prompt');
    }, async url => {
      await assert.rejects(submitSpeech(profile('openai-speech', url), 'private-key', speech), error => {
        safeFailure(status >= 500 || status === 408 ? 'submission_unknown' : 'http_rejected')(error);
        assert(error instanceof ProviderCallError); assert.equal(error.httpStatus, status); return true;
      });
    });
    assert.equal(requests, 1);
  }
});

test('speech and review deadlines include the body and interrupted accepted submissions remain unknown', async () => {
  for (const kind of ['openai-speech', 'chat-completions'] as const) {
    for (const failure of ['slow-body', 'disconnected'] as const) {
      let requests = 0;
      await localServer(async (request, response) => {
        requests += 1; await readJson(request);
        if (failure === 'disconnected') response.destroy();
        else { response.writeHead(200); response.write(kind === 'openai-speech' ? wav().subarray(0, 44) : '{'); }
      }, async url => {
        const connection = { ...profile(kind, url), timeoutMs: 200 };
        const operation = kind === 'openai-speech' ? submitSpeech(connection, 'private-key', speech) : callFrameReview(connection, 'private-key', review);
        await assert.rejects(operation, safeFailure('submission_unknown'));
      });
      assert.equal(requests, 1);
    }
  }
});

test('abort before dispatch sends nothing while abort after acceptance never claims a refunded cancellation', async () => {
  let requests = 0;
  await localServer((_request, response) => { requests += 1; response.end(wav()); }, async url => {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(submitSpeech(profile('openai-speech', url), '', speech, { signal: controller.signal }), safeFailure('cancelled'));
    await assert.rejects(callFrameReview(profile('chat-completions', url), '', { ...review, signal: controller.signal }), safeFailure('cancelled'));
  });
  assert.equal(requests, 0);
  for (const kind of ['openai-speech', 'chat-completions'] as const) {
    requests = 0; const controller = new AbortController();
    await localServer(async (request, response) => {
      requests += 1; await readJson(request); response.writeHead(200); response.write('partial'); controller.abort();
    }, async url => {
      const operation = kind === 'openai-speech' ? submitSpeech(profile(kind, url), '', speech, { signal: controller.signal }) : callFrameReview(profile(kind, url), '', { ...review, signal: controller.signal });
      await assert.rejects(operation, safeFailure('submission_unknown'));
    });
    assert.equal(requests, 1);
  }
});

test('review binds each PNG, SHA, dimensions and ordered label to a strict JSON Schema request', async () => {
  let requests = 0;
  const original = JSON.stringify(review);
  await localServer(async (request, response) => {
    requests += 1; assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/chat/completions');
    assert.equal(request.headers.authorization, 'Bearer private-key');
    const body = await readJson(request);
    assert.equal(body.model, 'user-chosen-model'); assert.equal(body.n, 1); assert.equal(body.stream, false); assert.equal(body.store, false); assert.equal(body.tool_choice, 'none'); assert.equal(body.tools, undefined);
    const schema = body.response_format.json_schema;
    assert.equal(schema.strict, true); assert.equal(schema.schema.additionalProperties, false);
    assert.deepEqual(schema.schema.required, ['summary', 'sampledVerdict', 'issues', 'uncertainties']);
    assert.deepEqual(schema.schema.properties.issues.items.properties.frameIds.items.enum, ['frame_first', 'frame_last']);
    assert.equal(schema.schema.properties.issues.items.additionalProperties, false);
    const content = body.messages[1].content;
    assert.deepEqual(JSON.parse(content[0].text), { expected: review.expected });
    for (let index = 0; index < review.frames.length; index += 1) {
      const { dataUrl, ...frame } = review.frames[index]!;
      assert.deepEqual(JSON.parse(content[1 + index * 2].text), { frame });
      assert.deepEqual(content[2 + index * 2], { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } });
    }
    reply(response, completion());
  }, async url => {
    assert.deepEqual(await callFrameReview(profile('chat-completions', url), 'private-key', review), report);
  });
  assert.equal(requests, 1); assert.equal(JSON.stringify(review), original);
});

test('review rejects unbound or oversized evidence before sending any request', async () => {
  let requests = 0;
  const frame = review.frames[0]!;
  const invalid: FrameReviewInput[] = [
    { ...review, frames: [] }, { ...review, frames: [{ ...frame, sha256: '0'.repeat(64) }] },
    { ...review, frames: [{ ...frame, width: 2 }] }, { ...review, frames: [{ ...frame, width: 5000 }] },
    { ...review, frames: [{ ...frame, requestedTimeMs: -1 }] }, { ...review, frames: [{ ...frame, requestedTimeMs: 1.5 }] },
    { ...review, frames: [{ ...frame, dataUrl: 'https://private.example/frame.png' }] },
    { ...review, frames: [{ ...frame, dataUrl: pngUrl.replace(';base64,', ';base64,\n') }] },
    { ...review, frames: [frame, frame] },
    { ...review, frames: [{ ...frame, command: 'private-prompt' } as any] },
    { ...review, expected: { ...review.expected, command: 'private-prompt' } as any },
    { ...review, frames: [{ ...frame, dataUrl: 'data:image/png;base64,' + 'A'.repeat(MAX_STUDIO_REQUEST_BYTES) }] },
  ];
  await localServer((_request, response) => { requests += 1; reply(response, completion()); }, async url => {
    for (const input of invalid) await assert.rejects(callFrameReview(profile('chat-completions', url), '', input));
    const undeclared = profile('chat-completions', url); delete undeclared.capabilities.frameReview;
    await assert.rejects(callFrameReview(undeclared, '', review), { code: 'PROVIDER_CAPABILITY_UNSUPPORTED' });
    await assert.rejects(callFrameReview({ ...profile('chat-completions', url), capabilities: { ...undeclared.capabilities, frameReview: { maxImages: 1 } } }, '', review), { code: 'INVALID_FRAME_REVIEW_INPUT' });
  });
  assert.equal(requests, 0);
});

test('review refuses animation chunks and appended data even when their SHA is updated', () => {
  const animated = Buffer.concat([png.subarray(0, 33), Buffer.from([0, 0, 0, 0, 97, 99, 84, 76, 0, 0, 0, 0]), png.subarray(33)]);
  for (const bytes of [animated, Buffer.concat([png, Buffer.from('private-prompt')])]) {
    const frame = { ...review.frames[0]!, sha256: createHash('sha256').update(bytes).digest('hex'), dataUrl: `data:image/png;base64,${bytes.toString('base64')}` };
    assert.throws(() => compileFrameReviewRequest(profile('chat-completions'), { ...review, frames: [frame] }), { code: 'INVALID_FRAME_REVIEW_INPUT' });
  }
});

test('model review output cannot inject commands, coverage, extra fields or fabricated evidence', async () => {
  const issue = report.issues[0]!;
  const invalid: unknown[] = [
    { ...report, operations: [{ command: 'private-prompt' }] }, { ...report, checked: { audio: true, motion: true } },
    { ...report, sampledVerdict: 'approved_forever' }, { ...report, summary: '' },
    { ...report, issues: [{ ...issue, frameIds: ['invented_frame'] }] },
    { ...report, issues: [{ ...issue, frameIds: ['frame_first', 'frame_first'] }] },
    { ...report, issues: [{ ...issue, frameIds: [] }] },
    { ...report, issues: [{ ...issue, category: 'audio' }] },
    { ...report, issues: [{ ...issue, command: 'private-prompt' }] },
    { ...report, issues: Array.from({ length: 33 }, () => issue) },
    { ...report, uncertainties: Array.from({ length: 17 }, () => 'uncertain') },
    { ...report, summary: 'private-key' },
    { summary: report.summary, sampledVerdict: report.sampledVerdict, issues: [] },
  ];
  let requests = 0;
  await localServer((_request, response) => reply(response, completion(invalid[requests++])), async url => {
    for (const _ of invalid) await assert.rejects(callFrameReview(profile('chat-completions', url), 'private-key', review), safeFailure('invalid_response', 'PROVIDER_INVALID_REVIEW'));
  });
  assert.equal(requests, invalid.length);
});

test('refusals, incomplete outputs and tool calls never become a review or trigger a repair POST', async () => {
  const message = { role: 'assistant', content: JSON.stringify(report) };
  const variants = [
    { choices: [] }, { choices: [{ finish_reason: 'stop', message }, { finish_reason: 'stop', message }] },
    { choices: [{ finish_reason: 'length', message }] }, { choices: [{ finish_reason: 'content_filter', message }] },
    { choices: [{ finish_reason: 'stop', message: { ...message, refusal: 'private-key private-prompt' } }] },
    { choices: [{ finish_reason: 'stop', message: { ...message, tool_calls: [{ function: { name: 'private-prompt' } }] } }] },
    { choices: [{ finish_reason: 'stop', message: { ...message, function_call: { name: 'private-prompt' } } }] },
    { choices: [{ finish_reason: 'stop', message: { ...message, role: 'tool' } }] },
    { choices: [{ finish_reason: 'stop', message: { ...message, content: '{private-prompt' } }] },
  ];
  let requests = 0;
  await localServer((_request, response) => reply(response, variants[requests++]), async url => {
    for (const _ of variants) await assert.rejects(callFrameReview(profile('chat-completions', url), 'private-key', review), safeFailure('invalid_response'));
  });
  assert.equal(requests, variants.length);
});

test('review bounds JSON responses and rejects malformed UTF-8 without leaking supplier bodies', async () => {
  for (const mode of ['declared-limit', 'streamed-limit', 'invalid-json', 'invalid-utf8'] as const) {
    let requests = 0;
    await localServer((_request, response) => {
      requests += 1;
      if (mode === 'declared-limit') { response.writeHead(200, { 'Content-Length': String(MAX_STUDIO_JSON_BYTES + 1) }); response.write('{'); }
      else if (mode === 'streamed-limit') { response.writeHead(200, { 'Transfer-Encoding': 'chunked' }); response.end('x'.repeat(MAX_STUDIO_JSON_BYTES + 1)); }
      else if (mode === 'invalid-json') response.end('<html>private-key private-prompt</html>');
      else response.end(Buffer.from([0xc3, 0x28]));
    }, async url => {
      await assert.rejects(callFrameReview(profile('chat-completions', url), 'private-key', review), safeFailure('invalid_response', mode.endsWith('limit') ? 'PROVIDER_RESPONSE_TOO_LARGE' : 'PROVIDER_INVALID_JSON'));
    });
    assert.equal(requests, 1);
  }
});
