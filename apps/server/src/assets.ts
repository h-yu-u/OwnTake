import { createReadStream, createWriteStream } from 'node:fs';
import { link, mkdir, open, realpath, rename, rm, stat, statfs } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Artifact } from '../../../packages/contracts/src/index.ts';
import { AppError, invariant } from '../../../packages/contracts/src/errors.ts';
import { probe } from '../../../packages/media/src/index.ts';
import type { Store } from '../../../packages/storage/src/index.ts';
const allowed = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.png', '.jpg', '.jpeg', '.webp', '.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac']);
export async function hashFile(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256'); for await (const chunk of createReadStream(path, { signal })) hash.update(chunk); return hash.digest('hex');
}
async function verifyHeader(path: string): Promise<void> {
  const file = await open(path, 'r'); const bytes = Buffer.alloc(16);
  try { await file.read(bytes, 0, bytes.length, 0); } finally { await file.close(); }
  const prefix = bytes.toString('ascii');
  const known = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes[0] === 0xff && (bytes[1] === 0xd8 || (bytes[1]! & 0xe0) === 0xe0) || prefix.startsWith('RIFF') || prefix.slice(4, 8) === 'ftyp' || bytes.subarray(0, 4).toString('hex') === '1a45dfa3' || ['OggS', 'fLaC', 'ID3'].some(p => prefix.startsWith(p));
  invariant(known, 'UNSUPPORTED_MEDIA', '文件头不符合支持的媒体格式；不支持播放列表或远端链接');
}
export async function resolveAsset(store: Store, artifactId: string): Promise<{ artifact: Artifact; path: string }> {
  const artifact = store.getArtifact(artifactId);
  const root = await realpath(store.getProjectDir(artifact.projectId));
  const path = resolve(root, artifact.relativePath);
  invariant(path.startsWith(root + sep), 'FORBIDDEN_PATH', '素材路径超出项目目录', 403);
  let canonical: string;
  try { canonical = await realpath(path); } catch { throw new AppError('ASSET_UNAVAILABLE', `素材「${artifact.name}」文件缺失，请重新关联`, 409); }
  invariant(canonical.startsWith(root + sep), 'FORBIDDEN_PATH', '素材路径不能通过符号链接离开项目', 403);
  const info = await stat(canonical); invariant(info.isFile(), 'ASSET_UNAVAILABLE', '素材不是可读取的文件', 409);
  invariant(info.size === artifact.sizeBytes, 'ASSET_CHANGED', '素材文件大小已改变，请恢复原文件', 409);
  return { artifact, path: canonical };
}
export async function importAsset(store: Store, request: IncomingMessage, projectId: string, filename: string, maxBytes: number): Promise<Artifact> {
  store.getProject(projectId);
  const name = basename(filename).slice(0, 200), extension = extname(name).toLowerCase();
  invariant(name && !name.includes('\0') && allowed.has(extension), 'UNSUPPORTED_MEDIA', '请选择支持的视频、图片或音频文件');
  const declared = Number(request.headers['content-length'] || 0); invariant(declared <= maxBytes, 'BODY_TOO_LARGE', '单个媒体文件不能超过 256 MiB', 413);
  const id = randomUUID(), root = store.getProjectDir(projectId), work = join(root, '.work', id);
  const disk = await statfs(root);
  invariant(disk.bavail * disk.bsize > Math.max(declared, 1048576), 'DISK_FULL', '项目磁盘剩余空间不足', 507);
  await mkdir(work, { recursive: true, mode: 0o700 }); const temp = join(work, `input${extension}`);
  let size = 0;
  try {
    const limiter = new Transform({ transform(chunk: Buffer, _encoding, callback) { size += chunk.length; callback(size > maxBytes ? new AppError('BODY_TOO_LARGE', '媒体文件过大', 413) : null, chunk); } });
    await pipeline(request, limiter, createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
    invariant(size > 0, 'EMPTY_FILE', '不能导入空文件'); await verifyHeader(temp);
    const media = await probe(temp, { ffprobePath: store.getSettings().ffprobePath });
    const sha256 = await hashFile(temp); const relativePath = `assets/${id}/original${extension}`;
    await mkdir(join(root, 'assets', id), { recursive: true }); await rename(temp, join(root, relativePath));
    return store.addArtifact({ id, projectId, name, kind: media.kind, relativePath, sizeBytes: size, sha256, media, source: 'import', metadata: {} });
  } finally { await rm(work, { recursive: true, force: true }); }
}
export async function restoreAsset(store: Store, request: IncomingMessage, artifactId: string, maxBytes: number): Promise<Artifact> {
  const artifact = store.getArtifact(artifactId);
  const root = await realpath(store.getProjectDir(artifact.projectId));
  const target = resolve(root, artifact.relativePath);
  invariant(target.startsWith(root + sep), 'FORBIDDEN_PATH', '素材路径超出项目目录', 403);
  const declared = Number(request.headers['content-length'] || 0);
  invariant(declared <= maxBytes, 'BODY_TOO_LARGE', '媒体文件过大', 413);
  const work = join(root, '.work', randomUUID()); await mkdir(work, { recursive: true, mode: 0o700 });
  const temp = join(work, 'restore'); let size = 0;
  try {
    const limiter = new Transform({ transform(chunk: Buffer, _encoding, callback) { size += chunk.length; callback(size > maxBytes ? new AppError('BODY_TOO_LARGE', '媒体文件过大', 413) : null, chunk); } });
    await pipeline(request, limiter, createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
    invariant(size === artifact.sizeBytes && await hashFile(temp) === artifact.sha256, 'RESTORE_HASH_MISMATCH', '文件内容与原素材不同。恢复需要选择完全相同的原文件；新版本请使用导入。', 422);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    invariant((await realpath(dirname(target))).startsWith(root + sep), 'FORBIDDEN_PATH', '素材目录不能通过符号链接离开项目', 403);
    try { await link(temp, target); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const current = await resolveAsset(store, artifactId);
      invariant(await hashFile(current.path) === artifact.sha256, 'RESTORE_TARGET_CHANGED', '目标位置已有不同内容，请先检查本地项目文件', 409);
    }
    store.appendEvent(artifact.projectId, 'artifact.restored', { artifactId });
    return artifact;
  } finally { await rm(work, { recursive: true, force: true }); }
}
export async function sendAsset(store: Store, id: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const { artifact, path } = await resolveAsset(store, id); const size = (await stat(path)).size;
  const mime: Record<string, string> = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.flac': 'audio/flac' };
  response.setHeader('Content-Type', mime[extname(path)] || 'application/octet-stream'); response.setHeader('Accept-Ranges', 'bytes');
  response.setHeader('Cache-Control', 'private, max-age=3600'); response.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(artifact.name)}`);
  let start = 0, end = size - 1;
  if (request.headers.range) {
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
    if (!range || !range[1] && !range[2]) { response.writeHead(416, { 'Content-Range': `bytes */${size}` }); response.end(); return; }
    if (range[1]) { start = Number(range[1]); end = range[2] ? Math.min(Number(range[2]), end) : end; }
    else start = Math.max(0, size - Number(range[2]));
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) { response.writeHead(416, { 'Content-Range': `bytes */${size}` }); response.end(); return; }
    response.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
  } else response.writeHead(200, { 'Content-Length': size });
  if (request.method === 'HEAD') { response.end(); return; }
  await pipeline(createReadStream(path, { start, end }), response).catch(() => undefined);
}
