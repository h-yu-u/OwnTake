/** CI dependency only; this font is never redistributed inside OwnTake. */
import { createHash } from 'node:crypto';
import { appendFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const font = {
  url: 'https://raw.githubusercontent.com/notofonts/noto-cjk/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf',
  sha256: '2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b',
};
const response = await fetch(font.url, { signal: AbortSignal.timeout(120_000) });
if (!response.ok || !response.body) throw new Error(`Could not download the pinned test font: ${response.status}`);
const parts = [];
let size = 0;
for await (const part of response.body) {
  size += part.length;
  if (size > 32 * 1024 * 1024) throw new Error('Test font exceeds size limit');
  parts.push(part);
}
const bytes = Buffer.concat(parts);
if (createHash('sha256').update(bytes).digest('hex') !== font.sha256) throw new Error('Test font checksum mismatch');
const path = join(process.env.RUNNER_TEMP || tmpdir(), 'OwnTake-NotoSansCJKsc-Regular.otf');
await writeFile(path, bytes);
if (process.env.GITHUB_ENV) await appendFile(process.env.GITHUB_ENV, `OWNTAKE_TEST_FONT=${path}\n`);
console.log('Pinned CJK test font verified');
