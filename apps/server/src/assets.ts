import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, sep } from 'node:path';
import type { Artifact } from '../../../packages/contracts/src/index.ts';
import { AppError, invariant } from '../../../packages/contracts/src/errors.ts';
import type { Store } from '../../../packages/storage/src/index.ts';

export async function hashFile(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
  return hash.digest('hex');
}

/** Resolve only registered assets; HTTP and background workers share this boundary. */
export async function resolveAsset(store: Store, artifactId: string): Promise<{ artifact: Artifact; path: string }> {
  const artifact = store.getArtifact(artifactId);
  const root = await realpath(store.getProjectDir(artifact.projectId));
  const path = resolve(root, artifact.relativePath);
  invariant(path.startsWith(root + sep), 'FORBIDDEN_PATH', '素材路径超出项目目录', 403);
  let canonical: string;
  try { canonical = await realpath(path); }
  catch { throw new AppError('ASSET_UNAVAILABLE', `素材「${artifact.name}」文件缺失，请重新关联`, 409); }
  invariant(canonical.startsWith(root + sep), 'FORBIDDEN_PATH', '素材路径不能通过符号链接离开项目', 403);
  const info = await stat(canonical);
  invariant(info.isFile(), 'ASSET_UNAVAILABLE', '素材不是可读取的文件', 409);
  invariant(info.size === artifact.sizeBytes, 'ASSET_CHANGED', '素材文件大小已改变，请恢复原文件', 409);
  return { artifact, path: canonical };
}
