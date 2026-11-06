import { constants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { invariant } from '../../../packages/contracts/src/errors.ts';

export type InlineReceipt = { sha256: string; sizeBytes: number };
export interface InlineReceiptPaths { complete: string; partial: string; relativeComplete: string; relativePartial: string }
const maximum = 32 * 1024 * 1024;
const idPattern = /^[A-Za-z0-9_-]{1,128}$/;

/** Integrity metadata only; the provider/probe boundaries validate the PNG format. */
export function describeInline(bytes: Uint8Array): InlineReceipt {
  invariant(bytes instanceof Uint8Array && bytes.byteLength > 0 && bytes.byteLength <= maximum, 'INVALID_INLINE_RECEIPT', '接收图片必须是非空、大小不超过 32 MiB 的字节数组。');
  return { sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.byteLength };
}
function validateReceipt(value: InlineReceipt): void {
  invariant(value && typeof value === 'object' && Object.keys(value).every(key => key === 'sha256' || key === 'sizeBytes') && typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256) && Number.isSafeInteger(value.sizeBytes) && value.sizeBytes > 0 && value.sizeBytes <= maximum, 'INVALID_INLINE_RECEIPT', '图片接收摘要无效。');
}
export function inlineReceiptPaths(projectRoot: string, outputArtifactId: string, attemptId: string): InlineReceiptPaths {
  invariant(typeof projectRoot === 'string' && isAbsolute(projectRoot) && !projectRoot.includes('\0'), 'INVALID_RECEIPT_PATH', '接收目录必须是本机项目的绝对路径。', 403);
  invariant(typeof outputArtifactId === 'string' && idPattern.test(outputArtifactId) && typeof attemptId === 'string' && idPattern.test(attemptId), 'INVALID_RECEIPT_PATH', '图片接收标识无效。', 403);
  const relativeComplete = `assets/${outputArtifactId}/receipt-${attemptId}.png`, relativePartial = `${relativeComplete}.part`;
  return { complete: resolve(projectRoot, relativeComplete), partial: resolve(projectRoot, relativePartial), relativeComplete, relativePartial };
}

/** Reject symlinks in every managed path component; OS aliases above the project are canonicalised. */
async function checkedPaths(root: string, outputId: string, attemptId: string, create: boolean): Promise<InlineReceiptPaths | null> {
  inlineReceiptPaths(root, outputId, attemptId);
  root = resolve(root);
  const rootInfo = await lstat(root);
  invariant(rootInfo.isDirectory() && !rootInfo.isSymbolicLink(), 'INVALID_RECEIPT_PATH', '项目接收目录不能是符号链接或普通文件。', 403);
  const canonicalRoot = await realpath(root);
  for (const path of [join(canonicalRoot, 'assets'), join(canonicalRoot, 'assets', outputId)]) {
    if (create) {
      try { await mkdir(path, { mode: 0o700 }); await syncDirectory(dirname(path)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    let info;
    try { info = await lstat(path); }
    catch (error) { if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    invariant(info.isDirectory() && !info.isSymbolicLink() && await realpath(path) === path, 'INVALID_RECEIPT_PATH', '图片接收路径不能通过符号链接离开受管目录。', 403);
  }
  return inlineReceiptPaths(canonicalRoot, outputId, attemptId);
}

/** null means absent; false means present but incomplete/different. Both preserve the file. */
async function matches(path: string, receipt: InlineReceipt): Promise<boolean | null> {
  let info;
  try { info = await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  invariant(info.isFile() && !info.isSymbolicLink() && await realpath(path) === path, 'INVALID_RECEIPT_PATH', '图片接收文件不能是符号链接或特殊文件。', 403);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await file.stat();
    invariant(opened.isFile(), 'INVALID_RECEIPT_PATH', '图片接收目标不是普通文件。', 403);
    if (opened.size !== receipt.sizeBytes) return false;
    const hash = createHash('sha256'), buffer = Buffer.alloc(Math.min(65_536, receipt.sizeBytes));
    let position = 0;
    while (position < receipt.sizeBytes) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, receipt.sizeBytes - position), position);
      if (!bytesRead) return false;
      hash.update(buffer.subarray(0, bytesRead)); position += bytesRead;
    }
    return (await file.stat()).size === receipt.sizeBytes && hash.digest('hex') === receipt.sha256;
  } finally { await file.close(); }
}

export async function findInlineReceipt(projectRoot: string, outputArtifactId: string, attemptId: string, receipt: InlineReceipt): Promise<string | null> {
  validateReceipt(receipt);
  const paths = await checkedPaths(projectRoot, outputArtifactId, attemptId, false);
  if (!paths) return null;
  if (await matches(paths.complete, receipt)) return paths.complete;
  if (await matches(paths.partial, receipt)) return paths.partial;
  // A concurrent idempotent writer may have promoted the part during this lookup.
  return await matches(paths.complete, receipt) ? paths.complete : null;
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY);
  try { await directory.sync(); }
  finally { await directory.close(); }
}
async function publish(paths: InlineReceiptPaths, receipt: InlineReceipt): Promise<void> {
  // rename() overwrites on POSIX. A hard link atomically publishes without replacement;
  // only after the complete name is durable may the recoverable part name be removed.
  try { await link(paths.partial, paths.complete); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && await matches(paths.complete, receipt)) return;
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    invariant(await matches(paths.complete, receipt), 'INLINE_RECEIPT_CONFLICT', '已存在不同的完整接收文件，不能覆盖。', 409);
  }
  await syncDirectory(dirname(paths.complete));
  try { await unlink(paths.partial); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await syncDirectory(dirname(paths.complete));
}

export async function writeInlineReceipt(projectRoot: string, outputArtifactId: string, attemptId: string, receipt: InlineReceipt, bytes: Uint8Array): Promise<void> {
  validateReceipt(receipt);
  invariant(bytes instanceof Uint8Array && bytes.byteLength === receipt.sizeBytes, 'INLINE_RECEIPT_MISMATCH', '收到的图片字节大小与接收摘要不一致。', 409);
  const immutable = Buffer.from(bytes), actual = describeInline(immutable);
  invariant(actual.sha256 === receipt.sha256 && actual.sizeBytes === receipt.sizeBytes, 'INLINE_RECEIPT_MISMATCH', '收到的图片字节与持久化接收摘要不一致。', 409);
  const paths = (await checkedPaths(projectRoot, outputArtifactId, attemptId, true))!;
  const complete = await matches(paths.complete, receipt);
  if (complete === true) return;
  invariant(complete === null, 'INLINE_RECEIPT_CONFLICT', '已存在不同的完整接收文件，不能覆盖。', 409);
  let file;
  try { file = await open(paths.partial, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    invariant(await matches(paths.partial, receipt), 'INLINE_RECEIPT_CONFLICT', '已有部分接收文件尚未完整或内容不同；已保留原文件，不能覆盖。', 409);
    const existing = await open(paths.partial, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await existing.sync(); } finally { await existing.close(); }
    await publish(paths, receipt); return;
  }
  try { await file.writeFile(immutable); await file.sync(); }
  finally { await file.close(); }
  await syncDirectory(dirname(paths.partial));
  // No failure path removes the part: complete bytes remain recoverable if publish fails.
  const stillSafe = await checkedPaths(projectRoot, outputArtifactId, attemptId, false);
  invariant(stillSafe?.partial === paths.partial && await matches(paths.partial, receipt), 'INLINE_RECEIPT_MISMATCH', '接收文件在写入期间发生变化，已保留待检查文件。', 409);
  await publish(paths, receipt);
}
