import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../apps/server/src/app.ts';
import type { Project } from '../packages/contracts/src/index.ts';
import type { BoardSnapshot, Shot, ShotFields } from '../packages/contracts/src/storyboard.ts';
import type { CallRecord } from '../packages/contracts/src/calls.ts';
import type { GenerationRecord, ReviewRecord } from '../packages/contracts/src/generations.ts';
import type { GenerationPlan, PlanValidationResult, ProviderKind, ProviderSummary } from '../packages/contracts/src/providers.ts';
import { SCHEMA_VERSION } from '../packages/storage/src/index.ts';

type Application = Awaited<ReturnType<typeof startServer>>;
type RemoteTask = { status: 'running' | 'queued' | 'succeeded' | 'cancelled'; failDownloads: number; htmlDownloads: number; downloads: number; polls: number };
const fields: ShotFields = { title: '生成镜头', purpose: '建立环境', description: '日光中的城市', action: '缓慢移动', durationMs: 2000, caption: '', mode: 'generate_video', referenceArtifactIds: [] };
const imagePlan: GenerationPlan = { kind: 'image', inputMode: 'text', prompt: '清晰的蓝色天空', ratio: '16:9', referenceArtifactIds: [] };
const videoPlan: GenerationPlan = { kind: 'video', inputMode: 'text', prompt: '测试图案缓慢移动', ratio: '16:9', durationSec: 2, referenceArtifactIds: [] };
const key = 'private-generation-fixture-key';

function reply(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value));
}

async function bodyOf(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

async function harness(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'owntake-generation-api-'));
  let app: Application | undefined;
  let supplierOrigin = '';
  let png = Buffer.alloc(0), video = Buffer.alloc(0);
  const state = {
    imagePosts: 0, videoPosts: 0, reasoningPosts: 0, dropNextVideo: false, nextImageError: 0,
    imageQualities: [] as unknown[],
    nextVideoDownloadFailures: 0,
    nextVideoHtmlFailures: 0,
    tasks: new Map<string, RemoteTask>(),
    requests: [] as { method: string; path: string; authorization?: string }[],
    handlerErrors: [] as string[],
  };
  const supplier = createServer((request, response) => {
    const run = async (): Promise<void> => {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      state.requests.push({ method: request.method ?? '', path, authorization: request.headers.authorization });
      if (request.method === 'POST' && path === '/v1/images/generations') {
        const body = await bodyOf(request); state.imageQualities.push(body.quality); state.imagePosts += 1;
        if (state.nextImageError) {
          const status = state.nextImageError; state.nextImageError = 0;
          reply(response, { error: { code: 'insufficient_quota', message: 'private-generation-fixture-key and private prompt' } }, status); return;
        }
        reply(response, { data: [{ b64_json: png.toString('base64') }] }); return;
      }
      if (request.method === 'POST' && path === '/v1/chat/completions') {
        await bodyOf(request); state.reasoningPosts += 1;
        reply(response, { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ operations: [{ id: 'op_proposed', kind: 'add', fields }] }) } }] }); return;
      }
      if (request.method === 'POST' && path === '/v1/contents/generations/tasks') {
        await bodyOf(request); state.videoPosts += 1;
        const id = `cgt-fixture-${state.videoPosts}`;
        state.tasks.set(id, { status: 'running', failDownloads: state.nextVideoDownloadFailures, htmlDownloads: state.nextVideoHtmlFailures, downloads: 0, polls: 0 });
        state.nextVideoDownloadFailures = 0; state.nextVideoHtmlFailures = 0;
        if (state.dropNextVideo) { state.dropNextVideo = false; response.destroy(); return; }
        reply(response, { id }); return;
      }
      const query = /^\/v1\/contents\/generations\/tasks\/([A-Za-z0-9_-]+)$/.exec(path);
      if (query) {
        const id = query[1]!, task = state.tasks.get(id);
        if (!task) { reply(response, { error: { code: 'not_found' } }, 404); return; }
        if (request.method === 'GET') {
          task.polls += 1;
          reply(response, { id, status: task.status, ...(task.status === 'succeeded' ? { content: { video_url: `${supplierOrigin}/media/${id}.mp4` } } : {}) }); return;
        }
        if (request.method === 'DELETE') {
          if (task.status !== 'queued') { reply(response, { error: { code: 'not_queued' } }, 409); return; }
          task.status = 'cancelled'; reply(response, {}); return;
        }
      }
      const media = /^\/media\/([A-Za-z0-9_-]+)\.mp4$/.exec(path);
      if (request.method === 'GET' && media) {
        const task = state.tasks.get(media[1]!);
        if (!task) { reply(response, {}, 404); return; }
        task.downloads += 1;
        if (task.failDownloads > 0) {
          task.failDownloads -= 1;
          response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': video.length });
          response.write(video.subarray(0, Math.floor(video.length / 2)), () => response.destroy());
        } else if (task.htmlDownloads > 0) {
          task.htmlDownloads -= 1;
          response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<html><body>Temporary download error</body></html>');
        } else { response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': video.length }); response.end(video); }
        return;
      }
      reply(response, { error: 'unknown fixture route' }, 404);
    };
    void run().catch(error => {
      state.handlerErrors.push(error instanceof Error ? error.message : String(error));
      if (!response.headersSent) reply(response, { error: 'fixture failure' }, 500); else response.destroy();
    });
  });
  t.after(async () => {
    await app?.close();
    supplier.closeAllConnections();
    if (supplier.listening) await new Promise<void>(resolve => supplier.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
    assert.deepEqual(state.handlerErrors, []);
  });
  const imagePath = join(root, 'generated.png'), videoPath = join(root, 'generated.mp4');
  for (const args of [
    ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=1536x864', '-frames:v', '1', '-threads', '1', imagePath],
    ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', videoPath],
  ]) {
    const result = spawnSync('ffmpeg', args, { timeout: 15000 });
    assert.equal(result.status, 0, result.stderr?.toString());
  }
  png = await readFile(imagePath); video = await readFile(videoPath);
  await new Promise<void>(resolve => supplier.listen(0, '127.0.0.1', resolve));
  supplierOrigin = `http://127.0.0.1:${(supplier.address() as AddressInfo).port}`;
  const config = { dataDir: join(root, 'app'), port: 0 };
  app = await startServer(config);
  let cookie = '', csrf = '';
  async function login(): Promise<void> {
    const response = await fetch(app!.url + '/api/session');
    cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    csrf = (await response.json() as { csrfToken: string }).csrfToken;
  }
  await login();
  async function request<T>(path: string, method = 'GET', body?: unknown): Promise<{ status: number; value: T }> {
    const response = await fetch(app!.url + path, { method, headers: { Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, value: await response.json() as T };
  }
  async function api<T>(path: string, method = 'GET', body?: unknown, status = 200): Promise<T> {
    const result = await request<T>(path, method, body);
    assert.equal(result.status, status, `${method} ${path}: ${JSON.stringify(result.value)}`);
    return result.value;
  }
  async function restart(): Promise<void> { await app!.close(); app = await startServer(config); await login(); }
  async function createProject(): Promise<Project> { return api<Project>('/api/projects', 'POST', { name: '真实生成 API 测试', brief: '为本地短片生成图片和两秒视频', ratio: '16:9' }, 201); }
  async function createShot(projectId: string, mode: ShotFields['mode']): Promise<Shot> {
    const before = await api<BoardSnapshot>(`/api/projects/${projectId}/storyboard`);
    const next = await api<BoardSnapshot>(`/api/projects/${projectId}/shots`, 'POST', { fields: { ...fields, mode }, expectedBoardRevision: before.revision }, 201);
    return next.shots.find(shot => !before.shots.some(old => old.id === shot.id))!;
  }
  async function provider(kind: ProviderKind): Promise<ProviderSummary> {
    return api<ProviderSummary>('/api/providers', 'POST', { label: kind, kind, baseUrl: `${supplierOrigin}/v1`, model: 'contract-fixture', capabilities: { inputModes: ['text'], ratios: ['16:9'], durationsSec: kind === 'ark-video' ? [2] : [], maxReferences: 0 }, maxOutputTokens: 2048, timeoutMs: 1500, key }, 201);
  }
  async function generation(projectId: string, id: string): Promise<GenerationRecord> {
    const found = (await api<GenerationRecord[]>(`/api/projects/${projectId}/generations`)).find(item => item.id === id);
    assert(found, `missing generation ${id}`); return found;
  }
  async function until(projectId: string, id: string, predicate: (value: GenerationRecord) => boolean, fastPoll = false): Promise<GenerationRecord> {
    let latest: GenerationRecord | undefined;
    for (let i = 0; i < 500; i++) {
      latest = await generation(projectId, id);
      if (predicate(latest)) return latest;
      if (fastPoll && latest.status === 'waiting_remote' && !latest.pollingPaused) {
        const saved = app!.generations.get(id);
        if (saved.nextPollAt > Date.now()) { saved.nextPollAt = 0; app!.generations.save(saved); }
      }
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    assert.fail(`generation did not reach expected state: ${JSON.stringify(latest)}`);
  }
  function intent(shot: Shot, connection: ProviderSummary, plan: GenerationPlan, clientRequestId: string, amount = 0.5, projectLimit = 10) {
    return { providerId: connection.id, plan, expectedShotRevision: shot.revision, expectedProviderUpdatedAt: connection.updatedAt, clientRequestId, reservation: { currency: 'USD', amount, singleLimit: 1, projectLimit } };
  }
  return { get app() { return app!; }, state, api, request, restart, createProject, createShot, provider, generation, until, intent };
}

test('unbudgeted generation preserves unknown costs and deduplication without changing legacy budget checks', async t => {
  const h = await harness(t), project = await h.createProject(), first = await h.createShot(project.id, 'generate_image'), second = await h.createShot(project.id, 'import'), connection = await h.provider('openai-images');
  const legacy = await h.api<GenerationRecord>(`/api/shots/${first.id}/generations`, 'POST', h.intent(first, connection, imagePlan, 'manual-budget', 0.5, 0.5), 202);
  await h.until(project.id, legacy.id, record => record.status === 'succeeded');
  const { reservation: ignored, ...simple } = h.intent(second, connection, { ...imagePlan, imageQuality: 'low' }, 'without-local-budget');
  const incompatible = await h.request(`/api/shots/${second.id}/generations`, 'POST', { ...simple, plan: { ...imagePlan, ratio: '9:16' }, clientRequestId: 'bad-plan' });
  assert.equal(incompatible.status, 409); assert.equal(h.state.imagePosts, 1);
  const malformed = await h.request(`/api/shots/${second.id}/generations`, 'POST', { ...simple, reservation: null });
  assert.equal(malformed.status, 400);
  const accepted = await h.api<GenerationRecord>(`/api/shots/${second.id}/generations`, 'POST', simple, 202);
  const completed = await h.until(project.id, accepted.id, record => record.status === 'succeeded');
  assert.equal(completed.budgetMode, 'none'); assert.equal(completed.reservedAmount, 0); assert.equal(completed.actualAmount, null);
  assert.equal(h.app.generations.get(accepted.id).reservation, null);
  assert.equal(h.app.providers.exposure(project.id, 'USD'), 0.5);
  await h.restart();
  const same = await h.api<GenerationRecord>(`/api/shots/${second.id}/generations`, 'POST', simple, 202);
  assert.equal(same.id, accepted.id); assert.equal(same.budgetMode, 'none'); assert.equal(same.actualAmount, null); assert.equal(h.state.imagePosts, 2);
  const manualAgain = await h.request(`/api/shots/${second.id}/generations`, 'POST', h.intent(second, connection, imagePlan, 'manual-still-limited', 0.5, 0.5));
  assert.equal(manualAgain.status, 409); assert.equal(h.state.imagePosts, 2);
  assert.equal((await h.generation(project.id, legacy.id)).reservedAmount, 0.5);
});

test('generation diagnostics persist HTTP failures without leaking provider text, releasing reservations or replaying images', async t => {
  const h = await harness(t), project = await h.createProject(), shot = await h.createShot(project.id, 'generate_image'), connection = await h.provider('openai-images');
  for (const status of [503, 429]) {
    h.state.nextImageError = status;
    const request = h.intent(shot, connection, imagePlan, `image-http-${status}`);
    const accepted = await h.api<GenerationRecord>(`/api/shots/${shot.id}/generations`, 'POST', request, 202);
    const failed = await h.until(project.id, accepted.id, record => ['failed', 'submission_unknown'].includes(record.status));
    assert.equal(failed.status, status === 503 ? 'submission_unknown' : 'failed');
    assert.match(failed.error!.message, new RegExp(`HTTP ${status}`));
    if (status === 429) assert.match(failed.error!.message, /insufficient_quota/);
    assert.equal(failed.actualAmount, null); assert.equal(failed.reservedAmount, 0.5);
    assert.equal(h.app.store.getJob(failed.jobId).error?.message, failed.error!.message);
    assert.doesNotMatch(JSON.stringify(failed), /private-generation-fixture-key|private prompt/);
    const count = h.state.imagePosts;
    await h.restart();
    const same = await h.api<GenerationRecord>(`/api/shots/${shot.id}/generations`, 'POST', request, 202);
    assert.equal(same.id, failed.id); assert.deepEqual(same.error, failed.error); assert.equal(h.state.imagePosts, count);
  }
});

test('generation API publishes an image candidate and preserves a pending video across restart and visual revision changes', { timeout: 60000 }, async t => {
  const h = await harness(t), project = await h.createProject();
  assert.equal(h.app.store.schemaVersion, SCHEMA_VERSION);
  const imageShot = await h.createShot(project.id, 'generate_image'), imageProvider = await h.provider('openai-images');
  assert.equal(imageProvider.hasKey, true);
  const validation = await h.api<PlanValidationResult>(`/api/shots/${imageShot.id}/generations/validate`, 'POST', { providerId: imageProvider.id, plan: imagePlan });
  assert.equal(validation.status, 'valid');
  const imageRequest = h.intent(imageShot, imageProvider, { ...imagePlan, imageQuality: 'low' }, 'image-once');
  const accepted = await h.api<GenerationRecord>(`/api/shots/${imageShot.id}/generations`, 'POST', imageRequest, 202);
  const image = await h.until(project.id, accepted.id, record => ['succeeded', 'failed'].includes(record.status));
  assert.equal(image.status, 'succeeded', JSON.stringify(image.error));
  assert.equal(image.actualAmount, null);
  assert.equal(h.state.imagePosts, 1);
  assert.equal(h.state.imageQualities[0], 'low'); assert.equal(image.plan.imageQuality, 'low');
  const duplicate = await h.api<GenerationRecord>(`/api/shots/${imageShot.id}/generations`, 'POST', imageRequest, 202);
  assert.equal(duplicate.id, image.id);
  const imageBoard = await h.api<BoardSnapshot>(`/api/projects/${project.id}/storyboard`);
  const imageCandidate = imageBoard.candidates.find(item => item.id === image.candidateId)!;
  assert.equal(imageCandidate.artifactId, image.artifactId);
  assert.equal(imageBoard.shots.find(shot => shot.id === imageShot.id)?.selectedArtifactId, null);
  const artifact = h.app.store.getArtifact(image.artifactId!);
  assert.equal(artifact.kind, 'image'); assert.equal(artifact.source, 'generated');
  assert.equal(artifact.media.width, 1536); assert.equal(artifact.media.height, 864);
  const reviews = await h.api<ReviewRecord[]>(`/api/projects/${project.id}/reviews`);
  const technical = reviews.find(review => review.artifactId === artifact.id && review.kind === 'technical')!;
  assert(technical); assert.equal(technical.verdict, 'pass');
  assert.deepEqual(technical.checked, { technical: true, visual: false, motion: false, audio: false });
  const human = await h.api<ReviewRecord>(`/api/shots/${imageShot.id}/reviews`, 'POST', { candidateId: image.candidateId, verdict: 'pass', checked: { visual: true, motion: false, audio: false }, notes: '已人工查看完整静态图像' }, 201);
  assert.equal(human.kind, 'human'); assert.equal(human.checked.technical, false);

  const videoShot = await h.createShot(project.id, 'generate_video'), videoProvider = await h.provider('ark-video');
  const started = await h.api<GenerationRecord>(`/api/shots/${videoShot.id}/generations`, 'POST', h.intent(videoShot, videoProvider, videoPlan, 'video-restart'), 202);
  const pending = await h.until(project.id, started.id, record => record.status === 'waiting_remote' && record.remoteTaskId !== null);
  const remoteId = pending.remoteTaskId!;
  const paused = await h.api<GenerationRecord>(`/api/generations/${pending.id}/polling`, 'POST', { paused: true });
  assert.equal(paused.pollingPaused, true);
  await h.api<BoardSnapshot>(`/api/shots/${videoShot.id}`, 'PUT', { fields: { ...fields, description: '改为夜景，属于新的视觉要求' }, expectedShotRevision: videoShot.revision });
  await h.restart();
  assert.equal((await h.generation(project.id, image.id)).plan.imageQuality, 'low');
  assert.equal((await h.generation(project.id, pending.id)).remoteTaskId, remoteId);
  assert.equal((await h.generation(project.id, pending.id)).pollingPaused, true);
  h.state.tasks.get(remoteId)!.status = 'succeeded';
  await h.api(`/api/generations/${pending.id}/polling`, 'POST', { paused: false });
  const finished = await h.until(project.id, pending.id, record => ['succeeded', 'failed'].includes(record.status), true);
  assert.equal(finished.status, 'succeeded', JSON.stringify(finished.error));
  assert.equal(h.state.videoPosts, 1, 'restart must query the persisted remote ID without another POST');
  assert.equal(finished.actualAmount, null);
  const finalBoard = await h.api<BoardSnapshot>(`/api/projects/${project.id}/storyboard`);
  const late = finalBoard.candidates.find(candidate => candidate.id === finished.candidateId)!;
  assert.equal(late.visualRevision, 1);
  assert.equal(finalBoard.shots.find(shot => shot.id === videoShot.id)?.visualRevision, 2);
  assert.equal(finalBoard.shots.find(shot => shot.id === videoShot.id)?.selectedArtifactId, null);
  const videoReviews = await h.api<ReviewRecord[]>(`/api/projects/${project.id}/reviews`);
  const videoTechnical = videoReviews.find(review => review.artifactId === finished.artifactId && review.kind === 'technical')!;
  assert.equal(videoTechnical.checked.visual, false); assert.equal(videoTechnical.checked.motion, false); assert.equal(videoTechnical.checked.audio, false);
  await h.api(`/api/shots/${videoShot.id}/reviews`, 'POST', { candidateId: finished.candidateId, verdict: 'pass', checked: { visual: true, motion: false, audio: false }, notes: '未观看完整动作与声音' }, 400);
  const cancellationShot = await h.createShot(project.id, 'generate_video');
  const cancellation = await h.api<GenerationRecord>(`/api/shots/${cancellationShot.id}/generations`, 'POST', h.intent(cancellationShot, videoProvider, videoPlan, 'cancel-queued-remote'), 202);
  const waitingCancellation = await h.until(project.id, cancellation.id, record => record.status === 'waiting_remote' && record.remoteTaskId !== null);
  h.state.tasks.get(waitingCancellation.remoteTaskId!)!.status = 'queued';
  const requestedCancellation = await h.api<GenerationRecord>(`/api/generations/${cancellation.id}/cancel`, 'POST', {});
  assert.equal(requestedCancellation.cancelRequested, true);
  const stillQueued = await h.until(project.id, cancellation.id, record => record.cancelRequested && record.status === 'waiting_remote' && record.lastRemoteStatus === 'queued', true);
  assert.equal(stillQueued.actualAmount, null);
  assert.equal(h.state.tasks.get(waitingCancellation.remoteTaskId!)!.status, 'queued');
  assert.equal(h.state.requests.some(request => request.method === 'DELETE'), false, 'a non-conditional DELETE could remove a concurrently completed task');
  // Only the provider's subsequent reported state can establish a remote cancellation.
  h.state.tasks.get(waitingCancellation.remoteTaskId!)!.status = 'cancelled';
  const confirmedCancellation = await h.until(project.id, cancellation.id, record => record.status === 'cancelled', true);
  assert.equal(confirmedCancellation.lastRemoteStatus, 'cancelled');
  assert.equal(confirmedCancellation.actualAmount, null, 'remote cancellation is not proof of a zero charge');
  assert.equal(confirmedCancellation.candidateId, null);
  const serialized = JSON.stringify({ providers: await h.api('/api/providers'), generations: await h.api(`/api/projects/${project.id}/generations`) });
  assert.doesNotMatch(serialized, /private-generation-fixture-key|credentialRef|outputUrl|stagedRelativePath/);
  assert(h.state.requests.filter(request => request.path.startsWith('/v1/')).every(request => request.authorization === `Bearer ${key}`));
  assert(h.state.requests.filter(request => request.path.startsWith('/media/')).every(request => request.authorization === undefined));
});

test('accepted-but-disconnected video stays unknown after restart, then original-ID reconciliation and download retry never resubmit', { timeout: 60000 }, async t => {
  const h = await harness(t), project = await h.createProject();
  const shot = await h.createShot(project.id, 'generate_video'), connection = await h.provider('ark-video');
  h.state.dropNextVideo = true; h.state.nextVideoDownloadFailures = 1; h.state.nextVideoHtmlFailures = 1;
  const request = h.intent(shot, connection, videoPlan, 'lost-response');
  const accepted = await h.api<GenerationRecord>(`/api/shots/${shot.id}/generations`, 'POST', request, 202);
  const unknown = await h.until(project.id, accepted.id, record => record.status === 'submission_unknown');
  assert.equal(unknown.remoteTaskId, null); assert.equal(unknown.actualAmount, null); assert.equal(h.state.videoPosts, 1);
  await h.restart();
  const same = await h.api<GenerationRecord>(`/api/shots/${shot.id}/generations`, 'POST', request, 202);
  assert.equal(same.id, unknown.id); assert.equal(same.status, 'submission_unknown');
  await new Promise(resolve => setTimeout(resolve, 650));
  assert.equal(h.state.videoPosts, 1, 'unknown paid intent must not be retried on startup');
  const remoteId = [...h.state.tasks.keys()][0]!;
  h.state.tasks.get(remoteId)!.status = 'succeeded';
  await h.api(`/api/generations/${same.id}/reconcile`, 'POST', { remoteTaskId: remoteId, note: '已在供应商记录核对，关联本次原任务 ID' });
  const failedDownload = await h.until(project.id, same.id, record => record.status === 'download_failed', true);
  assert.equal(failedDownload.remoteTaskId, remoteId); assert.equal(failedDownload.artifactId, null); assert.equal(failedDownload.actualAmount, null);
  assert.equal(h.state.tasks.get(remoteId)!.downloads, 1);
  assert.equal((await h.api<BoardSnapshot>(`/api/projects/${project.id}/storyboard`)).candidates.length, 0);
  await h.api(`/api/generations/${same.id}/retry-download`, 'POST', {});
  const invalidMedia = await h.until(project.id, same.id, record => record.status === 'download_failed', true);
  assert.equal(h.state.tasks.get(remoteId)!.downloads, 2);
  assert.equal(invalidMedia.artifactId, null, 'HTTP 200 HTML must never be published as a video artifact');
  assert.equal((await h.api<BoardSnapshot>(`/api/projects/${project.id}/storyboard`)).candidates.length, 0);
  await h.api(`/api/generations/${same.id}/retry-download`, 'POST', {});
  const recovered = await h.until(project.id, same.id, record => ['succeeded', 'failed'].includes(record.status), true);
  assert.equal(recovered.status, 'succeeded', JSON.stringify(recovered.error));
  assert.equal(h.state.videoPosts, 1);
  assert.equal(h.state.tasks.get(remoteId)!.downloads, 3);
  assert(h.state.tasks.get(remoteId)!.polls >= 1);
  assert.equal(recovered.actualAmount, null);
  assert.equal((await h.api<BoardSnapshot>(`/api/projects/${project.id}/storyboard`)).candidates.length, 1);
  assert.equal(h.app.store.getArtifact(recovered.artifactId!).media.kind, 'video');
  const settled = await h.api<GenerationRecord>(`/api/generations/${same.id}/settle`, 'POST', { actualAmount: 0.35, currency: 'USD', note: '根据供应商测试账单人工核对金额' });
  assert.equal(settled.actualAmount, 0.35);
  assert.equal(h.app.providers.exposure(project.id, 'USD'), 0.35);
});

test('atomic project reservations include both reasoning and generation under simultaneous HTTP requests', { timeout: 60000 }, async t => {
  const h = await harness(t), project = await h.createProject();
  const shot = await h.createShot(project.id, 'generate_image');
  const reasoningProvider = await h.provider('chat-completions'), imageProvider = await h.provider('openai-images');
  const board = await h.api<BoardSnapshot>(`/api/projects/${project.id}/storyboard`);
  const reasoningRequest = { providerId: reasoningProvider.id, expectedProviderUpdatedAt: reasoningProvider.updatedAt, clientRequestId: 'reasoning-reservation', expectedBoardRevision: board.revision, expectedProjectRevision: project.revision, reservation: { currency: 'USD', amount: 0.6, singleLimit: 1, projectLimit: 1 } };
  const call = await h.api<CallRecord>(`/api/projects/${project.id}/reasoning`, 'POST', reasoningRequest, 202);
  const firstRequest = h.intent(shot, imageProvider, imagePlan, 'concurrent-image-a', 0.25, 1);
  const secondRequest = h.intent(shot, imageProvider, imagePlan, 'concurrent-image-b', 0.25, 1);
  const responses = await Promise.all([
    h.request<GenerationRecord>(`/api/shots/${shot.id}/generations`, 'POST', firstRequest),
    h.request<GenerationRecord>(`/api/shots/${shot.id}/generations`, 'POST', secondRequest),
  ]);
  assert.deepEqual(responses.map(result => result.status).sort(), [202, 409]);
  const accepted = responses.find(result => result.status === 202)!.value;
  const rejected = responses.find(result => result.status === 409)!.value as unknown as { error: { code: string } };
  assert.equal(rejected.error.code, 'BUDGET_EXCEEDED');
  const image = await h.until(project.id, accepted.id, record => ['succeeded', 'failed'].includes(record.status));
  assert.equal(image.status, 'succeeded', JSON.stringify(image.error));
  assert.equal(image.actualAmount, null);
  let calls: CallRecord[] = [];
  for (let i = 0; i < 200; i++) {
    calls = await h.api<CallRecord[]>(`/api/projects/${project.id}/calls`);
    if (!['queued', 'submitting'].includes(calls.find(item => item.id === call.id)!.status)) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(calls.find(item => item.id === call.id)?.status, 'succeeded');
  assert.equal(calls.find(item => item.id === call.id)?.actualAmount, null);
  assert.equal(h.state.reasoningPosts, 1); assert.equal(h.state.imagePosts, 1);
  assert.equal((await h.api<GenerationRecord[]>(`/api/projects/${project.id}/generations`)).length, 1);
  assert(Math.abs(h.app.providers.exposure(project.id, 'USD') - 0.85) < 1e-9);
  const blocked = await h.api<{ error: { code: string } }>(`/api/projects/${project.id}/reasoning`, 'POST', { ...reasoningRequest, clientRequestId: 'reasoning-over-generation-budget', reservation: { currency: 'USD', amount: 0.2, singleLimit: 1, projectLimit: 1 } }, 409);
  assert.equal(blocked.error.code, 'BUDGET_EXCEEDED');
  assert.equal((await h.api<CallRecord[]>(`/api/projects/${project.id}/calls`)).length, 1);
  assert.equal(h.state.imagePosts, 1); assert.equal(h.state.reasoningPosts, 1);
});
