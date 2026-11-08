import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { ApplicationContext } from '../../application/context.ts';
import { requestReasoning } from '../../application/providers.ts';
import { discoverProviderModels } from '../../application/provider-models.ts';
import { IdParams, Settlement } from '../schemas/common.ts';
import { ProviderInput, ProviderModelDiscoveryInput, ReasoningInput } from '../schemas/providers.ts';

const profileValidation = { bodyCode: 'INVALID_PROVIDER', fields: { '/key': 'INVALID_KEY' } };

export function registerProviderRoutes(fastify: FastifyInstance, context: Pick<ApplicationContext, 'providers' | 'models'>): void {
  const app = fastify.withTypeProvider<TypeBoxTypeProvider>();
  app.get('/providers', async () => context.providers.listProfiles());
  app.post('/providers/models', {
    schema: { body: ProviderModelDiscoveryInput },
    config: { validation: { bodyCode: 'INVALID_PROVIDER_MODEL_REQUEST', fields: { '/key': 'INVALID_KEY', '/providerId': 'INVALID_ID' } } },
  }, async request => discoverProviderModels(context, request.body));
  app.post('/providers', {
    schema: { body: ProviderInput }, config: { validation: profileValidation },
  }, async (request, reply) => reply.code(201).send(context.providers.saveProfile(request.body)));
  app.put('/providers/:id', {
    schema: { params: IdParams, body: ProviderInput }, config: { validation: profileValidation },
  }, async request => context.providers.saveProfile(request.body, request.params.id));
  app.get('/projects/:id/calls', { schema: { params: IdParams } }, async request => context.providers.listCalls(request.params.id));
  app.post('/projects/:id/reasoning', {
    schema: { params: IdParams, body: ReasoningInput },
    config: { validation: { fields: { '/providerId': 'INVALID_ID', '/clientRequestId': 'INVALID_ID', '/reservation/currency': 'INVALID_CURRENCY' } } },
  }, async (request, reply) => reply.code(202).send(requestReasoning(context, request.params.id, request.body)));
  app.post('/calls/:id/settle', {
    schema: { params: IdParams, body: Settlement },
    config: { validation: { fields: { '/currency': 'INVALID_CURRENCY' } } },
  }, async request => context.providers.settle(request.params.id, request.body));
}
