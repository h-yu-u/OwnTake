import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { startServer } from '../apps/server/src/app.ts';
import type { ApiError, Artifact, Project, Timeline } from '../packages/contracts/src/index.ts';
import type { BoardSnapshot, Candidate, ShotFields } from '../packages/contracts/src/storyboard.ts';

type App = Awaited<ReturnType<typeof startServer>>;
interface Fixture {
  app: App; root: string; project: Project; artifact: Artifact; headers: Record<string, string>;
  api: <T>(path: string, method?: string, body?: unknown, status?: number) => Promise<T>;
}

async function withFixture(run: (fixture: Fixture) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'owntake-thumbnail-board-'));
  let running: App | undefined;
  try {
    const source = join(root, '片段 with audio.mp4');
    const media = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=30:d=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source]);
    assert.equal(media.status, 0, media.stderr?.toString());
    const app = await startServer({ dataDir: join(root, 'data'), port: 0 }); running = app;
    const session = await fetch(app.url + '/api/session');
    const cookie = session.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie);
    const csrf = (await session.json() as { csrfToken: string }).csrfToken;
    const headers = { Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' };
    async function api<T>(path: string, method = 'GET', body?: unknown, status = 200): Promise<T> {
      const response = await fetch(app.url + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const data = await response.json(); assert.equal(response.status, status, JSON.stringify(data)); return data as T;
    }
    const project = await api<Project>('/api/projects', 'POST', { name: '缩略图与分镜验证', brief: '两个镜头与一条保留的音轨', ratio: '9:16' }, 201);
    const upload = await fetch(app.url + `/api/projects/${project.id}/assets?name=${encodeURIComponent('片段 with audio.mp4')}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(await readFile(source)) });
    const artifact = await upload.json() as Artifact; assert.equal(upload.status, 201, JSON.stringify(artifact));
    await run({ app, root, project, artifact, headers, api });
  } finally { if (running) await running.close(); await rm(root, { recursive: true, force: true }); }
}

test('thumbnail API authenticates, caches a real PNG, rejects cache symlinks and refuses work after stop', { timeout: 30000 }, async () => {
  await withFixture(async ({ app, root, project, artifact, headers }) => {
    const url = `${app.url}/api/artifacts/${artifact.id}/thumbnail`;
    assert.equal((await fetch(url)).status, 401);
    const responses = await Promise.all([fetch(url, { headers }), fetch(url, { headers })]);
    for (const response of responses) { assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/png'); }
    const [first, duplicate] = await Promise.all(responses.map(async response => Buffer.from(await response.arrayBuffer())));
    assert.deepEqual(first, duplicate);
    assert.deepEqual(first!.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.equal(first!.readUInt32BE(16), 160); assert.equal(first!.readUInt32BE(20), 90);
    const cached = await app.thumbnails.get(artifact.id);
    app.store.updateSettings({ ffmpegPath: join(root, 'ffmpeg-not-present') });
    const hit = await fetch(url, { headers }); assert.equal(hit.status, 200); assert.deepEqual(Buffer.from(await hit.arrayBuffer()), first);
    // A link to another project file is forbidden too: the PNG must remain in .cache.
    const outsideCache = join(app.store.getProjectDir(project.id), 'outside-cache.png'); await writeFile(outsideCache, first!);
    await rm(cached); await symlink(outsideCache, cached);
    const escapedFile = await fetch(url, { headers }); assert.equal(escapedFile.status, 403); assert.equal((await escapedFile.json() as ApiError).error.code, 'FORBIDDEN_PATH');
    await rm(dirname(cached), { recursive: true });
    const outsideDirectory = join(root, 'outside-cache'); await mkdir(outsideDirectory); await symlink(outsideDirectory, dirname(cached), 'dir');
    const escapedDirectory = await fetch(url, { headers }); assert.equal(escapedDirectory.status, 403); assert.equal((await escapedDirectory.json() as ApiError).error.code, 'FORBIDDEN_PATH');
    await app.thumbnails.stop();
    const stopped = await fetch(url, { headers }); assert.equal(stopped.status, 503); assert.equal((await stopped.json() as ApiError).error.code, 'SERVER_STOPPING');
  });
});

test('storyboard timeline aligns captions, preserves saved mix/output settings, and atomically rejects conflicts or overflows', { timeout: 30000 }, async () => {
  await withFixture(async ({ app, project, artifact, api }) => {
    let board = await api<BoardSnapshot>(`/api/projects/${project.id}/storyboard`);
    const input: ShotFields[] = [
      { title: '第一镜', purpose: '', description: '蓝色画面', action: '', durationMs: 1100, caption: '清晨的第一缕光', mode: 'import', referenceArtifactIds: [] },
      { title: '第二镜', purpose: '', description: '同一画面的延续', action: '', durationMs: 900, caption: '让故事继续', mode: 'import', referenceArtifactIds: [] },
    ];
    for (const fields of input) {
      board = await api<BoardSnapshot>(`/api/projects/${project.id}/shots`, 'POST', { fields, expectedBoardRevision: board.revision }, 201);
      const shot = board.shots.find(item => item.title === fields.title)!;
      const candidate = await api<Candidate>(`/api/shots/${shot.id}/candidates`, 'POST', { artifactId: artifact.id }, 201);
      board = await api<BoardSnapshot>(`/api/shots/${shot.id}/select`, 'POST', { candidateId: candidate.id, expectedShotRevision: shot.revision });
    }
    const initial = await api<Timeline>(`/api/projects/${project.id}/storyboard/timeline`, 'POST', { expectedVersion: 0 });
    assert.deepEqual([initial.width, initial.height, initial.fps], [720, 1280, 24]);
    assert.deepEqual(initial.captions.map(caption => [caption.startMs, caption.endMs, caption.text]), [[0, 1083, input[0]!.caption], [1083, 2000, input[1]!.caption]]);
    const audio = [{ artifactId: artifact.id, startMs: 500, sourceInMs: 0, durationMs: 1500, gainDb: -12, fadeInMs: 100, fadeOutMs: 100 }];
    const edited = await api<Timeline>(`/api/projects/${project.id}/timeline`, 'PUT', { expectedVersion: initial.version, width: 640, height: 360, fps: 30, clips: initial.clips, captions: [{ startMs: 0, endMs: 500, text: '将被镜头字幕替换' }], audio });
    const rebuilt = await api<Timeline>(`/api/projects/${project.id}/storyboard/timeline`, 'POST', { expectedVersion: edited.version });
    assert.deepEqual([rebuilt.width, rebuilt.height, rebuilt.fps], [640, 360, 30]);
    assert.deepEqual(rebuilt.audio, audio);
    assert.deepEqual(rebuilt.captions.map(caption => [caption.startMs, caption.endMs, caption.text]), [[0, 1100, input[0]!.caption], [1100, 2000, input[1]!.caption]]);
    const conflict = await api<ApiError>(`/api/projects/${project.id}/storyboard/timeline`, 'POST', { expectedVersion: edited.version }, 409); assert.equal(conflict.error.code, 'REVISION_CONFLICT');
    let firstShot = board.shots.find(shot => shot.title === input[0]!.title)!;
    board = await api<BoardSnapshot>(`/api/shots/${firstShot.id}`, 'PUT', { fields: { ...input[0], durationMs: 100 }, expectedShotRevision: firstShot.revision });
    const overflow = await api<ApiError>(`/api/projects/${project.id}/storyboard/timeline`, 'POST', { expectedVersion: rebuilt.version }, 400);
    assert.equal(overflow.error.code, 'INVALID_TIMELINE'); assert.match(overflow.error.message, /音轨/);
    assert.equal(app.store.getLatestTimeline(project.id)!.id, rebuilt.id, 'an invalid retained mix must not publish a new timeline');
    firstShot = board.shots.find(shot => shot.id === firstShot.id)!;
    const longCaption = '字'.repeat(2001);
    await api<BoardSnapshot>(`/api/shots/${firstShot.id}`, 'PUT', { fields: { ...input[0], caption: longCaption }, expectedShotRevision: firstShot.revision });
    const oversized = await api<ApiError>(`/api/projects/${project.id}/storyboard/timeline`, 'POST', { expectedVersion: rebuilt.version }, 409);
    assert.equal(oversized.error.code, 'STORYBOARD_CAPTION_TOO_LONG'); assert.match(oversized.error.message, /2000/);
    assert.equal(app.board.getShot(firstShot.id).caption, longCaption, 'the stored caption must not be truncated');
    assert.equal(app.store.getLatestTimeline(project.id)!.id, rebuilt.id);
  });
});
