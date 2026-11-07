import type { FastifyInstance } from 'fastify';
import fastifySSE from '@fastify/sse';
import { Type } from 'typebox';
import { integer } from '../../../../../packages/domain/src/validation.ts';
import type { ApplicationContext } from '../../application/context.ts';
import type { ServerConfig } from '../../config.ts';
import { EVENT_STREAM } from '../../config/events.ts';
import { ResourceId } from '../schemas/common.ts';

interface EventQuery { Querystring: { projectId: string; after?: string } }

export async function registerEventRoutes(app: FastifyInstance, context: ApplicationContext, _config: ServerConfig): Promise<void> {
  await app.register(async events => {
    const connections = new Set<() => void>();
    await events.register(fastifySSE, { heartbeatInterval: EVENT_STREAM.heartbeatIntervalMs });
    events.addHook('preClose', async () => {
      for (const stop of connections) stop();
    });
    events.get<EventQuery>('/events', {
      exposeHeadRoute: false,
      sse: 'only',
      schema: { querystring: Type.Object({ projectId: ResourceId, after: Type.Optional(Type.String()) }) },
      config: { validation: { fields: { '/projectId': 'INVALID_ID' } } },
    }, async (request, reply) => {
      const { store } = context;
      const { projectId } = request.query;
      let cursor = integer(Number(request.headers['last-event-id'] || request.query.after || 0), '事件游标', 0, Number.MAX_SAFE_INTEGER);
      store.getProject(projectId);
      const stream = reply.sse;
      let stopped = false;
      let timer: NodeJS.Timeout | undefined;
      const stop = () => {
        if (stopped) return;
        stopped = true;
        clearTimeout(timer);
        connections.delete(stop);
        stream.close();
      };
      stream.keepAlive();
      stream.onClose(stop);
      connections.add(stop);
      reply.header('Cache-Control', EVENT_STREAM.cacheControl);

      const flush = async () => {
        let delay: number = EVENT_STREAM.pollIntervalMs;
        try {
          if (stopped) return;
          const batch = store.listEvents(projectId, cursor, EVENT_STREAM.pageSize);
          for (const event of batch) {
            if (stopped) break;
            await stream.send({ id: String(event.seq), event: 'change', data: event });
            cursor = event.seq;
          }
          if (batch.length === EVENT_STREAM.pageSize) delay = 0;
        } catch (error) {
          if (stream.isConnected) request.log.error({ err: error, projectId }, 'Project event stream failed');
          stop();
        } finally {
          if (!stopped) {
            timer = setTimeout(() => { void flush(); }, delay);
            timer.unref();
          }
        }
      };
      try {
        await stream.send({ data: undefined, retry: EVENT_STREAM.retryIntervalMs });
        await flush();
      } catch (error) {
        stop();
        throw error;
      }
    });
  });
}
