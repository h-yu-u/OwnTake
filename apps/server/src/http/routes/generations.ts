import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { ApplicationContext } from '../../application/context.ts';
import { pauseGeneration, reconcileGeneration, requestGeneration, validateGeneration } from '../../application/generations.ts';
import { publicGeneration } from '../../generation-repository.ts';
import { IdParams, Settlement } from '../schemas/common.ts';
import { GenerationCreate, GenerationPolling, GenerationReconcile, GenerationValidation, ReviewInput } from '../schemas/generations.ts';

export function registerGenerationRoutes(fastify: FastifyInstance, context: Pick<ApplicationContext, 'generations' | 'generationRunner'>): void {
  const app = fastify.withTypeProvider<TypeBoxTypeProvider>();
  app.get('/projects/:id/generations', { schema: { params: IdParams } }, async request => context.generations.list(request.params.id));
  app.post('/shots/:id/generations/validate', {
    schema: { params: IdParams, body: GenerationValidation },
    config: { validation: { fields: { '/providerId': 'INVALID_ID', '/plan': 'INVALID_PLAN' } } },
  }, async request => validateGeneration(context, request.params.id, request.body));
  app.post('/shots/:id/generations', {
    schema: { params: IdParams, body: GenerationCreate },
    config: { validation: { fields: { '/providerId': 'INVALID_ID', '/clientRequestId': 'INVALID_ID', '/plan': 'INVALID_PLAN', '/reservation/currency': 'INVALID_CURRENCY' } } },
  }, async (request, reply) => reply.code(202).send(await requestGeneration(context, request.params.id, request.body)));
  app.post('/generations/:id/cancel', { schema: { params: IdParams } }, async request => publicGeneration(context.generationRunner.cancel(request.params.id)));
  app.post('/generations/:id/reconcile', {
    schema: { params: IdParams, body: GenerationReconcile },
    config: { validation: { fields: { '/remoteTaskId': 'INVALID_ID' } } },
  }, async request => reconcileGeneration(context, request.params.id, request.body));
  app.post('/generations/:id/retry-download', { schema: { params: IdParams } }, async request => publicGeneration(context.generationRunner.retryDownload(request.params.id)));
  app.post('/generations/:id/polling', { schema: { params: IdParams, body: GenerationPolling } }, async request => pauseGeneration(context, request.params.id, request.body));
  app.post('/generations/:id/settle', {
    schema: { params: IdParams, body: Settlement },
    config: { validation: { fields: { '/currency': 'INVALID_CURRENCY' } } },
  }, async request => context.generations.settle(request.params.id, request.body));
  app.get('/projects/:id/reviews', { schema: { params: IdParams } }, async request => context.generations.listReviews(request.params.id));
  app.post('/shots/:id/reviews', {
    schema: { params: IdParams, body: ReviewInput },
    config: { validation: { fields: { '/candidateId': 'INVALID_ID', '/verdict': 'INVALID_REVIEW', '/checked/*': 'INVALID_REVIEW' } } },
  }, async (request, reply) => reply.code(201).send(context.generations.review(request.params.id, request.body)));
}
