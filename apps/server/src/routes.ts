import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { Store } from '../../../packages/storage/src/index.ts';
import { AppError, invariant } from '../../../packages/contracts/src/errors.ts';
import { projectInput, timelineInput, record, resourceId, text, integer } from '../../../packages/domain/src/validation.ts';
import { toolHealth, fontHealth } from '../../../packages/media/src/index.ts';
import { hashFile, importAsset, resolveAsset, restoreAsset, sendAsset } from './assets.ts';
import { json, jsonBody } from './http.ts';
import { eventStream } from './events.ts';
import type { ServerConfig } from './config.ts';
import type { Scheduler } from './scheduler.ts';
import type { StoryboardStore } from '../../../packages/storage/src/storyboard.ts';
import type { ProviderRepository } from './provider-repository.ts';
import type { ModelRunner } from './model-runner.ts';
import { storyboardRoutes } from './storyboard-routes.ts';
import { providerRoutes } from './provider-routes.ts';
import type { GenerationRepository } from './generation-repository.ts';
import type { GenerationRunner } from './generation-runner.ts';
import { generationRoutes } from './generation-routes.ts';
import type { ThumbnailService } from './thumbnails.ts';
import type { RuntimeRepository } from './runtime-repository.ts';
import type { StudioRepository } from './studio-repository.ts';
import type { StudioRunner } from './studio-runner.ts';
import { studioRoutes } from './studio-routes.ts';
export interface RouteContext { store: Store; config: ServerConfig; scheduler: Scheduler; streams: Set<() => void>; board: StoryboardStore; providers: ProviderRepository; models: ModelRunner; generations: GenerationRepository; generationRunner: GenerationRunner; thumbnails: ThumbnailService; runtimes:RuntimeRepository; studio:StudioRepository; studioRunner:StudioRunner }
export async function apiRoutes(request: IncomingMessage, response: ServerResponse, url: URL, context: RouteContext): Promise<boolean> {
  const { store, config, scheduler } = context; const method = request.method, path = url.pathname;
  if (await storyboardRoutes(request, response, url, context) || await providerRoutes(request, response, url, context) || await generationRoutes(request, response, url, context) || await studioRoutes(request,response,url,context)) return true;
  if (path === '/api/projects' && method === 'GET') { json(response, store.listProjects()); return true; }
  if (path === '/api/projects' && method === 'POST') { json(response, store.createProject(projectInput(await jsonBody(request))), 201); return true; }
  const project = /^\/api\/projects\/([^/]+)$/.exec(path);
  if (project && method === 'GET') { json(response, store.snapshot(resourceId(project[1]))); return true; }
  if (project && method === 'PUT') { const b = record(await jsonBody(request)); json(response, store.updateProject(resourceId(project[1]), projectInput(b), integer(b.expectedRevision, '项目版本', 1, Number.MAX_SAFE_INTEGER))); return true; }
  const assets = /^\/api\/projects\/([^/]+)\/assets$/.exec(path);
  if (assets && method === 'POST') { json(response, await importAsset(store, request, resourceId(assets[1]), url.searchParams.get('name') || '', config.maxUploadBytes), 201); return true; }
  const content = /^\/api\/artifacts\/([^/]+)\/content$/.exec(path);
  if (content && ['GET', 'HEAD'].includes(method || '')) { await sendAsset(store, resourceId(content[1]), request, response); return true; }
  const thumbnail = /^\/api\/artifacts\/([^/]+)\/thumbnail$/.exec(path);
  if (thumbnail && method === 'GET') {
    const png = await context.thumbnails.read(resourceId(thumbnail[1]));
    response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.byteLength, 'Cache-Control': 'private, max-age=3600' });
    response.end(png); return true;
  }
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
    for (const track of input.audio) { const { artifact } = await resolveAsset(store, track.artifactId); invariant(artifact.projectId === projectId && (artifact.kind === 'audio' || artifact.kind === 'video' && artifact.media.hasAudio), 'INVALID_AUDIO', '音轨必须使用当前项目中包含声音的素材'); }
    const { expectedVersion, ...draft } = input; json(response, store.saveTimeline(projectId, draft, expectedVersion)); return true;
  }
  const exports = /^\/api\/projects\/([^/]+)\/exports$/.exec(path);
  if (exports && method === 'POST') {
    const projectId = resourceId(exports[1]), body = record(await jsonBody(request));
    const timeline = store.getTimeline(resourceId(body.timelineId));
    invariant(timeline.projectId === projectId, 'INVALID_TIMELINE', '时间线不属于当前项目');
    for (const clip of timeline.clips) await resolveAsset(store, clip.artifactId);
    for (const track of timeline.audio) await resolveAsset(store, track.artifactId);
    const dedupeKey = `export:${projectId}:${resourceId(body.clientRequestId)}`;
    const original = store.db.prepare('SELECT id FROM jobs WHERE dedupe_key=?').get(dedupeKey);
    if (original) { const job = store.getJob(String(original.id)); invariant(job.payload.timelineId === timeline.id, 'IDEMPOTENCY_CONFLICT', '同一导出操作不能使用不同时间线', 409); json(response, job, 202); return true; }
    const mediaSettings = store.getSettings(); let subtitleFontSha256: string | undefined;
    if (mediaSettings.subtitleFontPath && timeline.captions.length) { const font = await fontHealth(mediaSettings.subtitleFontPath); invariant(font.available, 'FONT_UNAVAILABLE', font.error || '字幕字体不可用'); subtitleFontSha256 = await hashFile(mediaSettings.subtitleFontPath); }
    const job = store.transaction(() => {
      const duplicate = store.db.prepare('SELECT id FROM jobs WHERE dedupe_key=?').get(dedupeKey);
      if (duplicate) { const originalJob = store.getJob(String(duplicate.id)); invariant(originalJob.payload.timelineId === timeline.id, 'IDEMPOTENCY_CONFLICT', '同一导出操作不能使用不同时间线', 409); return originalJob; }
      return store.createJob({ projectId, type: 'export', payload: { timelineId: timeline.id, mediaSettings, ...(subtitleFontSha256 ? { subtitleFontSha256 } : {}) }, dedupeKey });
    });
    scheduler.tick(); json(response, store.getJob(job.id), 202); return true;
  }
  const jobs = /^\/api\/projects\/([^/]+)\/jobs$/.exec(path);
  if (jobs && method === 'GET') { store.getProject(resourceId(jobs[1])); json(response, store.listJobs(jobs[1])); return true; }
  const job = /^\/api\/jobs\/([^/]+)$/.exec(path);
  if (job && method === 'GET') { json(response, store.getJob(resourceId(job[1]))); return true; }
  const cancel = /^\/api\/jobs\/([^/]+)\/cancel$/.exec(path);
  if (cancel && method === 'POST') { const job = store.getJob(resourceId(cancel[1])); if (job.type === 'generation') { context.generationRunner.cancel(String(job.payload.generationId)); json(response, store.getJob(job.id)); } else if(job.type==='studio'){context.studioRunner.cancel(String(job.payload.operationId));json(response,store.getJob(job.id));} else json(response, job.type === 'reasoning' ? context.models.cancel(job.id) : scheduler.cancel(job.id)); return true; }
  if (path === '/api/events' && method === 'GET') {
    const after = integer(Number(request.headers['last-event-id'] || url.searchParams.get('after') || 0), '事件游标', 0, Number.MAX_SAFE_INTEGER);
    const stop = eventStream(store, resourceId(url.searchParams.get('projectId')), after, response); context.streams.add(stop); response.on('close', () => context.streams.delete(stop)); return true;
  }
  if (path === '/api/health' && method === 'GET') {
    const settings = store.getSettings(); const [ffmpeg, ffprobe] = await Promise.all([toolHealth(settings.ffmpegPath), toolHealth(settings.ffprobePath)]);
    const subtitleFont = settings.subtitleFontPath ? await fontHealth(settings.subtitleFontPath) : undefined;
    json(response, { status: ffmpeg.available && ffprobe.available ? 'ok' : 'degraded', version: '0.1.0', schemaVersion: store.schemaVersion, ffmpeg, ffprobe, subtitleFont, dataDir: config.dataDir, projectsDir: config.projectsDir }); return true;
  }
  if (path === '/api/settings' && method === 'GET') { json(response, store.getSettings()); return true; }
  if (path === '/api/settings' && method === 'PUT') {
    const body = record(await jsonBody(request));
    const ffmpegPath = text(body.ffmpegPath, 'FFmpeg 路径', 1000), ffprobePath = text(body.ffprobePath, 'ffprobe 路径', 1000);
    for (const p of [ffmpegPath, ffprobePath]) invariant(!p.includes('\0') && (isAbsolute(p) || ['ffmpeg', 'ffprobe'].includes(p)), 'INVALID_TOOL_PATH', '请填写绝对工具路径或默认命令名');
    const subtitleFontPath = body.subtitleFontPath === undefined ? undefined : text(body.subtitleFontPath, '字幕字体路径', 2048, true);
    if (subtitleFontPath) { invariant(isAbsolute(subtitleFontPath), 'INVALID_FONT_PATH', '字体需为绝对文件路径'); const font = await fontHealth(subtitleFontPath); invariant(font.available, 'FONT_UNAVAILABLE', font.error || '字体不可用'); }
    store.updateSettings({ ffmpegPath, ffprobePath, ...(subtitleFontPath === undefined ? {} : { subtitleFontPath }) }); json(response, store.getSettings()); return true;
  }
  if (path === '/api/diagnostics' && method === 'GET') {
    json(response, { version: '0.1.0', schemaVersion: store.schemaVersion, projectCount: store.listProjects().length, at: new Date().toISOString(), traceId: randomUUID() }); return true;
  }
  if (path.startsWith('/api/')) throw new AppError('NOT_FOUND', '接口不存在', 404);
  return false;
}
