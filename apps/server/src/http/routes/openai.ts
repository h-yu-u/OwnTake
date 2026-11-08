import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { ApplicationContext } from '../../application/context.ts';
import { discoverOpenAIModels } from '../../application/openai.ts';
import { IdParams } from '../schemas/common.ts';
import { OpenAIConnectionInput, OpenAIConnectionUpdate, OpenAIModelDiscoveryInput } from '../schemas/openai.ts';

const validation = { bodyCode: 'INVALID_OPENAI_CONNECTION', fields: { '/key': 'INVALID_KEY' } };

export function registerOpenAIRoutes(fastify: FastifyInstance, { openaiConnections }: Pick<ApplicationContext, 'openaiConnections'>): void {
  const app = fastify.withTypeProvider<TypeBoxTypeProvider>();
  app.get('/openai-connections', async () => openaiConnections.list());
  app.post('/openai-connections/models', {
    schema: { body: OpenAIModelDiscoveryInput },
    config: { validation: { bodyCode: 'INVALID_OPENAI_MODEL_REQUEST', fields: { '/key': 'INVALID_KEY', '/connectionId': 'INVALID_ID' } } },
  }, async request => discoverOpenAIModels({ openaiConnections }, request.body));
  app.post('/openai-connections', {
    schema: { body: OpenAIConnectionInput }, config: { validation },
  }, async (request, reply) => reply.code(201).send(openaiConnections.save(request.body)));
  app.put('/openai-connections/:id', {
    schema: { params: IdParams, body: OpenAIConnectionUpdate }, config: { validation },
  }, async request => openaiConnections.save(request.body, request.params.id));
}
