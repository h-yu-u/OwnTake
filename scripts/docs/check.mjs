import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const OWNER_DOCS = Object.freeze([
  'AGENTS.md', 'LESSONS.md', 'README.md', 'README.zh-CN.md',
  'docs/README.md', 'docs/architecture.md', 'docs/code-standards.md',
  'docs/subsystems/README.md', 'docs/subsystems/http-lifecycle.md',
  'docs/subsystems/storage.md', 'docs/subsystems/stories-storyboard.md',
  'docs/subsystems/providers-generation.md', 'docs/subsystems/media-studio.md',
  'docs/subsystems/frontend.md', 'docs/subsystems/desktop.md',
  'docs/development/README.md', 'docs/operations/data-and-configuration.md',
  'docs/operations/release.md', 'docs/history/README.md', '.github/PULL_REQUEST_TEMPLATE.md',
]);
/** Repository Markdown subset: inline relative links; fenced examples are not links. */
export function relativeLinks(markdown) {
  const text = markdown.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\s*$/gm, '');
  return [...text.matchAll(/\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)]
    .map(match => match[1]).filter(href => !/^[a-z][a-z0-9+.-]*:/i.test(href));
}
export async function checkDocumentation(root, files = OWNER_DOCS) {
  const base = await realpath(root), errors = [];
  for (const path of files) {
    let content;
    try { content = await readFile(resolve(base, path), 'utf8'); }
    catch { errors.push(`${path}: missing maintained document`); continue; }
    if (!/^# .+/m.test(content)) errors.push(`${path}: missing title`);
    for (const href of relativeLinks(content)) {
      const fragmentless = href.split('#')[0].split('?')[0];
      if (!fragmentless) continue;
      let target;
      try { target = resolve(dirname(resolve(base,path)),decodeURIComponent(fragmentless)); }
      catch { errors.push(`${path}: invalid link ${href}`); continue; }
      const rel = relative(base,target);
      if (isAbsolute(fragmentless) || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) {
        errors.push(`${path}: escaping link ${href}`); continue;
      }
      try {
        const actual = await realpath(target), actualRel = relative(base, actual);
        if (actualRel === '..' || actualRel.startsWith('../') || actualRel.startsWith('..\\') || isAbsolute(actualRel)) throw new Error('escape');
        const info = await lstat(target);
        if (!info.isFile() && !info.isDirectory()) throw new Error('not a resource');
      } catch { errors.push(`${path}: unresolved relative link ${href}`); }
    }
  }
  return errors;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const errors = await checkDocumentation(root);
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
  else console.log(`[docs] ${OWNER_DOCS.length} maintained documents: relative file links verified (anchors/external URLs are not fetched)`);
}
