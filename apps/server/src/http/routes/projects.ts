import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { ApplicationContext } from '../../application/context.ts';
import { createProject, updateProject } from '../../application/projects.ts';
import { saveTimeline } from '../../application/timelines.ts';
import { requestExport } from '../../application/exports.ts';
import { cancelJob, listProjectJobs } from '../../application/jobs.ts';
import { IdParams } from '../schemas/common.ts';
import { ExportInput, ProjectInput, ProjectUpdate, TimelineInput } from '../schemas/projects.ts';

export function registerProjectRoutes(fastify: FastifyInstance, context: Pick<ApplicationContext, 'store' | 'scheduler' | 'models' | 'generationRunner' | 'studioRunner'>): void {
  const app = fastify.withTypeProvider<TypeBoxTypeProvider>();
  app.get('/projects', async () => context.store.listProjects());
  app.post('/projects', { schema: { body: ProjectInput } }, async (request, reply) => {
    return reply.code(201).send(createProject(context, request.body));
  });
  app.get('/projects/:id', { schema: { params: IdParams } }, async request => context.store.snapshot(request.params.id));
  app.put('/projects/:id', { schema: { params: IdParams, body: ProjectUpdate } }, async request => {
    return updateProject(context, request.params.id, request.body);
  });
  app.put('/projects/:id/timeline', {
    schema: { params: IdParams, body: TimelineInput },
    config: { validation: { fields: {
      '/clips/*/artifactId': 'INVALID_ID', '/clips/*/shotId': 'INVALID_ID',
      '/captions': 'INVALID_TIMELINE', '/audio': 'INVALID_TIMELINE',
      '/captions/*/startMs': 'INVALID_INPUT', '/captions/*/endMs': 'INVALID_INPUT', '/captions/*/style/fontSize': 'INVALID_INPUT',
      '/audio/*/artifactId': 'INVALID_ID', '/audio/*/startMs': 'INVALID_INPUT', '/audio/*/sourceInMs': 'INVALID_INPUT',
      '/audio/*/gainDb': 'INVALID_INPUT', '/audio/*/durationMs': 'INVALID_INPUT', '/audio/*/fadeInMs': 'INVALID_INPUT', '/audio/*/fadeOutMs': 'INVALID_INPUT',
    } } },
  }, async request => saveTimeline(context, request.params.id, request.body));
  app.post('/projects/:id/exports', {
    schema: { params: IdParams, body: ExportInput },
    config: { validation: { fields: { '/timelineId': 'INVALID_ID', '/clientRequestId': 'INVALID_ID' } } },
  }, async (request, reply) => reply.code(202).send(await requestExport(context, request.params.id, request.body)));
  app.get('/projects/:id/jobs', { schema: { params: IdParams } }, async request => listProjectJobs(context, request.params.id));
  app.get('/jobs/:id', { schema: { params: IdParams } }, async request => context.store.getJob(request.params.id));
  app.post('/jobs/:id/cancel', { schema: { params: IdParams } }, async request => cancelJob(context, request.params.id));
}
