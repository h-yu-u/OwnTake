import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { ApplicationContext } from '../../application/context.ts';
import { IdParams, ProjectFromStory, ScriptInput, StoryInput, StorySearch, StoryUpdate } from '../schemas/stories.ts';

export function registerStoryRoutes(fastify: FastifyInstance, { stories }: Pick<ApplicationContext, 'stories'>): void {
  const app = fastify.withTypeProvider<TypeBoxTypeProvider>();
  app.get('/stories', { schema: { querystring: StorySearch } }, async request => stories.list(request.query.q ?? ''));
  app.post('/stories', { schema: { body: StoryInput } }, async (request, reply) => reply.code(201).send(stories.create(request.body)));
  app.get('/stories/:id', { schema: { params: IdParams } }, async request => stories.get(request.params.id));
  app.put('/stories/:id', { schema: { params: IdParams, body: StoryUpdate } }, async request => {
    const { expectedRevision, ...story } = request.body;
    return stories.update(request.params.id, story, expectedRevision);
  });
  app.get('/stories/:id/versions', { schema: { params: IdParams } }, async request => stories.versions(request.params.id));
  app.get('/stories/:id/scripts', { schema: { params: IdParams } }, async request => stories.scripts(request.params.id));
  app.post('/stories/:id/scripts', { schema: { params: IdParams, body: ScriptInput } }, async (request, reply) =>
    reply.code(201).send(stories.saveScript(request.params.id, request.body.sourceVersion, request.body.text)));
  app.get('/stories/:id/projects', { schema: { params: IdParams } }, async request => stories.links(request.params.id));
  app.post('/stories/:id/projects', { schema: { params: IdParams, body: ProjectFromStory } }, async (request, reply) =>
    reply.code(201).send(stories.createProject(request.params.id, request.body.storyVersion, request.body.scriptVersion, request.body.ratio)));
}
