import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Artifact, TimelineDraft } from '../packages/contracts/src/index.ts';
import { probe, renderTimeline, toolHealth, validateTimeline } from '../packages/media/src/index.ts';
import { runCommand } from '../packages/media/src/process.ts';

const execute = promisify(execFile);
let directory = '';
let special = '';
const files = new Map<string, { artifact: Artifact; path: string }>();

async function ffmpeg(args: string[]): Promise<void> {
  await execute('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-filter_threads', '1', '-y', ...args], { timeout: 30_000, maxBuffer: 1024 * 1024 });
}
async function register(id: string, path: string): Promise<void> {
  const bytes = await readFile(path);
  const media = await probe(path);
  files.set(id, { path, artifact: { id, projectId: 'project', name: id, kind: media.kind, relativePath: id, sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length, media, source: 'import', createdAt: new Date().toISOString(), metadata: {} } });
}
function timeline(): TimelineDraft {
  return { width: 160, height: 90, fps: 24, captions: [], audio: [], clips: [
    { artifactId: 'red', sourceInMs: 250, durationMs: 1000, fit: 'contain', muteSource: false },
    { artifactId: 'blue', sourceInMs: 300, durationMs: 1000, fit: 'cover', muteSource: false },
    { artifactId: 'green', sourceInMs: 0, durationMs: 1000, fit: 'contain', muteSource: true },
  ] };
}
function render(plan: TimelineDraft, name: string, extra: Partial<Parameters<typeof renderTimeline>[0]> = {}) {
  return renderTimeline({ timeline: plan, outputPath: join(special, name), workDir: join(special, 'work'), resolveArtifact: id => {
    const value = files.get(id);
    assert(value, 'fixture asset must exist');
    return value;
  }, ...extra });
}
async function centerPixel(path: string, at: number): Promise<number[]> {
  const { stdout } = await execute('ffmpeg', ['-v', 'error', '-ss', String(at), '-i', path, '-frames:v', '1', '-vf', 'crop=2:2:(iw-2)/2:(ih-2)/2,scale=1:1', '-threads', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer', timeout: 15_000, maxBuffer: 1024 * 1024 });
  return [...stdout.subarray(0, 3)];
}
async function audioPeak(path: string, at = 0.1): Promise<number> {
  const { stdout } = await execute('ffmpeg', ['-v', 'error', '-ss', String(at), '-i', path, '-t', '0.4', '-vn', '-f', 's16le', '-c:a', 'pcm_s16le', '-ar', '8000', '-ac', '1', 'pipe:1'], { encoding: 'buffer', timeout: 15_000, maxBuffer: 1024 * 1024 });
  let peak = 0;
  for (let i = 0; i + 1 < stdout.length; i += 2) peak = Math.max(peak, Math.abs(stdout.readInt16LE(i)));
  return peak;
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'owntake-media-'));
  special = join(directory, "媒体 ' & [片段] $ literal");
  await mkdir(special);
  const red = join(special, 'red.mp4');
  const blue = join(special, 'blue.mp4');
  const green = join(special, 'green.png');
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=24', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1', '-pix_fmt', 'yuv420p', '-c:a', 'aac', red]);
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=blue:s=96x160:r=30', '-t', '1.5', '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1', '-pix_fmt', 'yuv420p', '-an', blue]);
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=lime:s=80x120', '-frames:v', '1', '-threads', '1', green]);
  await register('red', red); await register('blue', blue); await register('green', green);
});
after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

test('probe reports actual video/image/audio metadata and supports extensionless files', async () => {
  assert.equal(files.get('red')!.artifact.media.hasAudio, true);
  assert.equal(files.get('red')!.artifact.media.kind, 'video');
  assert.equal(files.get('blue')!.artifact.media.hasAudio, false);
  assert.equal(files.get('green')!.artifact.media.kind, 'image');
  assert.equal(files.get('green')!.artifact.media.width, 80);
  const noExtension = join(special, 'asset-without-extension');
  await copyFile(files.get('green')!.path, noExtension);
  assert.equal((await probe(noExtension)).kind, 'image');
  const audio = join(special, 'voice.wav');
  await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=600:sample_rate=48000', '-t', '0.5', '-c:a', 'pcm_s16le', audio]);
  const info = await probe(audio);
  assert.equal(info.kind, 'audio'); assert.equal(info.durationMs, 500);
});

test('health checks resolve tools and report missing executables without claiming success', async () => {
  const available = await toolHealth('ffmpeg');
  assert(available.available); assert(available.path.startsWith('/')); assert.match(available.version!, /^ffmpeg version /);
  const missing = await toolHealth(join(directory, 'missing-ffmpeg'));
  assert.equal(missing.available, false); assert(missing.error);
});

test('three mixed clips render in order with correct size, duration, preserved audio and silent gaps', async () => {
  const progress: number[] = [];
  const result = await render(timeline(), '成片 输出.mp4', { onProgress: value => progress.push(value) });
  assert.equal(result.kind, 'video'); assert.equal(result.width, 160); assert.equal(result.height, 90);
  assert.equal(result.hasAudio, true); assert(Math.abs(result.durationMs - 3000) <= 84);
  assert.equal(progress[0], 0); assert.equal(progress.at(-1), 1);
  assert(progress.every((n, i) => i === 0 || n >= progress[i - 1]!));
  const path = join(special, '成片 输出.mp4');
  const red = await centerPixel(path, 0.5); const blue = await centerPixel(path, 1.5); const green = await centerPixel(path, 2.5);
  assert(red[0]! > 170 && red[1]! < 50 && red[2]! < 50, `first clip ${red}`);
  assert(blue[2]! > 170 && blue[0]! < 50 && blue[1]! < 50, `second clip ${blue}`);
  assert(green[1]! > 170 && green[0]! < 50 && green[2]! < 50, `third clip ${green}`);
  assert(await audioPeak(path, 0.2) > 500, 'source tone should survive');
  assert(await audioPeak(path, 1.2) < 5, 'silent source should remain silent');
  assert(await audioPeak(path, 2.2) < 5, 'still image should have silence');
  await execute('ffmpeg', ['-v', 'error', '-i', path, '-f', 'null', '-'], { timeout: 15_000 });
  assert.deepEqual(await readdir(join(special, 'work')), [], 'per-run temporary clips must be cleaned');
});

test('muteSource removes source sound while keeping the normalised audio stream', async () => {
  const plan = timeline(); plan.clips = [{ ...plan.clips[0]!, muteSource: true }];
  const result = await render(plan, 'muted.mp4');
  assert(result.hasAudio);
  assert(await audioPeak(join(special, 'muted.mp4')) < 5);
});

test('unsupported features, invalid trim ranges and missing sources fail instead of producing partial movies', async () => {
  const captions = timeline(); captions.captions = [{ startMs: 0, endMs: 500, text: '字幕' }];
  assert.throws(() => validateTimeline(captions), { code: 'UNSUPPORTED_MEDIA_FEATURE' });
  const audio = timeline(); audio.audio = [{ artifactId: 'audio', startMs: 0, sourceInMs: 0, gainDb: 0 }];
  assert.throws(() => validateTimeline(audio), { code: 'UNSUPPORTED_MEDIA_FEATURE' });
  const trim = timeline(); trim.clips[0]!.sourceInMs = 1900;
  await assert.rejects(render(trim, 'invalid-trim.mp4'), { code: 'INVALID_TIMELINE' });
  const item = files.get('red')!;
  await assert.rejects(render(timeline(), 'missing.mp4', { resolveArtifact: id => ({ artifact: { ...item.artifact, id }, path: join(directory, 'missing.mp4') }) }), { code: 'ASSET_UNAVAILABLE' });
  await assert.rejects(stat(join(special, 'missing.mp4')), { code: 'ENOENT' });
});

test('playlist, unsupported text and symbolic link inputs are rejected before parsing', async () => {
  const playlist = join(special, 'spoofed.mp4');
  await writeFile(playlist, '#EXTM3U\nhttp://127.0.0.1/private\n');
  await assert.rejects(probe(playlist), { code: 'UNSUPPORTED_MEDIA' });
  const link = join(special, 'link.mp4');
  await symlink(files.get('red')!.path, link);
  await assert.rejects(probe(link), { code: 'INVALID_MEDIA' });
});

test('cancellation terminates active media work and removes incomplete outputs', async () => {
  const controller = new AbortController();
  await assert.rejects(render(timeline(), 'cancelled.mp4', { signal: controller.signal, onProgress: value => { if (value > 0) controller.abort(); } }), { code: 'JOB_CANCELLED' });
  await assert.rejects(stat(join(special, 'cancelled.mp4')), { code: 'ENOENT' });
  assert.deepEqual(await readdir(join(special, 'work')), []);
  const preAborted = new AbortController(); preAborted.abort();
  await assert.rejects(render(timeline(), 'never-created.mp4', { signal: preAborted.signal }), { code: 'JOB_CANCELLED' });
});

test('existing output is never overwritten and timeout kills the owned process', async () => {
  const original = join(special, 'existing.mp4'); await writeFile(original, 'keep');
  await assert.rejects(render(timeline(), 'existing.mp4'), { code: 'OUTPUT_EXISTS' });
  assert.equal(await readFile(original, 'utf8'), 'keep');
  await assert.rejects(runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 80 }), { code: 'TOOL_TIMEOUT' });
});
