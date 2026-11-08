import { AppError } from '../../contracts/src/errors.ts';
import type { ToolHealth } from '../../contracts/src/index.ts';
import { resolveExecutable, runCommand, throwIfAborted } from './process.ts';
import { toolHealth } from './probe.ts';

interface CheckOptions { signal?: AbortSignal; timeoutMs?: number }
export function supportsAssFilter(output: string): boolean {
  return output.split('\n').some(line => /^\s*[A-Z.]{2,4}\s+ass\s+V->V(?:\s|$)/.test(line));
}

/** Only the default command may discover an alternative; explicit user paths remain authoritative. */
export function renderFfmpegCandidates(command: string, platform: NodeJS.Platform = process.platform): string[] {
  return command === 'ffmpeg' && platform === 'darwin'
    ? [command, '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg', '/usr/local/opt/ffmpeg-full/bin/ffmpeg'] : [command];
}

export async function resolveRenderFfmpeg(command: string, subtitles: boolean, options: CheckOptions = {}): Promise<string> {
  throwIfAborted(options.signal);
  if (!subtitles) return resolveExecutable(command);
  let firstError: unknown;
  let inspected = false;
  for (const candidate of renderFfmpegCandidates(command)) {
    throwIfAborted(options.signal);
    try {
      const path = await resolveExecutable(candidate);
      const { stdout } = await runCommand(path, ['-hide_banner', '-filters'], { ...options, timeoutMs: options.timeoutMs ?? 5000, maxStdoutBytes: 1024 * 1024 });
      inspected = true;
      if (supportsAssFilter(stdout)) return path;
    } catch (error) { firstError ??= error; throwIfAborted(options.signal); }
  }
  if (!inspected && firstError) throw firstError;
  throw new AppError('FFMPEG_SUBTITLES_UNAVAILABLE', '当前 FFmpeg 不支持字幕渲染（缺少 ass / libass）。请安装支持字幕的 FFmpeg；macOS 可安装 ffmpeg-full，或在媒体工具设置中选择完整版本。字幕已保留，本次未开始编码。', 503);
}

export async function ffmpegHealth(command: string): Promise<ToolHealth> {
  try {
    const path = await resolveRenderFfmpeg(command, true);
    return { ...await toolHealth(path), capabilities: { subtitles: true } };
  } catch (error) {
    const health = await toolHealth(command);
    return { ...health, capabilities: { subtitles: false }, error: error instanceof Error ? error.message : '无法检查字幕渲染能力。' };
  }
}

export async function ffprobeHealth(command: string): Promise<ToolHealth> {
  const primary = await toolHealth(command);
  if (primary.available || command !== 'ffprobe') return primary;
  for (const candidate of renderFfmpegCandidates('ffmpeg').slice(1)) {
    const health = await toolHealth(candidate.replace(/\/ffmpeg$/, '/ffprobe'));
    if (health.available) return health;
  }
  return primary;
}
