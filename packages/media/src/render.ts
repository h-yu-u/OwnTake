import { mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Artifact, MediaInfo, TimelineClip, TimelineDraft } from '../../contracts/src/index.ts';
import { AppError, invariant } from '../../contracts/src/errors.ts';
import { inputArguments, inspectInput, probe } from './probe.ts';
import type { MediaInput } from './probe.ts';
import { runCommand, throwIfAborted } from './process.ts';

export interface ResolvedArtifact { artifact: Artifact; path: string }
export interface RenderOptions {
  timeline: TimelineDraft;
  resolveArtifact: (id: string) => ResolvedArtifact | Promise<ResolvedArtifact>;
  outputPath: string;
  workDir: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
  timeoutMs?: number;
}
interface PreparedClip { clip: TimelineClip; input: MediaInput; media: MediaInfo; frames: number; durationMs: number }
const seconds = (ms: number): string => (ms / 1000).toFixed(6);

/** Durations are quantised once to output frames; source trim positions remain milliseconds. */
export function validateTimeline(timeline: TimelineDraft): void {
  invariant(timeline && typeof timeline === 'object', 'INVALID_TIMELINE', '时间线格式无效。');
  for (const dimension of [timeline.width, timeline.height]) invariant(Number.isInteger(dimension) && dimension >= 16 && dimension <= 4096 && dimension % 2 === 0, 'INVALID_TIMELINE', '导出宽高必须是 16–4096 范围内的偶数。');
  invariant(Number.isInteger(timeline.fps) && timeline.fps >= 1 && timeline.fps <= 60, 'INVALID_TIMELINE', '导出帧率必须是 1–60 的整数。');
  invariant(Array.isArray(timeline.clips) && timeline.clips.length >= 1 && timeline.clips.length <= 200, 'INVALID_TIMELINE', '时间线需要 1–200 个片段。');
  invariant(Array.isArray(timeline.captions) && Array.isArray(timeline.audio), 'INVALID_TIMELINE', '字幕与音轨字段必须是数组。');
  invariant(timeline.captions.length === 0 && timeline.audio.length === 0, 'UNSUPPORTED_MEDIA_FEATURE', '当前阶段尚未启用叠加字幕与独立音轨，不能忽略这些内容导出。', 422);
  for (const clip of timeline.clips) {
    invariant(clip && typeof clip.artifactId === 'string' && clip.artifactId.length > 0 && clip.artifactId.length <= 200, 'INVALID_TIMELINE', '片段素材引用无效。');
    invariant(Number.isFinite(clip.sourceInMs) && clip.sourceInMs >= 0 && clip.sourceInMs <= 86_400_000, 'INVALID_TIMELINE', '素材入点无效。');
    invariant(Number.isFinite(clip.durationMs) && clip.durationMs > 0 && clip.durationMs <= 3_600_000 && Math.round(clip.durationMs * timeline.fps / 1000) >= 1, 'INVALID_TIMELINE', '片段时长必须至少包含一帧，且不超过一小时。');
    invariant(clip.fit === 'contain' || clip.fit === 'cover', 'INVALID_TIMELINE', '画面适配方式无效。');
    invariant(typeof clip.muteSource === 'boolean', 'INVALID_TIMELINE', '源音频静音设置无效。');
  }
  invariant(timelineDurationMs(timeline) <= 7_200_000, 'INVALID_TIMELINE', '单次导出最长两小时。');
}

export function timelineDurationMs(timeline: TimelineDraft): number {
  return timeline.clips.reduce((total, clip) => total + Math.round(clip.durationMs * timeline.fps / 1000), 0) / timeline.fps * 1000;
}

function videoFilter(clip: PreparedClip, timeline: TimelineDraft): string {
  const fit = clip.clip.fit === 'contain'
    ? `scale=${timeline.width}:${timeline.height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${timeline.width}:${timeline.height}:(ow-iw)/2:(oh-ih)/2:color=black`
    : `scale=${timeline.width}:${timeline.height}:force_original_aspect_ratio=increase:force_divisible_by=2,crop=${timeline.width}:${timeline.height}`;
  return `scale='max(2,trunc(iw*sar/2)*2)':ih,setsar=1,${fit},fps=${timeline.fps},tpad=stop_mode=clone:stop_duration=0.1,trim=duration=${seconds(clip.durationMs)},setpts=PTS-STARTPTS,format=yuv420p`;
}

function progressParser(durationMs: number, update: (fraction: number) => void): (chunk: string) => void {
  let pending = '';
  return chunk => {
    pending += chunk;
    const lines = pending.split('\n');
    pending = (lines.pop() ?? '').slice(-16_384);
    for (const line of lines) {
      if (!line.startsWith('out_time_us=')) continue;
      const microseconds = Number(line.slice(12));
      if (Number.isFinite(microseconds)) update(Math.max(0, Math.min(1, microseconds / (durationMs * 1000))));
    }
  };
}

export async function renderTimeline(options: RenderOptions): Promise<MediaInfo> {
  const timeline = structuredClone(options.timeline);
  validateTimeline(timeline);
  throwIfAborted(options.signal);
  const expectedDurationMs = timelineDurationMs(timeline);
  const ffmpegPath = options.ffmpegPath ?? 'ffmpeg';
  const outputPath = resolve(options.outputPath);
  const prepared: PreparedClip[] = [];
  let lastProgress = 0;
  const progress = (value: number): void => {
    lastProgress = Math.max(lastProgress, Math.min(1, value));
    options.onProgress?.(lastProgress);
  };
  progress(0);
  for (const clip of timeline.clips) {
    throwIfAborted(options.signal);
    const source = await options.resolveArtifact(clip.artifactId);
    invariant(source?.artifact?.id === clip.artifactId, 'ASSET_UNAVAILABLE', '无法解析所选素材。', 404);
    const input = await inspectInput(source.path);
    const media = await probe(input.path, { ffprobePath: options.ffprobePath, signal: options.signal });
    invariant(media.kind === 'video' || media.kind === 'image', 'INVALID_TIMELINE', '画面轨道只能使用视频或静态图片。');
    const frames = Math.round(clip.durationMs * timeline.fps / 1000);
    const durationMs = frames / timeline.fps * 1000;
    if (media.kind === 'image') invariant(clip.sourceInMs === 0, 'INVALID_TIMELINE', '静态图片的素材入点必须为零。');
    else invariant(clip.sourceInMs + durationMs <= media.durationMs + 1000 / timeline.fps, 'INVALID_TIMELINE', '片段使用范围超过素材时长。');
    prepared.push({ clip, input, media, frames, durationMs });
  }
  await mkdir(options.workDir, { recursive: true, mode: 0o700 });
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
  const runDir = await mkdtemp(join(options.workDir, 'render-'));
  let ownsOutput = false;
  try {
    try {
      const output = await open(outputPath, 'wx', 0o600);
      ownsOutput = true;
      await output.close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new AppError('OUTPUT_EXISTS', '输出路径已存在，不能覆盖已有素材或导出。', 409);
      throw error;
    }
    let renderedMs = 0;
    const names: string[] = [];
    for (let index = 0; index < prepared.length; index += 1) {
      const item = prepared[index]!;
      throwIfAborted(options.signal);
      // MOV preserves the frame time base and uncompressed audio. Millisecond
      // containers would introduce rounding drift when copying 24/30 fps video.
      const name = `clip-${String(index).padStart(4, '0')}.mov`;
      names.push(name);
      const useSourceAudio = item.media.hasAudio && !item.clip.muteSource;
      const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-filter_threads', '1', '-filter_complex_threads', '1', '-n'];
      if (item.media.kind === 'video') args.push('-ss', seconds(item.clip.sourceInMs));
      args.push(...inputArguments(item.input, item.media.kind === 'image', timeline.fps), '-i', item.input.path);
      if (!useSourceAudio) args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
      args.push('-map', '0:V:0', '-map', useSourceAudio ? '0:a:0' : '1:a:0', '-map_metadata', '-1', '-map_chapters', '-1');
      args.push('-vf', videoFilter(item, timeline), '-af', `aresample=48000,apad,atrim=duration=${seconds(item.durationMs)},asetpts=PTS-STARTPTS`);
      args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-threads', '2', '-pix_fmt', 'yuv420p', '-r', String(timeline.fps), '-fps_mode', 'cfr');
      args.push('-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', '-t', seconds(item.durationMs), '-video_track_timescale', String(timeline.fps * 1000), '-progress', 'pipe:1', '-nostats', '-f', 'mov', join(runDir, name));
      const completedBefore = renderedMs;
      await runCommand(ffmpegPath, args, {
        signal: options.signal, captureStdout: false, timeoutMs: options.timeoutMs ?? Math.max(120_000, item.durationMs * 20),
        onStdout: progressParser(item.durationMs, fraction => progress(0.9 * (completedBefore + fraction * item.durationMs) / expectedDurationMs)),
      });
      renderedMs += item.durationMs;
      progress(0.9 * renderedMs / expectedDurationMs);
    }
    await writeFile(join(runDir, 'concat.txt'), names.map(name => `file '${name}'`).join('\n') + '\n', { mode: 0o600 });
    throwIfAborted(options.signal);
    await runCommand(ffmpegPath, [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-protocol_whitelist', 'file,pipe', '-f', 'concat', '-safe', '1', '-i', join(runDir, 'concat.txt'),
      '-map', '0:v:0', '-map', '0:a:0', '-map_metadata', '-1', '-map_chapters', '-1', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
      '-t', seconds(expectedDurationMs), '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', '-f', 'mp4', outputPath,
    ], { signal: options.signal, captureStdout: false, timeoutMs: options.timeoutMs ?? Math.max(120_000, expectedDurationMs * 5), cwd: runDir, onStdout: progressParser(expectedDurationMs, fraction => progress(0.9 + fraction * 0.08)) });
    const result = await probe(outputPath, { ffprobePath: options.ffprobePath, signal: options.signal });
    invariant(result.kind === 'video' && result.width === timeline.width && result.height === timeline.height && result.hasAudio, 'INVALID_EXPORT', '导出文件的画幅或媒体流未通过检查。', 422);
    invariant(result.codec === 'h264' && Math.abs((result.fps ?? 0) - timeline.fps) < 0.001, 'INVALID_EXPORT', '导出视频编码或帧率未通过检查。', 422);
    invariant(Math.abs(result.durationMs - expectedDurationMs) <= Math.max(50, 2000 / timeline.fps), 'INVALID_EXPORT', '导出时长与冻结时间线不一致。', 422);
    progress(1);
    return result;
  } catch (error) {
    if (ownsOutput) await rm(outputPath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await rm(runDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
