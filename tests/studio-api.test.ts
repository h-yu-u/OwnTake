import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../apps/server/src/app.ts';
import type { Artifact, Project, Timeline } from '../packages/contracts/src/index.ts';
import type { BoardSnapshot, Candidate, Shot, ShotFields } from '../packages/contracts/src/storyboard.ts';
import type { ProviderKind, ProviderSummary } from '../packages/contracts/src/providers.ts';
import type { CallRecord } from '../packages/contracts/src/calls.ts';
import type { GenerationRecord } from '../packages/contracts/src/generations.ts';
import type { StudioCreateRequest, StudioOperation } from '../packages/contracts/src/studio.ts';
import type { SpeechInput, ReviewFrame } from '../packages/contracts/src/studio-provider.ts';
import { restoreBackup, SCHEMA_VERSION } from '../packages/storage/src/index.ts';

type Application = Awaited<ReturnType<typeof startServer>>;
const key = 'private-studio-fixture-key';
const fields: ShotFields = { title: '原始清晨镜头', purpose: '建立清晨氛围', description: '窗边暖光', action: '人物缓慢转身', durationMs: 2000, caption: '第一版字幕', mode: 'import', referenceArtifactIds: [] };
const speech: SpeechInput = { text: '新的一天，从窗边的晨光开始。', voice: 'fixture-voice', speed: 1, instructions: '自然平静地讲述。' };

function reply(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value));
}
async function bodyOf(request: IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function waitUntil<T>(get: () => Promise<T> | T, predicate: (value: T) => boolean): Promise<T> {
  let latest: T | undefined;
  for (let i = 0; i < 500; i += 1) {
    latest = await get(); if (predicate(latest)) return latest;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.fail(`Expected state was not reached: ${JSON.stringify(latest)}`);
}

async function harness(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'owntake-studio-api-'));
  let app: Application | undefined;
  let audio = Buffer.alloc(0), image = Buffer.alloc(0), video = Buffer.alloc(0);
  const state = {
    speechPosts: 0, reviewPosts: 0, reasoningPosts: 0, imagePosts: 0, dropNextSpeech: false, holdNextReview: false,
    reviewRequests: [] as Record<string, any>[], releaseReview: undefined as (() => void) | undefined,
    handlerErrors: [] as string[],
  };
  const supplier = createServer((request, response) => {
    const handle = async (): Promise<void> => {
      assert.equal(request.method, 'POST');
      assert.equal(request.headers.authorization, `Bearer ${key}`);
      const body = await bodyOf(request);
      if (request.url === '/v1/audio/speech') {
        state.speechPosts += 1; assert.equal(body.response_format, 'wav'); assert.equal(body.model, 'fixture-model');
        if (state.dropNextSpeech) { state.dropNextSpeech = false; response.destroy(); return; }
        response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': audio.length }); response.end(audio); return;
      }
      if (request.url === '/v1/images/generations') {
        state.imagePosts += 1; reply(response, { data: [{ b64_json: image.toString('base64') }] }); return;
      }
      if (request.url === '/v1/chat/completions') {
        if (body.response_format.json_schema.name === 'owntake_frame_review_v1') {
          state.reviewPosts += 1; state.reviewRequests.push(body);
          const finish = (): void => reply(response, { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ summary: '所给抽样帧未发现指定构图问题。', sampledVerdict: 'pass', issues: [], uncertainties: ['无法据此判断连续动作或声音。'] }) } }] });
          if (state.holdNextReview) { state.holdNextReview = false; state.releaseReview = finish; } else finish();
        } else {
          state.reasoningPosts += 1;
          reply(response, { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ operations: [{ id: 'proposed-shot', kind: 'add', fields }] }) } }] });
        }
        return;
      }
      throw new Error(`Unexpected fixture route: ${request.url}`);
    };
    void handle().catch(error => { state.handlerErrors.push(error instanceof Error ? error.message : String(error)); response.destroy(); });
  });
  t.after(async () => {
    await app?.close(); supplier.closeAllConnections();
    if (supplier.listening) await new Promise<void>(resolve => supplier.close(() => resolve()));
    await rm(root, { recursive: true, force: true }); assert.deepEqual(state.handlerErrors, []);
  });
  const audioPath = join(root, 'fixture.wav'), imagePath = join(root, 'fixture.png'), videoPath = join(root, 'fixture.mp4');
  for (const args of [
    ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2:sample_rate=24000', '-c:a', 'pcm_s16le', audioPath],
    ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=1536x864', '-frames:v', '1', '-threads', '1', imagePath],
    ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=2', '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', videoPath],
  ]) {
    const result = spawnSync('ffmpeg', args, { timeout: 15000 }); assert.equal(result.status, 0, result.stderr?.toString());
  }
  [audio, image, video] = await Promise.all([readFile(audioPath), readFile(imagePath), readFile(videoPath)]);
  await new Promise<void>(resolve => supplier.listen(0, '127.0.0.1', resolve));
  const supplierUrl = `http://127.0.0.1:${(supplier.address() as AddressInfo).port}/v1`;
  let config = { dataDir: join(root, 'app'), projectsDir: join(root, 'projects'), port: 0 };
  app = await startServer(config);
  let cookie = '', csrf = '';
  async function login(): Promise<void> {
    const response = await fetch(app!.url + '/api/session'); cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    csrf = (await response.json() as { csrfToken: string }).csrfToken;
  }
  await login();
  async function fetchApi(path: string, method = 'GET', body?: BodyInit, contentType = 'application/json'): Promise<Response> {
    return fetch(app!.url + path, { method, headers: { Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': contentType }, ...(body === undefined ? {} : { body }) });
  }
  async function request<T>(path: string, method = 'GET', body?: unknown): Promise<{ status: number; value: T }> {
    const response = await fetchApi(path, method, body === undefined ? undefined : JSON.stringify(body));
    return { status: response.status, value: await response.json() as T };
  }
  async function api<T>(path: string, method = 'GET', body?: unknown, status = 200): Promise<T> {
    const result = await request<T>(path, method, body); assert.equal(result.status, status, `${method} ${path}: ${JSON.stringify(result.value)}`); return result.value;
  }
  async function restart(): Promise<void> { await app!.close(); app = await startServer(config); await login(); }
  async function restore(backup: string): Promise<void> {
    await app!.close(); config = { dataDir: join(root, 'restored-data'), projectsDir: join(root, 'restored-projects'), port: 0 };
    await restoreBackup(backup, config); app = await startServer(config); await login();
  }
  async function createProject(): Promise<Project> { return api<Project>('/api/projects', 'POST', { name: 'P4 创作工具验证', brief: '制作两秒清晨短片，并检查抽样画面', ratio: '16:9' }, 201); }
  async function createShot(projectId: string, mode: ShotFields['mode'] = 'import'): Promise<Shot> {
    const before = await api<BoardSnapshot>(`/api/projects/${projectId}/storyboard`);
    const next = await api<BoardSnapshot>(`/api/projects/${projectId}/shots`, 'POST', { fields: { ...fields, mode }, expectedBoardRevision: before.revision }, 201);
    return next.shots.find(shot => !before.shots.some(old => old.id === shot.id))!;
  }
  async function provider(kind: ProviderKind, review = false): Promise<ProviderSummary> {
    return api<ProviderSummary>('/api/providers', 'POST', {
      label: kind, kind, baseUrl: supplierUrl, model: 'fixture-model',
      capabilities: { inputModes: ['text'], ratios: kind === 'openai-images' ? ['16:9'] : [], durationsSec: [], maxReferences: 0,
        ...(kind === 'openai-speech' ? { speech: { voices: ['fixture-voice'], supportsInstructions: true, minSpeed: 0.25, maxSpeed: 4, maxInputChars: 4096 } } : {}),
        ...(review ? { frameReview: { maxImages: 3 } } : {}),
      }, maxOutputTokens: 2048, timeoutMs: 5000, key,
    }, 201);
  }
  async function importVideo(projectId: string): Promise<Artifact> {
    const response = await fetchApi(`/api/projects/${projectId}/assets?name=fixture.mp4`, 'POST', new Uint8Array(video), 'application/octet-stream');
    const result = await response.json(); assert.equal(response.status, 201, JSON.stringify(result)); return result as Artifact;
  }
  function intent(connection: ProviderSummary, kind: StudioCreateRequest['kind'], input: StudioCreateRequest['input'], clientRequestId: string, amount = 0.3, limit = 10): StudioCreateRequest {
    return { kind, targetId: connection.id, expectedTargetUpdatedAt: connection.updatedAt, clientRequestId, reservation: { currency: 'USD', amount, singleLimit: 1, projectLimit: limit }, input };
  }
  async function operation(projectId: string, id: string): Promise<StudioOperation> {
    const value = (await api<StudioOperation[]>(`/api/projects/${projectId}/studio-operations`)).find(item => item.id === id); assert(value); return value;
  }
  async function terminal(projectId: string, id: string): Promise<StudioOperation> {
    return waitUntil(() => operation(projectId, id), value => !['queued', 'submitting', 'received'].includes(value.status));
  }
  return { root, audio, video, state, get app() { return app!; }, api, request, fetchApi, restart, restore, createProject, createShot, provider, importVideo, intent, operation, terminal };
}

test('studio API publishes one independent WAV and freezes a historical candidate review with persistent sampled-frame evidence', { timeout: 60000 }, async t => {
  const h = await harness(t), project = await h.createProject(), shot = await h.createShot(project.id), artifact = await h.importVideo(project.id);
  const candidate = await h.api<Candidate>(`/api/shots/${shot.id}/candidates`, 'POST', { artifactId: artifact.id }, 201);
  const timeline = await h.api<Timeline>(`/api/projects/${project.id}/timeline`, 'PUT', { width: 1280, height: 720, fps: 24, clips: [{ artifactId: artifact.id, sourceInMs: 0, durationMs: 2000, fit: 'contain', muteSource: false, shotId: shot.id }], captions: [{ startMs: 0, endMs: 2000, text: '原有字幕' }], audio: [], expectedVersion: 0 });
  const speechProvider = await h.provider('openai-speech'), speechIntent = h.intent(speechProvider, 'tts', speech, 'speech-once');
  const collection = `/api/projects/${project.id}/studio-operations`;
  const accepted = await h.api<StudioOperation>(collection, 'POST', speechIntent, 202);
  const duplicate = await h.api<StudioOperation>(collection, 'POST', speechIntent, 202);
  assert.equal(duplicate.id, accepted.id);
  const spoken = await h.terminal(project.id, accepted.id); assert.equal(spoken.status, 'succeeded', JSON.stringify(spoken.error));
  assert.equal(h.state.speechPosts, 1); assert.equal(spoken.actualAmount, null);
  const voice = h.app.store.getArtifact(spoken.artifactId!);
  assert.equal(voice.kind, 'audio'); assert.equal(voice.source, 'generated'); assert.equal(voice.media.hasAudio, true); assert.equal(voice.media.durationMs, 2000);
  assert.equal(voice.metadata.aiGenerated, true); assert.equal(voice.sha256, createHash('sha256').update(h.audio).digest('hex'));
  assert.deepEqual(await readFile(h.app.store.resolveArtifactPath(voice.id)), h.audio);
  assert.equal(h.app.studio.receipt(spoken.id), null, 'the receipt is removed only after the artifact transaction completes');
  assert.deepEqual(h.app.store.getLatestTimeline(project.id), timeline);
  const changedIntent = { ...speechIntent, input: { ...speech, text: '不同文本' } };
  const conflict = await h.api<{ error: { code: string } }>(collection, 'POST', changedIntent, 409); assert.equal(conflict.error.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(h.state.speechPosts, 1);

  const changed = await h.api<BoardSnapshot>(`/api/shots/${shot.id}`, 'PUT', { fields: { ...fields, description: '第二版夜间街道', action: '快速奔跑' }, expectedShotRevision: shot.revision });
  const versionTwo = changed.shots.find(item => item.id === shot.id)!;
  assert.equal(versionTwo.visualRevision, 2);
  const reviewer = await h.provider('chat-completions', true); h.state.holdNextReview = true;
  const reviewing = await h.api<StudioOperation>(collection, 'POST', h.intent(reviewer, 'frame_review', { candidateId: candidate.id }, 'historical-review'), 202);
  await waitUntil(() => h.state.reviewPosts, count => count === 1);
  assert.equal(reviewing.source.visualRevision, 1); assert.equal(reviewing.source.artifactId, artifact.id); assert.equal(reviewing.source.sha256, artifact.sha256);
  const sent = h.state.reviewRequests[0]!, parts = sent.messages[1].content as Array<Record<string, any>>;
  assert.deepEqual(JSON.parse(parts[0]!.text), { expected: { purpose: fields.purpose, description: fields.description, action: fields.action } }, 'old candidate review must use its recorded visual requirements');
  const frameMetadata = parts.filter(item => item.type === 'text').slice(1).map(item => JSON.parse(item.text).frame as ReviewFrame);
  assert.deepEqual(frameMetadata.map(frame => frame.requestedTimeMs), [0.1, 0.5, 0.9].map(r => Math.min(artifact.media.durationMs - 1, Math.floor(artifact.media.durationMs * r))));
  assert.equal(new Set(frameMetadata.map(frame => frame.sha256)).size, 3, 'animated source produces three distinct captured frames');
  for (const [index, frame] of frameMetadata.entries()) {
    const sentImage = parts.filter(part => part.type === 'image_url')[index]!.image_url;
    assert.equal(sentImage.detail, 'high');
    const encoded = Buffer.from(sentImage.url.split(',')[1]!, 'base64'); assert.equal(createHash('sha256').update(encoded).digest('hex'), frame.sha256);
    const response = await h.fetchApi(`/api/studio-operations/${reviewing.id}/frames/${frame.id}`);
    assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), encoded);
    assert.equal(encoded.readUInt32BE(16), frame.width); assert.equal(encoded.readUInt32BE(20), frame.height);
  }
  await h.api<BoardSnapshot>(`/api/shots/${shot.id}`, 'PUT', { fields: { ...fields, description: '第三版雨夜', action: '人物停下' }, expectedShotRevision: versionTwo.revision });
  h.state.releaseReview!();
  const reviewed = await h.terminal(project.id, reviewing.id); assert.equal(reviewed.status, 'succeeded', JSON.stringify(reviewed.error));
  assert.equal(reviewed.actualAmount, null); assert.equal(reviewed.source.visualRevision, 1);
  assert.equal(reviewed.review!.ruleVersion, 'sampled-visual-v1'); assert.equal(reviewed.review!.samplingVersion, 'fixed-three-v1');
  assert.deepEqual(reviewed.review!.coverage, { visual: 'sampled_frames', motion: 'not_checked', audio: 'not_checked' });
  assert.deepEqual(reviewed.review!.frames, frameMetadata);
  assert.equal(reviewed.review!.report.sampledVerdict, 'pass');
  const board = await h.api<BoardSnapshot>(`/api/projects/${project.id}/storyboard`);
  assert.equal(board.shots[0]!.visualRevision, 3); assert.equal(board.shots[0]!.selectedArtifactId, null); assert.equal(board.candidates.length, 1); assert.equal(board.drafts.length, 0);
  assert.deepEqual(h.app.store.getLatestTimeline(project.id), timeline);
  assert.equal(h.state.reviewPosts, 1);
  await h.restart();
  const restoredFrame = await h.fetchApi(`/api/studio-operations/${reviewing.id}/frames/${frameMetadata[0]!.id}`);
  assert.equal(createHash('sha256').update(Buffer.from(await restoredFrame.arrayBuffer())).digest('hex'), frameMetadata[0]!.sha256);
  assert.equal((await h.operation(project.id, reviewing.id)).status, 'succeeded'); assert.equal(h.state.reviewPosts, 1);
  const publicJson = JSON.stringify({ operations: await h.api(collection), profiles: await h.api('/api/providers') });
  assert(!publicJson.includes(key)); assert(!publicJson.includes('credentialRef')); assert(!publicJson.includes('frozen'));
  const unauthenticated = await fetch(h.app.url + `/api/studio-operations/${reviewing.id}/frames/${frameMetadata[0]!.id}`); assert.equal(unauthenticated.status, 401);
});

test('complete WAV receipts survive backup and restore while ambiguous speech submissions are never replayed', { timeout: 60000 }, async t => {
  const h = await harness(t), project = await h.createProject(), connection = await h.provider('openai-speech');
  const collection = `/api/projects/${project.id}/studio-operations`, unknownIntent = h.intent(connection, 'tts', speech, 'accepted-response-lost');
  h.state.dropNextSpeech = true;
  const uncertain = await h.api<StudioOperation>(collection, 'POST', unknownIntent, 202);
  assert.equal((await h.terminal(project.id, uncertain.id)).status, 'submission_unknown'); assert.equal(h.state.speechPosts, 1);
  await h.restart();
  const duplicate = await h.api<StudioOperation>(collection, 'POST', unknownIntent, 202);
  assert.equal(duplicate.id, uncertain.id); assert.equal(duplicate.status, 'submission_unknown');

  const settings = h.app.store.getSettings();
  await h.api('/api/settings', 'PUT', { ...settings, ffprobePath: join(h.root, 'missing-ffprobe') });
  const complete = await h.api<StudioOperation>(collection, 'POST', h.intent(connection, 'tts', speech, 'received-before-ingest'), 202);
  const blocked = await h.terminal(project.id, complete.id); assert.equal(blocked.status, 'ingest_failed', JSON.stringify(blocked.error));
  assert.equal(blocked.actualAmount, null); assert.equal(h.state.speechPosts, 2);
  assert.deepEqual(h.app.studio.receipt(complete.id)!.bytes, h.audio); assert.equal(h.app.studio.receipt(complete.id)!.mime, 'audio/wav');
  assert.equal(h.app.store.listArtifacts(project.id).length, 0, 'the backup must recover the receipt even without an Artifact row');
  await h.app.studioRunner.stop();
  await h.api('/api/settings', 'PUT', settings);
  const retry = await h.api<StudioOperation>(`/api/studio-operations/${complete.id}/retry-ingest`, 'POST', {});
  assert.equal(retry.status, 'received');
  const backup = join(h.root, 'receipt-backup'), manifest = await h.app.store.backupTo(backup);
  assert.equal(manifest.schemaVersion, SCHEMA_VERSION); assert.equal(manifest.artifacts.length, 0);
  await h.restore(backup);
  const recovered = await h.terminal(project.id, complete.id); assert.equal(recovered.status, 'succeeded', JSON.stringify(recovered.error));
  assert.equal(recovered.actualAmount, null); assert.deepEqual(await readFile(h.app.store.resolveArtifactPath(recovered.artifactId!)), h.audio);
  assert.equal(h.app.studio.receipt(complete.id), null); assert.equal(h.app.store.getLatestTimeline(project.id), null);
  assert.equal((await h.operation(project.id, uncertain.id)).status, 'submission_unknown');
  const repeatedUnknown = await h.api<StudioOperation>(collection, 'POST', unknownIntent, 202); assert.equal(repeatedUnknown.id, uncertain.id);
  await h.api(`/api/studio-operations/${uncertain.id}/retry-ingest`, 'POST', {}, 409);
  assert.equal(h.state.speechPosts, 2, 'recovery must consume the durable BLOB without another supplier POST, even when the restored vault has no key');
  const settled = await h.api<StudioOperation>(`/api/studio-operations/${uncertain.id}/settle`, 'POST', { actualAmount: 0.12, currency: 'USD', note: '人工核对原供应商记录' });
  assert.equal(settled.actualAmount, 0.12); assert.equal(settled.status, 'submission_unknown');
  assert.equal(h.app.providers.exposure(project.id, 'USD'), 0.42);
});

test('reasoning, generation and concurrent studio operations share one atomic project reservation ceiling', { timeout: 60000 }, async t => {
  const h = await harness(t), project = await h.createProject(), shot = await h.createShot(project.id, 'generate_image');
  const reasoning = await h.provider('chat-completions'), images = await h.provider('openai-images'), voice = await h.provider('openai-speech');
  const board = await h.api<BoardSnapshot>(`/api/projects/${project.id}/storyboard`);
  const reasoningIntent = { providerId: reasoning.id, expectedProviderUpdatedAt: reasoning.updatedAt, clientRequestId: 'reasoning-reservation', expectedBoardRevision: board.revision, expectedProjectRevision: project.revision, reservation: { currency: 'USD', amount: 0.4, singleLimit: 1, projectLimit: 1 } };
  const call = await h.api<CallRecord>(`/api/projects/${project.id}/reasoning`, 'POST', reasoningIntent, 202);
  const reasoned = await waitUntil(async () => (await h.api<CallRecord[]>(`/api/projects/${project.id}/calls`)).find(item => item.id === call.id)!, item => !['queued', 'submitting'].includes(item.status));
  assert.equal(reasoned.status, 'succeeded'); assert.equal(reasoned.actualAmount, null);
  const generationIntent = { providerId: images.id, expectedProviderUpdatedAt: images.updatedAt, clientRequestId: 'image-reservation', expectedShotRevision: shot.revision, plan: { kind: 'image', inputMode: 'text', prompt: '清晨蓝色天空', ratio: '16:9', referenceArtifactIds: [] }, reservation: { currency: 'USD', amount: 0.35, singleLimit: 1, projectLimit: 1 } };
  const generation = await h.api<GenerationRecord>(`/api/shots/${shot.id}/generations`, 'POST', generationIntent, 202);
  const generated = await waitUntil(async () => (await h.api<GenerationRecord[]>(`/api/projects/${project.id}/generations`)).find(item => item.id === generation.id)!, item => ['succeeded', 'failed', 'submission_unknown', 'download_failed'].includes(item.status));
  assert.equal(generated.status, 'succeeded', JSON.stringify(generated.error)); assert.equal(generated.actualAmount, null);
  const collection = `/api/projects/${project.id}/studio-operations`;
  const competing = await Promise.all([
    h.request<StudioOperation>(collection, 'POST', h.intent(voice, 'tts', speech, 'voice-a', 0.2, 1)),
    h.request<StudioOperation>(collection, 'POST', h.intent(voice, 'tts', speech, 'voice-b', 0.2, 1)),
  ]);
  assert.deepEqual(competing.map(result => result.status).sort(), [202, 409]);
  const accepted = competing.find(result => result.status === 202)!.value;
  assert.equal((await h.terminal(project.id, accepted.id)).status, 'succeeded');
  assert(Math.abs(h.app.providers.exposure(project.id, 'USD') - 0.95) < 0.0000001); assert.equal(h.state.speechPosts, 1); assert.equal(h.state.reasoningPosts, 1); assert.equal(h.state.imagePosts, 1);
  const reserve = { currency: 'USD', amount: 0.1, singleLimit: 1, projectLimit: 1 };
  for (const [path, input] of [
    [`/api/projects/${project.id}/reasoning`, { ...reasoningIntent, clientRequestId: 'reasoning-over-limit', reservation: reserve }],
    [`/api/shots/${shot.id}/generations`, { ...generationIntent, clientRequestId: 'image-over-limit', reservation: reserve }],
    [collection, h.intent(voice, 'tts', speech, 'studio-over-limit', 0.1, 1)],
  ] as const) {
    const rejected = await h.api<{ error: { code: string } }>(path, 'POST', input, 409); assert.equal(rejected.error.code, 'BUDGET_EXCEEDED');
  }
  assert.equal((await h.api<StudioOperation[]>(collection)).length, 1);
  assert.equal(h.app.board.getShot(shot.id).selectedArtifactId, null);
});
