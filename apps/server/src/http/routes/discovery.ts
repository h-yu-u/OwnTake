import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { ApplicationContext } from '../../application/context.ts';
import { canonicalStoryUrl } from '../../../../../packages/providers/src/discovery.ts';
import { DiscoverySave, SearchQuery } from '../schemas/discovery.ts';

export function registerDiscoveryRoutes(fastify: FastifyInstance, { stories, discovery }: Pick<ApplicationContext, 'stories' | 'discovery'>): void {
  const app = fastify.withTypeProvider<TypeBoxTypeProvider>();
  app.get('/story-discovery/status', async () => ({ configured: discovery.configured(), sources: ['zhihu','xiaohongshu'] }));
  app.get('/story-discovery', { schema: { querystring: SearchQuery } }, async request =>
    discovery.search(request.query.source, request.query.q));
  app.post('/story-discovery/save', { schema: { body: DiscoverySave } }, async (request, reply) => {
    const input = request.body;
    const url = canonicalStoryUrl(input.url);
    const story = stories.create({
      title: input.title,
      summary: input.snippet, genre: '', tags: [], beats: [],
      source: { platform: input.platform, url, title: input.title, author: input.author, rights: 'inspiration_only' },
    });
    return reply.code(201).send(story);
  });
}
