import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { supportsAssFilter, renderFfmpegCandidates, resolveRenderFfmpeg, ffmpegHealth } from '../packages/media/src/capabilities.ts';
import { renderTimeline } from '../packages/media/src/render.ts';

test('subtitle discovery requires the exact video filter and only defaults discover Homebrew alternatives', () => {
  assert(supportsAssFilter(' ... ass               V->V       Render ASS subtitles.'));
  assert(supportsAssFilter(' .. ass V->V Render ASS'));
  for (const output of ['TS allpass A->A pass', 'ass support was not built', '... subtitles V->V Render subtitles', '... ass A->A wrong kind']) assert.equal(supportsAssFilter(output), false);
  assert.equal(renderFfmpegCandidates('ffmpeg', 'darwin').length, 3);
  assert.deepEqual(renderFfmpegCandidates('/custom/ffmpeg', 'darwin'), ['/custom/ffmpeg']);
  assert.deepEqual(renderFfmpegCandidates('ffmpeg', 'linux'), ['ffmpeg']);
});

test('missing subtitles fail before reading inputs or creating output, while a real declared filter is usable', { skip: process.platform === 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'owntake-capabilities-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const minimal = join(root, 'minimal-ffmpeg'), complete = join(root, 'complete-ffmpeg'), calls = join(root, 'calls');
  for (const [path, filters] of [[minimal, ' ... scale V->V Scale'], [complete, ' ... ass V->V Render ASS']]) {
    await writeFile(path!, `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';\nappendFileSync(${JSON.stringify(calls)},process.argv.slice(2).join(' ')+'\\n');\nconsole.log(process.argv.includes('-filters')?${JSON.stringify(filters)}:'ffmpeg version fixture');\n`, { mode: 0o700 });
  }
  assert.equal(await resolveRenderFfmpeg(minimal, false), await realpath(minimal));
  await assert.rejects(resolveRenderFfmpeg(minimal, true), { code: 'FFMPEG_SUBTITLES_UNAVAILABLE' });
  const health = await ffmpegHealth(minimal);
  assert.equal(health.available, true); assert.equal(health.capabilities?.subtitles, false); assert.match(health.error!, /libass/);
  assert.equal(await resolveRenderFfmpeg(complete, true), await realpath(complete));
  let resolved = 0;
  await assert.rejects(renderTimeline({
    timeline: { width: 160, height: 90, fps: 24, clips: [{ artifactId: 'unused', sourceInMs: 0, durationMs: 1000, fit: 'contain', muteSource: true }], audio: [], captions: [{ startMs: 0, endMs: 1000, text: '字幕' }] },
    resolveArtifact: () => { resolved++; throw new Error('Input must not be opened'); }, ffmpegPath: minimal, outputPath: join(root, 'out.mp4'), workDir: join(root, 'work'),
  }), { code: 'FFMPEG_SUBTITLES_UNAVAILABLE' });
  assert.equal(resolved, 0); await assert.rejects(stat(join(root, 'out.mp4')), { code: 'ENOENT' });
  assert((await readFile(calls, 'utf8')).split('\n').filter(Boolean).every(line => line === '-hide_banner -filters' || line === '-version'));
});
