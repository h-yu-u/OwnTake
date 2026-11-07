import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { ApplicationContext } from '../../application/context.ts';
import { inspectRuntime, readStudioFrame, requestStudioOperation } from '../../application/studio.ts';
import { publicStudio } from '../../studio-repository.ts';
import { HTTP_CACHE } from '../../config/http.ts';
import { FrameParams, IdParams, StudioSettlement } from '../schemas/common.ts';
import { RuntimeInput, StudioCreate } from '../schemas/studio.ts';

export function registerStudioRoutes(fastify: FastifyInstance, context: Pick<ApplicationContext, 'store' | 'runtimes' | 'studio' | 'studioRunner'>): void {
  const app = fastify.withTypeProvider<TypeBoxTypeProvider>();
  app.get('/runtimes', async () => context.runtimes.list());
  app.post('/runtimes', {
    schema: { body: RuntimeInput }, config: { validation: { bodyCode: 'INVALID_LOCAL_RUNTIME' } },
  }, async (request, reply) => reply.code(201).send(context.runtimes.save(request.body)));
  app.put('/runtimes/:id', {
    schema: { params: IdParams, body: RuntimeInput }, config: { validation: { bodyCode: 'INVALID_LOCAL_RUNTIME' } },
  }, async request => context.runtimes.save(request.body, request.params.id));
  app.post('/runtimes/:id/inspect', { schema: { params: IdParams } }, async request => inspectRuntime(context, request.params.id));
  app.get('/projects/:id/studio-operations', { schema: { params: IdParams } }, async request => context.studio.list(request.params.id));
  app.post('/projects/:id/studio-operations', {
    schema: { params: IdParams, body: StudioCreate },
    config: { validation: {
      fields: { '/targetId': 'INVALID_ID', '/clientRequestId': 'INVALID_ID', '/reservation/currency': 'INVALID_CURRENCY', '/input/candidateId': 'INVALID_ID' },
      discriminator: 'kind', variants: { tts: { '/input': 'INVALID_SPEECH_INPUT' } },
    } },
  }, async (request, reply) => reply.code(202).send(requestStudioOperation(context, request.params.id, request.body)));
  app.post('/studio-operations/:id/cancel', { schema: { params: IdParams } }, async request => publicStudio(context.studioRunner.cancel(request.params.id)));
  app.post('/studio-operations/:id/retry-ingest', { schema: { params: IdParams } }, async request => publicStudio(context.studioRunner.retryIngest(request.params.id)));
  app.post('/studio-operations/:id/settle', {
    schema: { params: IdParams, body: StudioSettlement },
    config: { validation: { fields: { '/currency': 'INVALID_CURRENCY' } } },
  }, async request => context.studio.settle(request.params.id, request.body));
  app.get('/studio-operations/:id/frames/:frameId', { schema: { params: FrameParams } }, async (request, reply) => {
    const bytes = readStudioFrame(context, request.params.id, request.params.frameId);
    return reply.type('image/png').header('Cache-Control', HTTP_CACHE.media).send(bytes);
  });
}
