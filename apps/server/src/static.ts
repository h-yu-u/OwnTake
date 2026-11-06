import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AppError } from '../../../packages/contracts/src/errors.ts';
export async function serveStatic(request: IncomingMessage, response: ServerResponse, webDir: string, pathname: string): Promise<void> {
  if (!['GET', 'HEAD'].includes(request.method || '')) throw new AppError('NOT_FOUND', '资源不存在', 404);
  let root: string; try { root = await realpath(webDir); } catch { throw new AppError('WEB_NOT_BUILT', '请先执行 npm run build，或使用 npm run dev', 503); }
  let path = resolve(root, '.' + decodeURIComponent(pathname));
  if (path !== root && !path.startsWith(root + sep)) throw new AppError('FORBIDDEN_PATH', '不允许访问该路径', 403);
  try { const info = await stat(path); if (!info.isFile()) path = resolve(root, 'index.html'); } catch { path = resolve(root, 'index.html'); }
  const canonical = await realpath(path);
  if (!canonical.startsWith(root + sep)) throw new AppError('FORBIDDEN_PATH', '不允许访问该路径', 403);
  const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
  response.writeHead(200, { 'Content-Type': mime[extname(path)] || 'application/octet-stream', 'Cache-Control': extname(path) === '.html' ? 'no-cache' : 'public, max-age=3600' });
  if (request.method === 'HEAD') { response.end(); return; }
  await pipeline(createReadStream(canonical), response).catch(() => undefined);
}
