import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { Store } from '../../../packages/storage/src/index.ts';
import { AppError, invariant } from '../../../packages/contracts/src/errors.ts';
import { projectInput, timelineInput, record, resourceId, text, integer } from '../../../packages/domain/src/validation.ts';
import { toolHealth } from '../../../packages/media/src/index.ts';
import { importAsset, resolveAsset, restoreAsset, sendAsset } from './assets.ts';
import { json, jsonBody } from './http.ts';
import { eventStream } from './events.ts';
import type { ServerConfig } from './config.ts';
import type { Scheduler } from './scheduler.ts';
import type { StoryboardStore } from '../../../packages/storage/src/storyboard.ts';
import type { ProviderRepository } from './provider-repository.ts';
import type { ModelRunner } from './model-runner.ts';
import { storyboardRoutes } from './storyboard-routes.ts';
import { providerRoutes } from './provider-routes.ts';
export interface RouteContext { store: Store; config: ServerConfig; scheduler: Scheduler; streams: Set<() => void>; board: StoryboardStore; providers: ProviderRepository; models: ModelRunner }
export async function apiRoutes(request: IncomingMessage, response: ServerResponse, url: URL, context: RouteContext): Promise<boolean> {
  const { store, config, scheduler } = context; const method = request.method, path = url.pathname;
  if (await storyboardRoutes(request, response, url, context) || await providerRoutes(request, response, url, context)) return true;
  if (path === '/api/projects' && method === 'GET') { json(response, store.listProjects()); return true; }
  if (path === '/api/projects' && method === 'POST') { json(response, store.createProject(projectInput(await jsonBody(request))), 201); return true; }
  const project = /^\/api\/projects\/([^/]+)$/.exec(path);
  if (project && method === 'GET') { json(response, store.snapshot(resourceId(project[1]))); return true; }
  if (project && method === 'PUT') { const b = record(await jsonBody(request)); json(response, store.updateProject(resourceId(project[1]), projectInput(b), integer(b.expectedRevision, '项目版本', 1, Number.MAX_SAFE_INTEGER))); return true; }
  const assets = /^\/api\/projects\/([^/]+)\/assets$/.exec(path);
  if (assets && method === 'POST') { json(response, await importAsset(store, request, resourceId(assets[1]), url.searchParams.get('name') || '', config.maxUploadBytes), 201); return true; }
  const content = /^\/api\/artifacts\/([^/]+)\/content$/.exec(path);
  if (content && ['GET', 'HEAD'].includes(method || '')) { await sendAsset(store, resourceId(content[1]), request, response); return true; }
  const restore = /^\/api\/artifacts\/([^/]+)\/restore$/.exec(path);
  if (restore && method === 'POST') { json(response, await restoreAsset(store, request, resourceId(restore[1]), config.maxUploadBytes)); return true; }
  const timelineRoute = /^\/api\/projects\/([^/]+)\/timeline$/.exec(path);
  if (timelineRoute && method === 'PUT') {
    const projectId = resourceId(timelineRoute[1]), input = timelineInput(await jsonBody(request));
    for (const clip of input.clips) {
      const { artifact } = await resolveAsset(store, clip.artifactId);
      invariant(artifact.projectId === projectId && artifact.kind !== 'audio', 'INVALID_ASSET', '镜头必须使用当前项目的画面素材');
      invariant(artifact.kind === 'image' ? clip.sourceInMs === 0 : clip.sourceInMs + clip.durationMs <= artifact.media.durationMs + 100, 'INVALID_RANGE', `素材「${artifact.name}」的使用区间超出源时长`);
    }
    const { expectedVersion, ...draft } = input; json(response, store.saveTimeline(projectId, draft, expectedVersion)); return true;
  }
  const exports = /^\/api\/projects\/([^/]+)\/exports$/.exec(path);
  if (exports && method === 'POST') {
    const projectId = resourceId(exports[1]), body = record(await jsonBody(request));
    const timeline = store.getTimeline(resourceId(body.timelineId));
    invariant(timeline.projectId === projectId, 'INVALID_TIMELINE', '时间线不属于当前项目');
    for (const clip of timeline.clips) await resolveAsset(store, clip.artifactId);
    const job = store.createJob({ projectId, type: 'export', payload: { timelineId: timeline.id }, dedupeKey: `export:${projectId}:${resourceId(body.clientRequestId)}` });
    scheduler.tick(); json(response, store.getJob(job.id), 202); return true;
  }
  const jobs = /^\/api\/projects\/([^/]+)\/jobs$/.exec(path);
  if (jobs && method === 'GET') { store.getProject(resourceId(jobs[1])); json(response, store.listJobs(jobs[1])); return true; }
  const job = /^\/api\/jobs\/([^/]+)$/.exec(path);
  if (job && method === 'GET') { json(response, store.getJob(resourceId(job[1]))); return true; }
  const cancel = /^\/api\/jobs\/([^/]+)\/cancel$/.exec(path);
  if (cancel && method === 'POST') { const job = store.getJob(resourceId(cancel[1])); json(response, job.type === 'reasoning' ? context.models.cancel(job.id) : scheduler.cancel(job.id)); return true; }
  if (path === '/api/events' && method === 'GET') {
    const after = integer(Number(request.headers['last-event-id'] || url.searchParams.get('after') || 0), '事件游标', 0, Number.MAX_SAFE_INTEGER);
    const stop = eventStream(store, resourceId(url.searchParams.get('projectId')), after, response); context.streams.add(stop); response.on('close', () => context.streams.delete(stop)); return true;
  }
  if (path === '/api/health' && method === 'GET') {
    const settings = store.getSettings(); const [ffmpeg, ffprobe] = await Promise.all([toolHealth(settings.ffmpegPath), toolHealth(settings.ffprobePath)]);
    json(response, { status: ffmpeg.available && ffprobe.available ? 'ok' : 'degraded', version: '0.1.0', schemaVersion: store.schemaVersion, ffmpeg, ffprobe, dataDir: config.dataDir, projectsDir: config.projectsDir }); return true;
  }
  if (path === '/api/settings' && method === 'GET') { json(response, store.getSettings()); return true; }
  if (path === '/api/settings' && method === 'PUT') {
    const body = record(await jsonBody(request));
    const ffmpegPath = text(body.ffmpegPath, 'FFmpeg 路径', 1000), ffprobePath = text(body.ffprobePath, 'ffprobe 路径', 1000);
    for (const p of [ffmpegPath, ffprobePath]) invariant(!p.includes('\0') && (isAbsolute(p) || ['ffmpeg', 'ffprobe'].includes(p)), 'INVALID_TOOL_PATH', '请填写绝对工具路径或默认命令名');
    store.updateSettings({ ffmpegPath, ffprobePath }); json(response, store.getSettings()); return true;
  }
  if (path === '/api/diagnostics' && method === 'GET') {
    json(response, { version: '0.1.0', schemaVersion: store.schemaVersion, projectCount: store.listProjects().length, at: new Date().toISOString(), traceId: randomUUID() }); return true;
  }
  if (path.startsWith('/api/')) throw new AppError('NOT_FOUND', '接口不存在', 404);
  return false;
}
