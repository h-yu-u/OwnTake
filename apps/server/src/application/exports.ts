import { invariant } from '../../../../packages/contracts/src/errors.ts';
import { record, resourceId } from '../../../../packages/domain/src/validation.ts';
import { ffprobeHealth, fontHealth, resolveRenderFfmpeg } from '../../../../packages/media/src/index.ts';
import type { Job } from '../../../../packages/contracts/src/index.ts';
import type { Store } from '../../../../packages/storage/src/index.ts';
import { hashFile, resolveAsset } from '../assets.ts';
import type { ApplicationContext } from './context.ts';

function existingExport(store: Store, dedupeKey: string, timelineId: string): Job | undefined {
  const row = store.db.prepare('SELECT id FROM jobs WHERE dedupe_key=?').get(dedupeKey);
  if (!row) return undefined;
  const job = store.getJob(String(row.id));
  invariant(job.payload.timelineId === timelineId, 'IDEMPOTENCY_CONFLICT', '同一导出操作不能使用不同时间线', 409);
  return job;
}

/** Freeze media settings and commit the durable job before waking the worker. */
export async function requestExport({ store, scheduler }: Pick<ApplicationContext, 'store' | 'scheduler'>, id: string, value: unknown): Promise<Job> {
  const projectId = resourceId(id), body = record(value);
  const timeline = store.getTimeline(resourceId(body.timelineId));
  invariant(timeline.projectId === projectId, 'INVALID_TIMELINE', '时间线不属于当前项目');
  for (const clip of timeline.clips) await resolveAsset(store, clip.artifactId);
  for (const track of timeline.audio) await resolveAsset(store, track.artifactId);
  const dedupeKey = `export:${projectId}:${resourceId(body.clientRequestId)}`;
  const original = existingExport(store, dedupeKey, timeline.id);
  if (original) return original;

  const mediaSettings = { ...store.getSettings() };
  mediaSettings.ffmpegPath = await resolveRenderFfmpeg(mediaSettings.ffmpegPath, timeline.captions.length > 0);
  const ffprobe = await ffprobeHealth(mediaSettings.ffprobePath);
  invariant(ffprobe.available, 'FFPROBE_UNAVAILABLE', 'ffprobe 无法启动，请检查媒体工具安装与路径。', 503);
  mediaSettings.ffprobePath = ffprobe.path;
  let subtitleFontSha256: string | undefined;
  if (mediaSettings.subtitleFontPath && timeline.captions.length) {
    const font = await fontHealth(mediaSettings.subtitleFontPath);
    invariant(font.available, 'FONT_UNAVAILABLE', font.error || '字幕字体不可用');
    subtitleFontSha256 = await hashFile(mediaSettings.subtitleFontPath);
  }
  // Asset and font checks await I/O, so repeat the dedupe check in the transaction.
  const job = store.transaction(() => existingExport(store, dedupeKey, timeline.id) ?? store.createJob({
    projectId, type: 'export', dedupeKey,
    payload: { timelineId: timeline.id, mediaSettings, ...(subtitleFontSha256 ? { subtitleFontSha256 } : {}) },
  }));
  scheduler.tick();
  return store.getJob(job.id);
}
