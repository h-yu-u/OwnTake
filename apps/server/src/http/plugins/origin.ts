import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import { AppError } from '../../../../../packages/contracts/src/errors.ts';
import type { ServerConfig } from '../../config.ts';

/** Browser-origin policy is independent of cookies and applies to static files too. */
export function registerOriginPolicy(app: FastifyInstance, config: ServerConfig): void {
  app.addHook('onRequest', async request => {
    const port = (app.server.address() as AddressInfo | null)?.port ?? config.port;
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!hosts.includes(request.headers.host || '')) {
      throw new AppError('FORBIDDEN_HOST', '仅允许本机访问', 403);
    }
    const origins = hosts.map(host => `http://${host}`);
    if (config.devOrigin) origins.push(config.devOrigin);
    const origin = request.headers.origin;
    if (origin && !origins.includes(origin)) {
      throw new AppError('FORBIDDEN_ORIGIN', '来源未授权', 403);
    }
    if (request.headers['sec-fetch-site'] === 'cross-site') {
      throw new AppError('FORBIDDEN_ORIGIN', '拒绝跨站请求', 403);
    }
  });
}
