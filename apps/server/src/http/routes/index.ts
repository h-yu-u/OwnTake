import type { FastifyInstance } from 'fastify';
import type { ApplicationContext } from '../../application/context.ts';
import type { ServerConfig } from '../../config.ts';
import { registerStoryRoutes } from './stories.ts';
import { registerProjectRoutes } from './projects.ts';
import { registerStoryboardRoutes } from './storyboard.ts';
import { registerProviderRoutes } from './providers.ts';
import { registerGenerationRoutes } from './generations.ts';
import { registerStudioRoutes } from './studio.ts';
import { registerSystemRoutes } from './system.ts';

/** Registered inside the authenticated /api scope supplied by the HTTP host. */
export function registerApplicationRoutes(app: FastifyInstance, context: ApplicationContext, config: ServerConfig): void {
  registerStoryRoutes(app, context);
  registerProjectRoutes(app, context);
  registerStoryboardRoutes(app, context);
  registerProviderRoutes(app, context);
  registerGenerationRoutes(app, context);
  registerStudioRoutes(app, context);
  registerSystemRoutes(app, context, config);
}
