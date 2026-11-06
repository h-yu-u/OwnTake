import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { iconPng } from '../apps/desktop/src/icon.ts';

const output = 'apps/desktop/dist';
await mkdir(output, { recursive: true });
const common = { bundle: true, platform: 'node', target: 'node24', external: ['electron'], sourcemap: false, logLevel: 'info' };
await Promise.all([
  build({ ...common, entryPoints: ['apps/desktop/src/main.ts'], outfile: `${output}/main.mjs`, format: 'esm' }),
  build({ ...common, entryPoints: ['apps/desktop/src/preload.ts'], outfile: `${output}/preload.cjs`, format: 'cjs' }),
  build({ ...common, entryPoints: ['apps/desktop/src/service.ts'], outfile: `${output}/service.mjs`, format: 'esm' }),
]);
await writeFile(`${output}/icon.png`, iconPng(1024));
