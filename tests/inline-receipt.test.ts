import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describeInline, findInlineReceipt, inlineReceiptPaths, writeInlineReceipt } from '../apps/server/src/inline-receipt.ts';

const bytes = Buffer.from('known received inline PNG bytes – 完整内容');
async function project(run: (root: string) => Promise<void>): Promise<void> {
  const temporary = await mkdtemp(join(tmpdir(), 'owntake-inline-')), namedRoot = join(temporary, "项目 ' [目录] & spaces");
  await mkdir(namedRoot); const root = await realpath(namedRoot);
  try { await run(root); } finally { await rm(temporary, { recursive: true, force: true }); }
}

test('inline receipt writes and finds exact bytes in special paths and reuses an identical completion', async () => {
  await project(async root => {
    const receipt = describeInline(bytes), paths = inlineReceiptPaths(root, 'output_1', 'attempt_1');
    assert.deepEqual(receipt, { sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length });
    assert.equal(paths.relativeComplete, 'assets/output_1/receipt-attempt_1.png');
    assert.equal(paths.relativePartial, 'assets/output_1/receipt-attempt_1.png.part');
    assert.equal(await findInlineReceipt(root, 'output_1', 'attempt_1', receipt), null);
    await writeInlineReceipt(root, 'output_1', 'attempt_1', receipt, bytes);
    assert.equal(await findInlineReceipt(root, 'output_1', 'attempt_1', receipt), paths.complete);
    assert.deepEqual(await readFile(paths.complete), bytes);
    assert.equal((await stat(paths.complete)).mode & 0o777, 0o600);
    await assert.rejects(lstat(paths.partial), { code: 'ENOENT' });
    const before = await stat(paths.complete);
    await writeInlineReceipt(root, 'output_1', 'attempt_1', receipt, bytes);
    assert.equal((await stat(paths.complete)).ino, before.ino, 'idempotency must reuse the existing file');
  });
});

test('incomplete or same-size incorrect parts are never mistaken for a full receipt or overwritten', async () => {
  await project(async root => {
    const receipt = describeInline(bytes), paths = inlineReceiptPaths(root, 'output_2', 'attempt_2');
    await mkdir(join(root, 'assets', 'output_2'), { recursive: true });
    for (const partial of [bytes.subarray(0, 8), Buffer.alloc(bytes.length, 1)]) {
      await writeFile(paths.partial, partial);
      assert.equal(await findInlineReceipt(root, 'output_2', 'attempt_2', receipt), null);
      await assert.rejects(writeInlineReceipt(root, 'output_2', 'attempt_2', receipt, bytes), { code: 'INLINE_RECEIPT_CONFLICT' });
      assert.deepEqual(await readFile(paths.partial), partial, 'failure must preserve the existing part');
      await assert.rejects(stat(paths.complete), { code: 'ENOENT' });
    }
  });
});

test('a full part is recoverable after interruption and can be safely promoted without another supplier call', async () => {
  await project(async root => {
    const receipt = describeInline(bytes), paths = inlineReceiptPaths(root, 'output_3', 'attempt_3');
    await mkdir(join(root, 'assets', 'output_3'), { recursive: true });
    await writeFile(paths.partial, bytes, { mode: 0o600 });
    assert.equal(await findInlineReceipt(root, 'output_3', 'attempt_3', receipt), paths.partial);
    await writeInlineReceipt(root, 'output_3', 'attempt_3', receipt, bytes);
    assert.equal(await findInlineReceipt(root, 'output_3', 'attempt_3', receipt), paths.complete);
    assert.deepEqual(await readFile(paths.complete), bytes);
  });
});

test('different completed content and receipt mismatches are preserved and rejected', async () => {
  await project(async root => {
    const receipt = describeInline(bytes), paths = inlineReceiptPaths(root, 'output_4', 'attempt_4'), other = Buffer.from('existing unrelated content');
    await mkdir(join(root, 'assets', 'output_4'), { recursive: true }); await writeFile(paths.complete, other);
    await assert.rejects(writeInlineReceipt(root, 'output_4', 'attempt_4', receipt, bytes), { code: 'INLINE_RECEIPT_CONFLICT' });
    assert.deepEqual(await readFile(paths.complete), other);
    await assert.rejects(writeInlineReceipt(root, 'output_5', 'attempt_5', receipt, other), { code: 'INLINE_RECEIPT_MISMATCH' });
    await assert.rejects(stat(join(root, 'assets', 'output_5')), { code: 'ENOENT' });
  });
});

test('receipt paths reject traversal and symlinks in directories, complete files and part files', async () => {
  await project(async root => {
    const receipt = describeInline(bytes);
    assert.throws(() => inlineReceiptPaths(root, '../escape', 'attempt'), { code: 'INVALID_RECEIPT_PATH' });
    assert.throws(() => inlineReceiptPaths(root, 'output', 'attempt/escape'), { code: 'INVALID_RECEIPT_PATH' });
    const outside = join(root, '..', 'outside'); await mkdir(outside); await writeFile(join(outside, 'secret.png'), bytes);
    const rootAlias = join(root, '..', 'project-alias'); await symlink(root, rootAlias);
    await assert.rejects(findInlineReceipt(rootAlias + '/', 'output', 'attempt', receipt), { code: 'INVALID_RECEIPT_PATH' });
    await symlink(outside, join(root, 'assets'));
    await assert.rejects(findInlineReceipt(root, 'output', 'attempt', receipt), { code: 'INVALID_RECEIPT_PATH' });
    await assert.rejects(writeInlineReceipt(root, 'output', 'attempt', receipt, bytes), { code: 'INVALID_RECEIPT_PATH' });
    await rm(join(root, 'assets')); await mkdir(join(root, 'assets', 'output'), { recursive: true });
    const paths = inlineReceiptPaths(root, 'output', 'attempt');
    for (const target of [paths.complete, paths.partial]) {
      await symlink(join(outside, 'secret.png'), target);
      await assert.rejects(findInlineReceipt(root, 'output', 'attempt', receipt), { code: 'INVALID_RECEIPT_PATH' });
      await assert.rejects(writeInlineReceipt(root, 'output', 'attempt', receipt, bytes), { code: 'INVALID_RECEIPT_PATH' });
      await rm(target);
    }
    assert.deepEqual(await readFile(join(outside, 'secret.png')), bytes);
  });
});
