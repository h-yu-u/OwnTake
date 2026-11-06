import { constants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, rm } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError, invariant } from '../../../packages/contracts/src/errors.ts';
import { extractThumbnail } from '../../../packages/media/src/index.ts';
import type { Store } from '../../../packages/storage/src/index.ts';
import { hashFile, resolveAsset } from './assets.ts';
/** A serial, deduplicated cache worker; thumbnails are reproducible and excluded from backups. */
export class ThumbnailService {
  private store: Store;
  private pending = new Map<string, Promise<string>>();
  private tail: Promise<unknown> = Promise.resolve();
  private controller = new AbortController();
  constructor(store: Store) { this.store = store; }
  get(id: string): Promise<string> {
    if (this.controller.signal.aborted) return Promise.reject(new AppError('SERVER_STOPPING', '缩略图服务正在停止', 503));
    const existing = this.pending.get(id); if (existing) return existing;
    const task = this.tail.catch(() => undefined).then(() => this.generate(id)); this.tail = task; this.pending.set(id, task);
    void task.then(() => this.pending.delete(id), () => this.pending.delete(id)); return task;
  }
  async read(id: string): Promise<Buffer> {
    const path = await this.get(id);
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await file.stat();
      invariant(info.isFile() && info.size > 8 && info.size <= 2 * 1024 * 1024, 'INVALID_THUMBNAIL', '缓存缩略图不是有效的 PNG 文件', 409);
      const bytes = await file.readFile();
      invariant(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'INVALID_THUMBNAIL', '缓存缩略图不是有效的 PNG 文件', 409);
      return bytes;
    } finally { await file.close(); }
  }
  private async cachedFile(cache: string, output: string): Promise<string | null> {
    let info;
    try { info = await lstat(output); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    invariant(!info.isSymbolicLink(), 'FORBIDDEN_PATH', '缓存缩略图不能是符号链接', 403);
    const actual = await realpath(output);
    invariant(actual.startsWith(cache + sep), 'FORBIDDEN_PATH', '缓存缩略图不能离开项目缓存目录', 403);
    invariant(info.isFile(), 'INVALID_THUMBNAIL', '缓存缩略图不是普通文件', 409);
    return actual;
  }
  private async generate(id: string): Promise<string> {
    invariant(!this.controller.signal.aborted, 'SERVER_STOPPING', '缩略图服务正在停止', 503);
    const { artifact, path } = await resolveAsset(this.store, id);
    invariant(artifact.kind === 'video', 'THUMBNAIL_UNSUPPORTED', '只有视频需要抽帧缩略图');
    const root = await realpath(this.store.getProjectDir(artifact.projectId)), cache = join(root, '.cache'); await mkdir(cache, { recursive: true, mode: 0o700 });
    const directory = await lstat(cache);
    invariant(directory.isDirectory() && !directory.isSymbolicLink() && await realpath(cache) === cache, 'FORBIDDEN_PATH', '缓存目录不能使用符号链接', 403);
    const output = join(cache, `${artifact.id}-${artifact.sha256.slice(0,16)}.png`), cached = await this.cachedFile(cache, output);
    if (cached) return cached;
    const work = join(cache, `thumb-${randomUUID()}`); await mkdir(work, { mode: 0o700 }); const temporary = join(work, 'frame.png');
    try {
      invariant(await hashFile(path, this.controller.signal) === artifact.sha256, 'ASSET_CHANGED', '源素材内容已改变，请恢复原文件', 409);
      await extractThumbnail(path, temporary, { ...this.store.getSettings(), atMs: Math.min(500, Math.floor(artifact.media.durationMs / 2)), width: 320, height: 180, signal: this.controller.signal });
      try { await link(temporary, output); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const published = await this.cachedFile(cache, output);
      invariant(published, 'INVALID_THUMBNAIL', '缩略图未能写入项目缓存', 409);
      return published;
    } finally { await rm(work, { recursive: true, force: true }); }
  }
  async stop(): Promise<void> { this.controller.abort(); await Promise.allSettled([...this.pending.values()]); }
}
