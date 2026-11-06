import { mkdir, open, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { MediaInfo } from '../../contracts/src/index.ts';
import { AppError, invariant } from '../../contracts/src/errors.ts';
import { inputArguments, inspectInput, probe } from './probe.ts';
import { runCommand, throwIfAborted } from './process.ts';

export interface ThumbnailOptions {
  atMs?: number; width?: number; height?: number;
  ffmpegPath?: string; ffprobePath?: string; signal?: AbortSignal; timeoutMs?: number;
}
/** Produces one PNG in a caller-owned unpublished path; existing files are never replaced. */
export async function extractThumbnail(inputPath: string, outputPath: string, options: ThumbnailOptions = {}): Promise<MediaInfo> {
  throwIfAborted(options.signal);
  const input = await inspectInput(inputPath), media = await probe(input.path, options);
  invariant(media.kind === 'image' || media.kind === 'video', 'INVALID_THUMBNAIL', '缩略图只支持视频或静态图片。');
  const atMs = options.atMs ?? (media.kind === 'image' ? 0 : Math.min(1000, Math.floor(media.durationMs / 2)));
  invariant(Number.isSafeInteger(atMs) && atMs >= 0 && (media.kind === 'image' ? atMs === 0 : atMs < media.durationMs), 'INVALID_THUMBNAIL', '缩略图抽帧时间超出素材时长。');
  const width = options.width ?? 480, height = options.height ?? 270;
  for (const size of [width, height]) invariant(Number.isSafeInteger(size) && size >= 16 && size <= 2048, 'INVALID_THUMBNAIL', '缩略图边长必须介于 16–2048。');
  const target = resolve(outputPath); let ownsOutput = false;
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  try {
    try { const file = await open(target, 'wx', 0o600); ownsOutput = true; await file.close(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new AppError('OUTPUT_EXISTS', '缩略图输出已存在，不能覆盖。', 409); throw error; }
    const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-filter_threads', '1', '-y'];
    if (media.kind === 'video') args.push('-ss', (atMs / 1000).toFixed(6));
    args.push(...inputArguments(input), '-i', input.path, '-map', '0:V:0', '-an', '-frames:v', '1', '-vf', `scale='min(${width},iw)':'min(${height},ih)':force_original_aspect_ratio=decrease`, '-c:v', 'png', '-threads', '1', '-f', 'image2', '-update', '1', target);
    await runCommand(options.ffmpegPath ?? 'ffmpeg', args, { signal: options.signal, timeoutMs: options.timeoutMs ?? 30_000 });
    const result = await probe(target, options);
    invariant(result.kind === 'image' && result.codec === 'png' && (result.width ?? 0) <= width && (result.height ?? 0) <= height, 'INVALID_THUMBNAIL', '缩略图未通过媒体检查。', 422);
    return result;
  } catch (error) { if (ownsOutput) await rm(target, { force: true }).catch(() => undefined); throw error; }
}
