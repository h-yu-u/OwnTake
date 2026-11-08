import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkDocumentation, relativeLinks } from './check.mjs';

test('Markdown checker ignores fenced examples and external URLs, not local references', () => {
  const text = '# Title\n[local](docs/owner.md)\n[external](https://example.com)\n```md\n[not-a-link](missing.md)\n```\n';
  assert.deepEqual(relativeLinks(text), ['docs/owner.md']);
});
test('maintained document missing links and repository escapes are errors', async t => {
  const root = await mkdtemp(join(tmpdir(),'owntake-docs-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  await mkdir(join(root,'docs'));
  await writeFile(join(root,'README.md'),'# Intro\n[owner](docs/owner.md)\n');
  await writeFile(join(root,'docs','owner.md'),'# Owner\n[source](../README.md)\n');
  assert.deepEqual(await checkDocumentation(root,['README.md','docs/owner.md']),[]);
  await writeFile(join(root,'README.md'),'# Intro\n[missing](not-here.md)\n[escape](../secret)\n');
  const errors = await checkDocumentation(root,['README.md']);
  assert.equal(errors.length,2);
  assert.ok(errors.some(value=>value.includes('unresolved')));
  assert.ok(errors.some(value=>value.includes('escaping')));
});
