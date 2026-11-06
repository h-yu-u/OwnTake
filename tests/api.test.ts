import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { startServer } from '../apps/server/src/app.ts';
import type { Job, Project, Timeline, Artifact } from '../packages/contracts/src/index.ts';

test('authenticated local API imports real media, renders frozen timeline, deduplicates and recovers project', { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'owntake-api-')), dataDir = join(root, 'data');
  const source = join(root, '镜头 with spaces.mp4');
  const fixture = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=24:d=0.5', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source]);
  assert.equal(fixture.status, 0, fixture.stderr?.toString());
  let app = await startServer({ dataDir, port: 0 });
  try {
    const unauthorized = await fetch(app.url + '/api/projects'); assert.equal(unauthorized.status, 401);
    const hostile = await fetch(app.url + '/api/session', { headers: { Origin: 'https://untrusted.invalid' } }); assert.equal(hostile.status, 403);
    async function session() { const r = await fetch(app.url + '/api/session'); return { cookie: r.headers.get('set-cookie')!.split(';')[0]!, token: (await r.json() as {csrfToken: string}).csrfToken }; }
    let auth = await session();
    async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
      const r = await fetch(app.url + path, { method, headers: { Cookie: auth.cookie, 'X-CSRF-Token': auth.token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const value = await r.json(); assert(r.ok, JSON.stringify(value)); return value as T;
    }
    const blocked = await fetch(app.url + '/api/projects', { method: 'POST', headers: { Cookie: auth.cookie, 'Content-Type': 'application/json' }, body: '{}' }); assert.equal(blocked.status, 403);
    const project = await api<Project>('/api/projects', 'POST', { name: '测试短片', brief: '真实导入到成片', ratio: '16:9' });
    const upload = async () => {
      const r = await fetch(app.url + `/api/projects/${project.id}/assets?name=${encodeURIComponent('同名镜头.mp4')}`, { method: 'POST', headers: { Cookie: auth.cookie, 'X-CSRF-Token': auth.token, 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(await readFile(source)) });
      const value = await r.json(); assert(r.ok, JSON.stringify(value)); return value as Artifact;
    };
    const first = await upload(), second = await upload(); assert.notEqual(first.id, second.id); assert.notEqual(first.relativePath, second.relativePath);
    const range = await fetch(app.url + `/api/artifacts/${first.id}/content`, { headers: { Cookie: auth.cookie, Range: 'bytes=0-15' } }); assert.equal(range.status, 206); assert.equal((await range.arrayBuffer()).byteLength, 16);
    await rm(join(app.store.getProjectDir(project.id), first.relativePath));
    const missing = await fetch(app.url + `/api/artifacts/${first.id}/content`, { headers: { Cookie: auth.cookie } }); assert.equal(missing.status, 409);
    const restoreHeaders = { Cookie: auth.cookie, 'X-CSRF-Token': auth.token, 'Content-Type': 'application/octet-stream' };
    const different = await fetch(app.url + `/api/artifacts/${first.id}/restore`, { method: 'POST', headers: restoreHeaders, body: new Uint8Array([1, 2, 3]) }); assert.equal(different.status, 422);
    const restored = await fetch(app.url + `/api/artifacts/${first.id}/restore`, { method: 'POST', headers: restoreHeaders, body: new Uint8Array(await readFile(source)) }); assert.equal(restored.status, 200);
    const draft = { expectedVersion: 0, width: 320, height: 180, fps: 24, clips: [first, second].map(a => ({ artifactId: a.id, sourceInMs: 0, durationMs: 500, fit: 'contain', muteSource: false })), captions: [], audio: [] };
    const timeline = await api<Timeline>(`/api/projects/${project.id}/timeline`, 'PUT', draft);
    const conflict = await fetch(app.url + `/api/projects/${project.id}/timeline`, { method: 'PUT', headers: { Cookie: auth.cookie, 'X-CSRF-Token': auth.token, 'Content-Type': 'application/json' }, body: JSON.stringify(draft) }); assert.equal(conflict.status, 409);
    const request = { timelineId: timeline.id, clientRequestId: 'export-test-1' };
    const job = await api<Job>(`/api/projects/${project.id}/exports`, 'POST', request), duplicate = await api<Job>(`/api/projects/${project.id}/exports`, 'POST', request); assert.equal(job.id, duplicate.id);
    let finished = job;
    for (let i = 0; i < 200 && !['succeeded', 'failed', 'cancelled'].includes(finished.status); i++) { await new Promise(r => setTimeout(r, 100)); finished = await api<Job>(`/api/jobs/${job.id}`); }
    assert.equal(finished.status, 'succeeded', JSON.stringify(finished.error));
    const output = app.store.getArtifact(String(finished.result!.artifactId)); assert.equal(output.media.width, 320); assert.equal(output.media.height, 180); assert(Math.abs(output.media.durationMs - 1000) < 200);
    const interrupted = app.store.createJob({ projectId: project.id, type: 'export', payload: { timelineId: timeline.id }, dedupeKey: 'persisted-crash-state' });
    app.store.updateJob(interrupted.id, { status: 'running', progress: 0.2 });
    await app.close(); app = await startServer({ dataDir, port: 0 }); auth = await session();
    assert.equal((await api<Project[]>('/api/projects')).length, 1);
    assert.equal((await api<Job>(`/api/jobs/${job.id}`)).status, 'succeeded');
    let recovered = await api<Job>(`/api/jobs/${interrupted.id}`);
    for (let i = 0; i < 200 && !['succeeded', 'failed'].includes(recovered.status); i++) { await new Promise(r => setTimeout(r, 100)); recovered = await api<Job>(`/api/jobs/${interrupted.id}`); }
    assert.equal(recovered.status, 'succeeded', JSON.stringify(recovered.error));
    assert.equal((await api<Job[]>(`/api/projects/${project.id}/jobs`)).length, 2);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
