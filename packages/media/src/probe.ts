import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { AppError } from '../../contracts/src/errors.ts';
import type { MediaInfo, ToolHealth } from '../../contracts/src/index.ts';
import { resolveExecutable, runCommand, throwIfAborted } from './process.ts';

export interface ProbeOptions { ffprobePath?: string; signal?: AbortSignal; timeoutMs?: number }
export interface MediaInput { path: string; demuxer: string; image: boolean }

/** Reject playlists, SVG/HTML and unrecognised files before invoking any parser. */
export async function inspectInput(path: string): Promise<MediaInput> {
  if (!isAbsolute(path) || path.includes('\0')) throw new AppError('ASSET_UNAVAILABLE', '媒体必须是已登记的本地绝对路径。', 404);
  let info;
  try { info = await lstat(path); }
  catch { throw new AppError('ASSET_UNAVAILABLE', '素材文件不存在或无法读取。', 404); }
  if (!info.isFile() || info.isSymbolicLink() || info.size === 0) throw new AppError('INVALID_MEDIA', '素材必须是非空的普通媒体文件。', 422);
  const file = await open(path, 'r');
  const bytes = Buffer.alloc(Math.min(65_536, info.size));
  try { await file.read(bytes, 0, bytes.length, 0); }
  finally { await file.close(); }
  let demuxer: string | undefined;
  let image = false;
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    if (bytes.includes(Buffer.from('acTL'))) throw new AppError('UNSUPPORTED_MEDIA', '动画 PNG 请先转换为视频；图片导入仅支持静态图片。', 422);
    demuxer = 'image2'; image = true;
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    demuxer = 'image2'; image = true;
  } else if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    if (bytes.toString('ascii', 12, 16) === 'VP8X' && ((bytes[20] ?? 0) & 2)) throw new AppError('UNSUPPORTED_MEDIA', '动画 WebP 请先转换为视频。', 422);
    demuxer = 'image2'; image = true;
  } else if (bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) demuxer = 'matroska';
  else if (['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip'].includes(bytes.toString('ascii', 4, 8))) demuxer = 'mov';
  else if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'AVI ') demuxer = 'avi';
  else if (['RIFF', 'RF64'].includes(bytes.toString('ascii', 0, 4)) && bytes.toString('ascii', 8, 12) === 'WAVE') demuxer = 'wav';
  else if (bytes.toString('ascii', 0, 4) === 'fLaC') demuxer = 'flac';
  else if (bytes.toString('ascii', 0, 4) === 'OggS') demuxer = 'ogg';
  else if (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xf6) === 0xf0) demuxer = 'aac';
  else if (bytes.toString('ascii', 0, 3) === 'ID3' || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)) demuxer = 'mp3';
  if (!demuxer) throw new AppError('UNSUPPORTED_MEDIA', '不支持的媒体格式。请使用 PNG/JPEG/WebP、MP4/MOV/WebM/MKV/AVI 或常见音频文件。', 422);
  return { path: await realpath(path), demuxer, image };
}

/** Decoder format is fixed from magic bytes. Input paths never become filter expressions. */
export function inputArguments(input: MediaInput, loop = false, fps = 24): string[] {
  const args = ['-protocol_whitelist', 'file,pipe', '-f', input.demuxer];
  if (input.image) args.push('-pattern_type', 'none', ...(loop ? ['-loop', '1', '-framerate', String(fps)] : []));
  if (input.demuxer === 'mov') args.push('-enable_drefs', '0', '-use_absolute_path', '0');
  return args;
}

function finite(value: unknown): number {
  const number = typeof value === 'string' || typeof value === 'number' ? Number(value) : NaN;
  return Number.isFinite(number) ? number : 0;
}
function rate(value: unknown): number {
  if (typeof value !== 'string') return 0;
  const [n, d = '1'] = value.split('/');
  return finite(n) / (finite(d) || 1);
}

export async function probe(path: string, options: ProbeOptions = {}): Promise<MediaInfo> {
  throwIfAborted(options.signal);
  const input = await inspectInput(path);
  const { stdout } = await runCommand(options.ffprobePath ?? 'ffprobe', [
    '-v', 'error', ...inputArguments(input), '-show_streams', '-show_format', '-print_format', 'json', '-i', input.path,
  ], { signal: options.signal, timeoutMs: options.timeoutMs ?? 20_000, maxStdoutBytes: 1024 * 1024 });
  let data: { streams?: Record<string, any>[]; format?: Record<string, any> };
  try { data = JSON.parse(stdout); }
  catch { throw new AppError('INVALID_MEDIA', '无法解析素材媒体信息。', 422); }
  const streams = Array.isArray(data.streams) ? data.streams : [];
  const video = streams.find(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
  const audio = streams.find(stream => stream.codec_type === 'audio');
  if (!video && !audio) throw new AppError('INVALID_MEDIA', '素材没有可用的视频、图片或音频流。', 422);
  const kind = input.image ? 'image' : video ? 'video' : 'audio';
  const durationMs = kind === 'image' ? 0 : Math.round(Math.max(finite(data.format?.duration), finite(video?.duration), finite(audio?.duration)) * 1000);
  if (kind !== 'image' && durationMs <= 0) throw new AppError('INVALID_MEDIA', '素材时长无法确定，不能安全裁切或导出。', 422);
  const width = Math.round(finite(video?.width));
  const height = Math.round(finite(video?.height));
  if (video && (width <= 0 || height <= 0 || width > 16_384 || height > 16_384)) throw new AppError('INVALID_MEDIA', '素材尺寸无效或超过允许范围。', 422);
  const result: MediaInfo = { kind, durationMs, hasAudio: Boolean(audio), format: String(data.format?.format_name ?? input.demuxer) };
  if (video) {
    const rotation = finite(video.side_data_list?.find((item: Record<string, unknown>) => typeof item.rotation === 'number')?.rotation ?? video.tags?.rotate);
    const swapped = Math.abs(rotation % 180) === 90;
    result.width = swapped ? height : width;
    result.height = swapped ? width : height;
    const fps = rate(video.avg_frame_rate) || rate(video.r_frame_rate);
    if (fps > 0 && fps < 1000) result.fps = fps;
    result.codec = String(video.codec_name ?? 'unknown');
  } else result.codec = String(audio?.codec_name ?? 'unknown');
  return result;
}

export async function toolHealth(path: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<ToolHealth> {
  try {
    const executable = await resolveExecutable(path);
    const result = await runCommand(executable, ['-version'], { ...options, timeoutMs: options.timeoutMs ?? 5000, maxStdoutBytes: 65_536 });
    return { available: true, path: executable, version: (result.stdout || result.stderr).split('\n')[0]?.trim() };
  } catch (error) {
    return { available: false, path, error: error instanceof Error ? error.message : '媒体工具不可用。' };
  }
}
