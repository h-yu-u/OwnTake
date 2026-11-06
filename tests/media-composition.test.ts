import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Artifact, TimelineDraft } from '../packages/contracts/src/index.ts';
import { extractThumbnail, fontHealth, probe, renderTimeline, validateTimeline } from '../packages/media/src/index.ts';
import { compileCaptions } from '../packages/media/src/captions.ts';
import { timelineInput } from '../packages/domain/src/validation.ts';
import { validateTimeline as validateStoredTimeline } from '../packages/storage/src/validation.ts';

const execute = promisify(execFile);
const files = new Map<string, { artifact: Artifact; path: string }>();
let directory = '', font = '';
async function ffmpeg(args: string[]): Promise<void> { await execute('ffmpeg', ['-nostdin', '-v', 'error', '-filter_threads', '1', '-y', ...args], { timeout: 30_000 }); }
async function register(id: string, path: string): Promise<void> {
  const bytes = await readFile(path), media = await probe(path);
  files.set(id, { path, artifact: { id, projectId: 'project', name: id, kind: media.kind, relativePath: id, sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length, media, source: 'import', createdAt: new Date().toISOString(), metadata: {} } });
}
function timeline(muteSource = true): TimelineDraft {
  return { width: 320, height: 180, fps: 24, clips: [{ artifactId: 'black', sourceInMs: 0, durationMs: 4000, fit: 'contain', muteSource }], captions: [], audio: [] };
}
async function render(plan: TimelineDraft, name: string, extra: Partial<Parameters<typeof renderTimeline>[0]> = {}) {
  return renderTimeline({ timeline: plan, resolveArtifact: id => { const item = files.get(id); assert(item, `Missing fixture ${id}`); return item; }, outputPath: join(directory, name), workDir: join(directory, '工作 run'), ...extra });
}
async function rgb(path: string, at: number): Promise<Buffer> {
  const { stdout } = await execute('ffmpeg', ['-v', 'error', '-ss', String(at), '-i', path, '-frames:v', '1', '-threads', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}
async function pcm(path: string): Promise<Buffer> {
  const { stdout } = await execute('ffmpeg', ['-v', 'error', '-i', path, '-vn', '-ar', '8000', '-ac', '1', '-c:a', 'pcm_f32le', '-f', 'f32le', 'pipe:1'], { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}
function amplitude(data: Buffer, frequency: number, at: number, duration = 0.1): number {
  const start = Math.round(at * 8000), count = Math.round(duration * 8000); let cosine = 0, sine = 0;
  for (let i = 0; i < count; i += 1) { const value = data.readFloatLE((start + i) * 4), phase = 2 * Math.PI * frequency * i / 8000; cosine += value * Math.cos(phase); sine += value * Math.sin(phase); }
  return 2 * Math.hypot(cosine, sine) / count;
}
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'owntake-composition-'));
  await mkdir(join(directory, "素材 ' [x] & 空格"));
  const black = join(directory, "素材 ' [x] & 空格", 'black.mp4'), voice = join(directory, "素材 ' [x] & 空格", 'voice.wav');
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=24', '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000', '-t', '4', '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '2', black]);
  await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '5', '-c:a', 'pcm_s16le', '-ac', '2', voice]);
  await register('black', black); await register('voice', voice);
  for (const candidate of [process.env.OWNTAKE_TEST_FONT, '/tmp/owntake-fonts/NotoSansCJKsc-Regular.otf', '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', '/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf', '/System/Library/Fonts/PingFang.ttc']) {
    if (!candidate) continue;
    try { await access(candidate); font = candidate; break; } catch { /* Try the next explicitly known font location. */ }
  }
});
after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

test('timeline layers survive API/storage validation and reject unsafe styles or out-of-range tracks', () => {
  const plan = timeline();
  plan.captions = [{ startMs: 500, endMs: 1500, text: '你好', style: { color: '#aabbcc', fontSize: 24, position: 'bottom', fontFamily: 'Noto Sans CJK SC' } }];
  plan.audio = [{ artifactId: 'voice', startMs: 1000, sourceInMs: 500, durationMs: 2000, gainDb: -6, fadeInMs: 300, fadeOutMs: 300 }];
  const parsed = timelineInput({ ...plan, expectedVersion: 2 });
  assert.equal(parsed.captions[0]!.style!.color, '#AABBCC'); assert.equal(parsed.audio[0]!.gainDb, -6);
  validateStoredTimeline(parsed, id => files.get(id)!.artifact); validateTimeline(parsed);
  assert.throws(() => timelineInput({ ...plan, captions: [{ ...plan.captions[0], style: { fontFamily: 'Arial,0,0,{\\p1}' } }] }));
  assert.throws(() => validateTimeline({ ...plan, captions: [{ startMs: 0, endMs: 4100, text: '越界' }] }));
  assert.throws(() => validateTimeline({ ...plan, audio: [{ ...plan.audio[0]!, durationMs: 3500 }] }));
  assert.throws(() => validateTimeline({ ...plan, audio: [{ ...plan.audio[0]!, gainDb: NaN }] }));
  assert.throws(() => validateStoredTimeline({ ...plan, audio: [{ ...plan.audio[0]!, sourceInMs: 4500 }] }, id => files.get(id)!.artifact));
});

test('custom font checks include magic bytes and metadata while leaving glyph coverage unverified', async () => {
  assert(font, 'Install fonts-noto-cjk or set OWNTAKE_TEST_FONT to a CJK OTF/TTF/TTC font for media acceptance');
  const health = await fontHealth(font);
  assert.equal(health.available, true); assert(health.sizeBytes! > 1000); assert(health.family); assert.equal(health.glyphCoverage, 'unchecked');
  const spoofed = join(directory, 'not-a-font.otf'); await writeFile(spoofed, 'plain text pretending to be a font file');
  assert.equal((await fontHealth(spoofed)).available, false);
  const plan = timeline(); plan.captions = [{ startMs: 500, endMs: 1500, text: '你好' }];
  await assert.rejects(render(plan, 'invalid-font.mp4', { subtitleFontPath: spoofed }), { code: 'INVALID_SUBTITLE_FONT' });
  await assert.rejects(stat(join(directory, 'invalid-font.mp4')), { code: 'ENOENT' });
});

test('real CJK captions render only during their intervals, respect styles, and cannot inject ASS positioning', async () => {
  assert(font, 'A real CJK font is required for the caption acceptance test');
  const plan = timeline();
  plan.captions = [
    { startMs: 500, endMs: 1500, text: '你好 {\\an8} \\N', style: { fontSize: 20, position: 'bottom' } },
    { startMs: 2000, endMs: 3000, text: '字幕样式', style: { fontSize: 24, position: 'top', color: '#00FF00' } },
  ];
  const ass = compileCaptions(plan, 'Noto Sans CJK SC');
  assert(!ass.includes('{\\an8}')); assert(ass.includes('\\\u2060N'));
  const result = await render(plan, '中文 字幕.mp4', { subtitleFontPath: font });
  assert.equal(result.width, 320); assert.equal(result.height, 180); assert(Math.abs(result.durationMs - 4000) < 84);
  const path = join(directory, '中文 字幕.mp4');
  const before = await rgb(path, 0.2), bottom = await rgb(path, 0.8), top = await rgb(path, 2.3), after = await rgb(path, 3.5);
  const white: number[] = [], green: number[] = [];
  for (let pixel = 0; pixel < 320 * 180; pixel += 1) {
    const offset = pixel * 3;
    if (bottom[offset]! > 160 && bottom[offset + 1]! > 160 && bottom[offset + 2]! > 160) white.push(Math.floor(pixel / 320));
    if (top[offset + 1]! > 120 && top[offset + 1]! > top[offset]! + 80 && top[offset + 1]! > top[offset + 2]! + 80) green.push(Math.floor(pixel / 320));
  }
  assert(white.length > 200, 'CJK/literal caption pixels must be present');
  assert(Math.min(...white) > 120, 'literal ASS override text must not move the caption to the top');
  assert(green.length > 100 && Math.max(...green) < 60, 'validated style should place green glyphs at the top');
  assert(before.every(byte => byte < 12) && after.every(byte => byte < 12), 'caption pixels must disappear outside their time ranges');
  assert(bottom.some((byte, index) => byte - before[index]! > 150), 'caption frame must differ from the no-caption frame');
});

test('real mixing preserves source sound, applies gain/offset/fades, and keeps the frozen duration', async () => {
  const plan = timeline(false);
  plan.audio = [{ artifactId: 'voice', startMs: 1000, sourceInMs: 500, durationMs: 2000, gainDb: -6.0206, fadeInMs: 500, fadeOutMs: 500 }];
  const result = await render(plan, '混音 gain and fades.mp4'); assert(Math.abs(result.durationMs - 4000) < 84);
  const output = await pcm(join(directory, '混音 gain and fades.mp4')), source = await pcm(files.get('voice')!.path);
  const plateau = amplitude(output, 440, 1.8), original = amplitude(source, 440, 1.8);
  assert(plateau / original > 0.46 && plateau / original < 0.54, `-6.0206dB should halve amplitude, got ${plateau / original}`);
  assert(amplitude(output, 220, 0.4) > 0.08 && amplitude(output, 220, 2) > 0.08, 'source track should remain audible');
  assert(amplitude(output, 440, 0.4) < 0.002 && amplitude(output, 440, 3.3) < 0.002, 'added audio should obey offset and end');
  const fadeIn = amplitude(output, 440, 1.05), fadeOut = amplitude(output, 440, 2.85);
  assert(fadeIn > plateau * 0.08 && fadeIn < plateau * 0.35, `fade-in amplitude ${fadeIn / plateau}`);
  assert(fadeOut > plateau * 0.08 && fadeOut < plateau * 0.35, `fade-out amplitude ${fadeOut / plateau}`);
});

test('omitted audio duration uses the available source remainder and invalid source ranges fail before publishing', async () => {
  const plan = timeline(); plan.audio = [{ artifactId: 'voice', startMs: 2000, sourceInMs: 4000, gainDb: 0 }];
  await render(plan, 'audio remainder.mp4');
  const output = await pcm(join(directory, 'audio remainder.mp4'));
  assert(amplitude(output, 440, 1.5) < 0.002); assert(amplitude(output, 440, 2.3) > 0.1); assert(amplitude(output, 440, 3.3) < 0.002);
  const invalid = { ...plan, audio: [{ ...plan.audio[0]!, durationMs: 1500 }] };
  await assert.rejects(render(invalid, 'audio out of range.mp4'), { code: 'INVALID_TIMELINE' });
  await assert.rejects(stat(join(directory, 'audio out of range.mp4')), { code: 'ENOENT' });
});

test('offline thumbnail extraction produces a real bounded PNG and protects existing outputs', async () => {
  const target = join(directory, "thumb % [x] ' 缩略图.png");
  const info = await extractThumbnail(files.get('black')!.path, target, { atMs: 500, width: 160, height: 100 });
  assert.equal(info.kind, 'image'); assert.equal(info.codec, 'png'); assert(info.width! <= 160 && info.height! <= 100);
  const saved = await readFile(target);
  await assert.rejects(extractThumbnail(files.get('black')!.path, target), { code: 'OUTPUT_EXISTS' });
  assert.deepEqual(await readFile(target), saved);
  await assert.rejects(extractThumbnail(files.get('black')!.path, join(directory, 'bad.png'), { atMs: 5000 }), { code: 'INVALID_THUMBNAIL' });
  await assert.rejects(extractThumbnail(files.get('voice')!.path, join(directory, 'audio.png')), { code: 'INVALID_THUMBNAIL' });
});
