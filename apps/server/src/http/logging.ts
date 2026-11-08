import type { FastifyRequest, FastifyServerOptions } from 'fastify';
import type { ServerConfig } from '../config.ts';

/** Allowlist log metadata: no raw URLs, query strings, bodies, cookies or provider errors. */
export function loggerOptions(config: ServerConfig): FastifyServerOptions['logger'] {
  if (config.logLevel === 'silent') return false;
  return {
    level: config.logLevel,
    redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-csrf-token"]'],
    serializers: {
      req(request: FastifyRequest) {
        return { method: request.method, route: request.routeOptions?.url };
      },
      res(reply: { statusCode: number }) {
        return { statusCode: reply.statusCode };
      },
      err(error: Error & { code?: string }) {
        return { type: error.name, code: error.code, message: 'Local operation failed', stack: '' };
      },
    },
  };
}
