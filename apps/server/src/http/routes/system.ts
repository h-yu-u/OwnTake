import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { ApplicationContext } from '../../application/context.ts';
import type { ServerConfig } from '../../config.ts';
import { readDiagnostics, readHealth, updateSettings } from '../../application/system.ts';
import { SettingsInput } from '../schemas/projects.ts';

export function registerSystemRoutes(fastify: FastifyInstance, context: Pick<ApplicationContext, 'store'>, config: ServerConfig): void {
  const app = fastify.withTypeProvider<TypeBoxTypeProvider>();
  app.get('/health', async () => readHealth(context, config));
  app.get('/settings', async () => context.store.getSettings());
  app.put('/settings', { schema: { body: SettingsInput } }, async request => updateSettings(context, request.body));
  app.get('/diagnostics', async () => readDiagnostics(context));
}
