import { copyFile, mkdir, open, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, join } from 'node:path';
import { AppError, invariant } from '../../contracts/src/errors.ts';
import { subtitleFamilyPattern } from '../../domain/src/validation.ts';

export interface FontHealth {
  available: boolean; path: string; sizeBytes?: number; family?: string;
  glyphCoverage: 'unchecked'; error?: string;
}

/** Reads family metadata only. This does not inspect the font's character coverage. */
async function fontFamily(path: string, size: number): Promise<string | undefined> {
  const file = await open(path, 'r');
  const read = async (position: number, length: number): Promise<Buffer> => {
    if (position < 0 || length < 0 || position + length > size || length > 1_048_576) throw new Error('Invalid font table');
    const data = Buffer.alloc(length); const result = await file.read(data, 0, length, position);
    if (result.bytesRead !== length) throw new Error('Truncated font');
    return data;
  };
  try {
    let header = await read(0, 16), offset = 0;
    if (header.toString('ascii', 0, 4) === 'ttcf') {
      if (header.readUInt32BE(8) < 1 || header.readUInt32BE(8) > 1000) return undefined;
      offset = header.readUInt32BE(12); header = await read(offset, 12);
    }
    if (![0x00010000, 0x4f54544f, 0x74727565].includes(header.readUInt32BE(0))) return undefined;
    const count = header.readUInt16BE(4);
    if (count < 1 || count > 4096) return undefined;
    const tables = await read(offset + 12, count * 16);
    for (let i = 0; i < count; i += 1) {
      const table = tables.subarray(i * 16, (i + 1) * 16);
      if (table.toString('ascii', 0, 4) !== 'name') continue;
      const names = await read(table.readUInt32BE(8), table.readUInt32BE(12));
      if (names.length < 6) return undefined;
      const entries = names.readUInt16BE(2), storage = names.readUInt16BE(4);
      const candidates: { value: string; score: number }[] = [];
      for (let j = 0; j < entries && 6 + (j + 1) * 12 <= names.length; j += 1) {
        const item = names.subarray(6 + j * 12, 18 + j * 12);
        const platform = item.readUInt16BE(0), language = item.readUInt16BE(4), nameId = item.readUInt16BE(6);
        if (![1, 16].includes(nameId) || ![0, 1, 3].includes(platform)) continue;
        const start = storage + item.readUInt16BE(10), length = item.readUInt16BE(8);
        if (start + length > names.length || length > 512 || (platform !== 1 && length % 2 !== 0)) continue;
        const bytes = Buffer.from(names.subarray(start, start + length));
        const value = (platform === 1 ? bytes.toString('latin1') : bytes.swap16().toString('utf16le')).trim();
        if (subtitleFamilyPattern.test(value)) candidates.push({ value, score: (nameId === 16 ? 10 : 0) + (language === 0x0409 ? 4 : 0) + (platform === 3 ? 2 : 0) });
      }
      return candidates.sort((a, b) => b.score - a.score)[0]?.value;
    }
    return undefined;
  } catch { return undefined; }
  finally { await file.close(); }
}

export async function fontHealth(path: string): Promise<FontHealth> {
  try {
    invariant(typeof path === 'string' && isAbsolute(path) && !path.includes('\0') && ['.ttf', '.otf', '.ttc'].includes(extname(path).toLowerCase()), 'INVALID_SUBTITLE_FONT', '请选择本机 TTF、OTF 或 TTC 字体的绝对路径。', 422);
    const canonical = await realpath(path), info = await stat(canonical);
    invariant(info.isFile() && info.size >= 16 && info.size <= 128 * 1024 * 1024, 'INVALID_SUBTITLE_FONT', '字幕字体必须是可读取、大小不超过 128 MiB 的普通文件。', 422);
    const file = await open(canonical, 'r'); let signature: Buffer;
    try { signature = Buffer.alloc(4); await file.read(signature, 0, 4, 0); } finally { await file.close(); }
    invariant([0x00010000, 0x4f54544f, 0x74746366, 0x74727565].includes(signature.readUInt32BE(0)), 'INVALID_SUBTITLE_FONT', '所选文件没有有效的字体文件头。', 422);
    const family = await fontFamily(canonical, info.size);
    return { available: true, path: canonical, sizeBytes: info.size, ...(family ? { family } : {}), glyphCoverage: 'unchecked' };
  } catch (error) {
    return { available: false, path, glyphCoverage: 'unchecked', error: error instanceof AppError ? error.message : '字体文件不存在或无法读取。' };
  }
}

export async function stageSubtitleFont(path: string | undefined, workDir: string): Promise<string> {
  await mkdir(join(workDir, 'fonts'), { mode: 0o700 });
  if (!path) return 'sans-serif';
  const health = await fontHealth(path);
  invariant(health.available, 'INVALID_SUBTITLE_FONT', health.error || '字幕字体不可用。', 422);
  // The filter sees only a fixed relative folder; user paths never become filter syntax.
  await copyFile(health.path, join(workDir, 'fonts', `selected${extname(health.path).toLowerCase()}`));
  return health.family ?? 'sans-serif';
}
