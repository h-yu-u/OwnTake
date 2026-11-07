import { createWriteStream } from 'node:fs';
import { link, mkdir, open, realpath, rename, rm, statfs } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Artifact } from '../../../../packages/contracts/src/index.ts';
import { AppError, invariant } from '../../../../packages/contracts/src/errors.ts';
import { probe } from '../../../../packages/media/src/index.ts';
import type { Store } from '../../../../packages/storage/src/index.ts';
import { hashFile, resolveAsset } from '../assets.ts';
import { MEDIA_UPLOAD } from '../config/media.ts';

/** Transport-independent input: HTTP, desktop or tests can provide a readable stream. */
export interface AssetUpload { stream: Readable; declaredLength?: number; signal?: AbortSignal }
interface ImportInput extends AssetUpload { projectId: string; filename: string; maxBytes: number }
interface RestoreInput extends AssetUpload { artifactId: string; maxBytes: number }

function checkLength(declaredLength: number | undefined, maxBytes: number): void {
  if (declaredLength === undefined) return;
  invariant(Number.isSafeInteger(declaredLength) && declaredLength >= 0, 'INVALID_CONTENT_LENGTH', '媒体文件长度不合法');
  invariant(declaredLength <= maxBytes, 'BODY_TOO_LARGE', '媒体文件过大', 413);
}

async function writeUpload(input: AssetUpload, path: string, maxBytes: number): Promise<number> {
  let size = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      callback(size > maxBytes ? new AppError('BODY_TOO_LARGE', '媒体文件过大', 413) : null, chunk);
    },
  });
  // Do not destroy the source on a limit error: the HTTP adapter must still send 413.
  // A disconnected source still rejects the iterator and the caller removes its work directory.
  await pipeline(input.stream.iterator({ destroyOnReturn: false }), limiter, createWriteStream(path, { flags: 'wx', mode: 0o600 }), { signal: input.signal });
  invariant(input.declaredLength === undefined || size === input.declaredLength, 'UPLOAD_INCOMPLETE', '媒体上传未完整接收');
  return size;
}

async function verifyHeader(path: string): Promise<void> {
  const file = await open(path, 'r');
  const bytes = Buffer.alloc(16);
  try { await file.read(bytes, 0, bytes.length, 0); }
  finally { await file.close(); }
  const prefix = bytes.toString('ascii');
  const known = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || bytes[0] === 0xff && (bytes[1] === 0xd8 || (bytes[1]! & 0xe0) === 0xe0)
    || prefix.startsWith('RIFF') || prefix.slice(4, 8) === 'ftyp'
    || bytes.subarray(0, 4).toString('hex') === '1a45dfa3'
    || ['OggS', 'fLaC', 'ID3'].some(value => prefix.startsWith(value));
  invariant(known, 'UNSUPPORTED_MEDIA', '文件头不符合支持的媒体格式；不支持播放列表或远端链接');
}

export async function importAsset(store: Store, input: ImportInput): Promise<Artifact> {
  const { projectId, maxBytes } = input;
  input.signal?.throwIfAborted();
  store.getProject(projectId);
  const name = basename(input.filename).slice(0, MEDIA_UPLOAD.filenameMaxLength);
  const extension = extname(name).toLowerCase();
  invariant(name && !name.includes('\0') && MEDIA_UPLOAD.extensions.includes(extension), 'UNSUPPORTED_MEDIA', '请选择支持的视频、图片或音频文件');
  checkLength(input.declaredLength, maxBytes);
  const id = randomUUID();
  const root = store.getProjectDir(projectId);
  const work = join(root, '.work', id);
  const disk = await statfs(root);
  invariant(disk.bavail * disk.bsize > Math.max(input.declaredLength ?? 0, MEDIA_UPLOAD.minimumFreeBytes), 'DISK_FULL', '项目磁盘剩余空间不足', 507);
  await mkdir(work, { recursive: true, mode: 0o700 });
  const temporary = join(work, `input${extension}`);
  try {
    const sizeBytes = await writeUpload(input, temporary, maxBytes);
    invariant(sizeBytes > 0, 'EMPTY_FILE', '不能导入空文件');
    await verifyHeader(temporary);
    const media = await probe(temporary, { ffprobePath: store.getSettings().ffprobePath, signal: input.signal });
    const sha256 = await hashFile(temporary, input.signal);
    input.signal?.throwIfAborted();
    const relativePath = `assets/${id}/original${extension}`;
    await mkdir(join(root, 'assets', id), { recursive: true });
    await rename(temporary, join(root, relativePath));
    return store.addArtifact({ id, projectId, name, kind: media.kind, relativePath, sizeBytes, sha256, media, source: 'import', metadata: {} });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export async function restoreAsset(store: Store, input: RestoreInput): Promise<Artifact> {
  const { artifactId, maxBytes } = input;
  input.signal?.throwIfAborted();
  const artifact = store.getArtifact(artifactId);
  const root = await realpath(store.getProjectDir(artifact.projectId));
  const target = resolve(root, artifact.relativePath);
  invariant(target.startsWith(root + sep), 'FORBIDDEN_PATH', '素材路径超出项目目录', 403);
  checkLength(input.declaredLength, maxBytes);
  const work = join(root, '.work', randomUUID());
  await mkdir(work, { recursive: true, mode: 0o700 });
  const temporary = join(work, 'restore');
  try {
    const size = await writeUpload(input, temporary, maxBytes);
    invariant(size === artifact.sizeBytes && await hashFile(temporary, input.signal) === artifact.sha256, 'RESTORE_HASH_MISMATCH', '文件内容与原素材不同。恢复需要选择完全相同的原文件；新版本请使用导入。', 422);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    invariant((await realpath(dirname(target))).startsWith(root + sep), 'FORBIDDEN_PATH', '素材目录不能通过符号链接离开项目', 403);
    input.signal?.throwIfAborted();
    try { await link(temporary, target); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const current = await resolveAsset(store, artifactId);
      invariant(await hashFile(current.path, input.signal) === artifact.sha256, 'RESTORE_TARGET_CHANGED', '目标位置已有不同内容，请先检查本地项目文件', 409);
    }
    store.appendEvent(artifact.projectId, 'artifact.restored', { artifactId });
    return artifact;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
