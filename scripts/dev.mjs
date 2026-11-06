import { spawn } from 'node:child_process';
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 1500).unref();
}
for (const [file, args] of [[process.execPath, ['--watch', 'apps/server/src/main.ts']], [process.execPath, ['node_modules/vite/bin/vite.js', '--config', 'apps/web/vite.config.ts']]]) {
  const child = spawn(file, args, { stdio: 'inherit', env: { ...process.env, OWNTAKE_DEV_ORIGIN: 'http://127.0.0.1:5173' } });
  children.push(child);
  child.on('error', () => stop(1));
  child.on('exit', code => stop(code ?? 0));
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
