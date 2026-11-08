import { appendFileSync } from 'node:fs';
import { TARGETS } from './targets.mjs';
const matrix = JSON.stringify({ include: TARGETS.map(({ id, platform, arch, runner }) => ({ id, platform, arch, runner })) });
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${matrix}\n`);
else console.log(matrix);
