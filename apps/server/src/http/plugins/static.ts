import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { realpath, stat } from 'node:fs/promises';
import { extname, join, sep } from 'node:path';
import { AppError, invariant } from '../../../../../packages/contracts/src/errors.ts';
import type { ServerConfig } from '../../config.ts';
import { HTTP_CACHE, HTTP_POLICY } from '../../config/http.ts';

function isApiPath(url: string): boolean {
  const path = decodeURIComponent(url.split('?')[0]!);
  return path === HTTP_POLICY.apiPrefix || path.startsWith(HTTP_POLICY.apiPrefix + '/');
}

async function webRoot(webDir: string): Promise<string> {
  try { return await realpath(webDir); }
  catch { throw new AppError('WEB_NOT_BUILT', '请先执行 npm run build，或使用 npm run dev', 503); }
}

async function assertWebFile(path: string, webDir: string): Promise<void> {
  const root = await webRoot(webDir);
  const canonical = await realpath(path);
  invariant(canonical.startsWith(root + sep), 'FORBIDDEN_PATH', '静态资源不能通过符号链接离开网页目录', 403);
}

export async function registerStaticFiles(app: FastifyInstance, config: ServerConfig): Promise<void> {
  // The shared decorator sends only explicitly resolved files. No project directory is mounted.
  await app.register(fastifyStatic, { serve: false, cacheControl: false, dotfiles: 'deny', index: false });
  await app.register(async web => {
    await web.register(fastifyStatic, {
      root: config.webDir,
      serve: true,
      decorateReply: false,
      dotfiles: 'deny',
      suppressWarning: true,
      cacheControl: false,
      allowedPath: (_path, _root, request) => !isApiPath(request.url),
      onFile: path => assertWebFile(path, config.webDir),
      setHeaders: (reply, path) => {
        reply.header('Cache-Control', extname(path) === '.html' ? HTTP_CACHE.staticHtml : HTTP_CACHE.staticAssets);
      },
    });
    web.setNotFoundHandler(async (request, reply) => {
      if (!['GET', 'HEAD'].includes(request.method) || isApiPath(request.url)) {
        throw new AppError('NOT_FOUND', '资源不存在', 404);
      }
      const root = await webRoot(config.webDir);
      const index = join(root, 'index.html');
      let info;
      try { info = await stat(index); }
      catch { throw new AppError('WEB_NOT_BUILT', '网页入口不存在，请执行 npm run build', 503); }
      invariant(info.isFile(), 'WEB_NOT_BUILT', '网页入口不存在，请执行 npm run build', 503);
      await assertWebFile(index, config.webDir);
      return reply.header('Cache-Control', HTTP_CACHE.staticHtml).sendFile('index.html', root, {
        cacheControl: false, onFile: path => assertWebFile(path, config.webDir),
      });
    });
  });
}
