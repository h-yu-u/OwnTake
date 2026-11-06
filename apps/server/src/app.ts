import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Store } from '../../../packages/storage/src/index.ts';
import { AppError } from '../../../packages/contracts/src/errors.ts';
import { serverConfig } from './config.ts';
import type { ServerConfig } from './config.ts';
import { createSecurity } from './security.ts';
import { acquireLock } from './instance-lock.ts';
import { headers, json, sendError } from './http.ts';
import { apiRoutes } from './routes.ts';
import { serveStatic } from './static.ts';
import { Scheduler } from './scheduler.ts';
import { StoryboardStore } from '../../../packages/storage/src/storyboard.ts';
import { ProviderRepository } from './provider-repository.ts';
import { ModelRunner } from './model-runner.ts';
export async function startServer(overrides: Partial<ServerConfig> = {}) {
  const config = serverConfig(overrides), releaseLock = await acquireLock(config.dataDir);
  let store: Store;
  try { store = new Store({ dataDir: config.dataDir, projectsDir: config.projectsDir }); }
  catch (error) { await releaseLock(); throw error; }
  const scheduler = new Scheduler(store), streams = new Set<() => void>(), board = new StoryboardStore(store);
  let providers: ProviderRepository;
  try { providers = new ProviderRepository(store, board); } catch (error) { store.close(); await releaseLock(); throw error; }
  const models = new ModelRunner(providers);
  const server = createServer(async (request, response) => {
    headers(response);
    try {
      security.validateOrigin(request);
      const url = new URL(request.url || '/', 'http://127.0.0.1');
      if (url.pathname === '/api/session' && request.method === 'GET') { json(response, security.bootstrap(request, response)); return; }
      if (url.pathname.startsWith('/api/')) security.authorize(request);
      if (await apiRoutes(request, response, url, { store, scheduler, config, streams, board, providers, models })) return;
      await serveStatic(request, response, config.webDir, url.pathname);
    } catch (error) {
      if (!(error instanceof AppError)) console.error('[OwnTake] request failed:', error instanceof Error ? error.name : 'UnknownError');
      sendError(response, error);
    }
  });
  const security = createSecurity(() => (server.address() as AddressInfo)?.port ?? config.port, config.devOrigin);
  server.requestTimeout = 300000; server.headersTimeout = 15000;
  try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, () => { server.off('error', reject); resolve(); }); }); }
  catch (error) { store.close(); await releaseLock(); throw error; }
  scheduler.start(); models.start(); let closing: Promise<void> | null = null;
  const close = (): Promise<void> => closing ||= (async () => {
    for (const stop of streams) stop(); streams.clear();
    await Promise.all([scheduler.stop(), models.stop()]); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close(); await releaseLock();
  })();
  return { server, store, scheduler, board, providers, models, config, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close };
}
