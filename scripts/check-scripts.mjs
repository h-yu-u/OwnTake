import { execFileSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function scriptFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await scriptFiles(path));
    else if (entry.isFile() && /\.(?:mjs|cjs|js)$/.test(entry.name)) files.push(path);
  }
  return files;
}

// Parse every executable script without importing it or triggering its side effects.
const files = (await scriptFiles(join(root, 'scripts'))).sort();
for (const file of files) {
  try { execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }); }
  catch (error) {
    console.error(`[scripts] ${relative(root, file)} failed syntax validation`);
    if (error.stderr) process.stderr.write(error.stderr);
    process.exitCode = 1;
  }
}
if (!process.exitCode) console.log(`[scripts] ${files.length} JavaScript entry points and helpers passed syntax validation`);
