import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { ApplicationContext } from '../../application/context.ts';
import { addCandidate, addShot, applyDraft, archiveShot, createDraft, reorderShots, selectCandidate, updateShot } from '../../application/storyboard.ts';
import { saveStoryboardTimeline } from '../../application/storyboard-timeline.ts';
import { IdParams } from '../schemas/common.ts';
import { CandidateCreate, CandidateSelect, DraftApply, DraftCreate, ShotArchive, ShotCreate, ShotReorder, ShotUpdate, StoryboardTimeline } from '../schemas/storyboard.ts';

export function registerStoryboardRoutes(fastify: FastifyInstance, context: Pick<ApplicationContext, 'store' | 'board'>): void {
  const app = fastify.withTypeProvider<TypeBoxTypeProvider>();
  app.get('/projects/:id/storyboard', { schema: { params: IdParams } }, async request => context.board.snapshot(request.params.id));
  app.post('/projects/:id/shots', {
    schema: { params: IdParams, body: ShotCreate },
    config: { validation: { fields: { '/fields': 'INVALID_STORYBOARD' } } },
  }, async (request, reply) => reply.code(201).send(addShot(context, request.params.id, request.body)));
  app.put('/shots/:id', {
    schema: { params: IdParams, body: ShotUpdate },
    config: { validation: { fields: { '/fields': 'INVALID_STORYBOARD' } } },
  }, async request => updateShot(context, request.params.id, request.body));
  app.post('/shots/:id/archive', { schema: { params: IdParams, body: ShotArchive } }, async request => archiveShot(context, request.params.id, request.body));
  app.post('/projects/:id/shots/reorder', {
    schema: { params: IdParams, body: ShotReorder },
    config: { validation: { fields: { '/shotIds/*': 'INVALID_ID' } } },
  }, async request => reorderShots(context, request.params.id, request.body));
  app.post('/shots/:id/candidates', {
    schema: { params: IdParams, body: CandidateCreate },
    config: { validation: { fields: { '/artifactId': 'INVALID_ID' } } },
  }, async (request, reply) => reply.code(201).send(addCandidate(context, request.params.id, request.body)));
  app.post('/shots/:id/select', {
    schema: { params: IdParams, body: CandidateSelect },
    config: { validation: { fields: { '/candidateId': 'INVALID_ID' } } },
  }, async request => selectCandidate(context, request.params.id, request.body));
  app.post('/projects/:id/drafts', {
    schema: { params: IdParams, body: DraftCreate },
    config: { validation: { fields: { '/operations': 'INVALID_STORYBOARD' } } },
  }, async (request, reply) => reply.code(201).send(createDraft(context, request.params.id, request.body)));
  app.post('/drafts/:id/apply', {
    schema: { params: IdParams, body: DraftApply },
    config: { validation: { fields: { '/acceptedOperationIds/*': 'INVALID_ID' } } },
  }, async request => applyDraft(context, request.params.id, request.body));
  app.post('/projects/:id/storyboard/timeline', { schema: { params: IdParams, body: StoryboardTimeline } }, async request => saveStoryboardTimeline(context, request.params.id, request.body));
}
