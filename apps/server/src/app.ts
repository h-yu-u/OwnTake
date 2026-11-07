import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { AppError } from '../../../packages/contracts/src/errors.ts';
import type { ApplicationContext } from './application/context.ts';
import { createCore } from './bootstrap/core.ts';
import { serverConfig } from './config.ts';
import type { ServerConfig } from './config.ts';
import { HTTP_CACHE, HTTP_POLICY } from './config/http.ts';
import { loggerOptions } from './http/logging.ts';
import { registerErrorHandler } from './http/plugins/errors.ts';
import { trackHandlers } from './http/plugins/lifecycle.ts';
import { registerOriginPolicy } from './http/plugins/origin.ts';
import { bootstrapSession, protectApi, registerSecurity } from './http/plugins/security.ts';
import { registerStaticFiles } from './http/plugins/static.ts';
import { registerApplicationRoutes } from './http/routes/index.ts';
import { registerMediaRoutes } from './http/routes/media.ts';
import { registerEventRoutes } from './http/routes/events.ts';

declare module 'fastify' {
  interface FastifyInstance {
    ownTake: ApplicationContext;
    ownTakeConfig: ServerConfig;
  }
}

async function createApplication(overrides: Partial<ServerConfig>) {
  const config = serverConfig(overrides);
  const core = await createCore(config);
  let app: FastifyInstance | undefined;
  try {
    app = Fastify({
      bodyLimit: HTTP_POLICY.jsonBodyLimit,
      requestTimeout: HTTP_POLICY.requestTimeoutMs,
      forceCloseConnections: true,
      logger: loggerOptions(config),
      genReqId: () => randomUUID(),
      requestIdHeader: false,
      exposeHeadRoutes: false,
      ajv: { customOptions: { coerceTypes: false, useDefaults: false, removeAdditional: false } },
    });
    app.server.headersTimeout = HTTP_POLICY.headersTimeoutMs;
    app.removeContentTypeParser('text/plain');
    app.decorate('ownTake', core.context);
    app.decorate('ownTakeConfig', config);
    const drainHandlers = trackHandlers(app);
    app.addHook('onRequest', async (request, reply) => {
      reply.header(HTTP_POLICY.requestIdHeader, request.id);
    });
    registerErrorHandler(app);
    registerOriginPolicy(app, config);
    app.addHook('preClose', async () => {
      try { await core.stop(); }
      catch (error) { app!.log.error({ err: error }, 'Local workers could not stop cleanly'); }
    });
    app.addHook('onClose', async () => {
      await drainHandlers();
      await core.dispose();
    });

    // Registration remains lazy: callers can add test plugins before ready()/inject().
    app.register(async transport => {
      await registerSecurity(transport);
      await registerStaticFiles(transport, config);
      transport.register(async api => {
        api.addHook('onRequest', async (_request, reply) => {
          reply.header('Cache-Control', HTTP_CACHE.api);
        });
        protectApi(api);
        api.get('/session', { config: { sessionBootstrap: true } }, bootstrapSession);
        api.setNotFoundHandler(() => { throw new AppError('NOT_FOUND', '接口不存在', 404); });
        await registerApplicationRoutes(api, core.context, config);
        await registerMediaRoutes(api, core.context, config);
        await registerEventRoutes(api, core.context, config);
        // Explicit API fallbacks outrank the web asset wildcard and inherit auth.
        const missing = () => { throw new AppError('NOT_FOUND', '接口不存在', 404); };
        api.all('/', missing);
        api.all('/*', missing);
      }, { prefix: HTTP_POLICY.apiPrefix });
    });
    return { app, core, config };
  } catch (error) {
    await app?.close().catch(() => undefined);
    await core.dispose().catch(() => undefined);
    throw error;
  }
}

/** Construct an injectable API without opening a port or starting background recovery. */
export async function buildApp(overrides: Partial<ServerConfig> = {}): Promise<FastifyInstance> {
  const { app, core } = await createApplication(overrides);
  try {
    // Fastify is thenable: returning it from an async factory boots plugins.
    // Catch that failure here, before callers have an instance they can close.
    return await app;
  } catch (error) {
    await app.close().catch(() => undefined);
    await core.dispose().catch(() => undefined);
    throw error;
  }
}

/** The CLI and desktop host share one listener, application resources and shutdown. */
export async function startServer(overrides: Partial<ServerConfig> = {}) {
  const { app, core, config } = await createApplication(overrides);
  try {
    await app.listen({ port: config.port, host: config.host });
    core.start();
  } catch (error) {
    await app.close().catch(() => undefined);
    await core.dispose().catch(() => undefined);
    throw error;
  }
  let closing: Promise<void> | undefined;
  return {
    ...core.context,
    app,
    server: app.server,
    config,
    url: `http://${config.host}:${(app.server.address() as AddressInfo).port}`,
    close: () => closing ??= app.close(),
  };
}
