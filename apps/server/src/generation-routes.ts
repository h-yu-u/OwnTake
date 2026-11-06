import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteContext } from './routes.ts';
import { invariant } from '../../../packages/contracts/src/errors.ts';
import { record, resourceId, text } from '../../../packages/domain/src/validation.ts';
import { json, jsonBody } from './http.ts';
import { publicGeneration } from './generation-repository.ts';
export async function generationRoutes(request: IncomingMessage, response: ServerResponse, url: URL, context: RouteContext): Promise<boolean> {
  const { generations, generationRunner } = context, path = url.pathname, method = request.method;
  const list = /^\/api\/projects\/([^/]+)\/generations$/.exec(path);
  if (list && method === 'GET') { json(response, generations.list(resourceId(list[1]))); return true; }
  const validate = /^\/api\/shots\/([^/]+)\/generations\/validate$/.exec(path);
  if (validate && method === 'POST') { const b = record(await jsonBody(request)); json(response, (await generations.validation(resourceId(validate[1]), resourceId(b.providerId), b.plan)).result); return true; }
  const create = /^\/api\/shots\/([^/]+)\/generations$/.exec(path);
  if (create && method === 'POST') { const g = await generations.create(resourceId(create[1]), await jsonBody(request)); generationRunner.tick(); json(response, publicGeneration(generations.get(g.id)), 202); return true; }
  const cancel = /^\/api\/generations\/([^/]+)\/cancel$/.exec(path);
  if (cancel && method === 'POST') { json(response, publicGeneration(generationRunner.cancel(resourceId(cancel[1])))); return true; }
  const reconcile = /^\/api\/generations\/([^/]+)\/reconcile$/.exec(path);
  if (reconcile && method === 'POST') { const b = record(await jsonBody(request)); json(response, publicGeneration(await generationRunner.reconcile(resourceId(reconcile[1]), resourceId(b.remoteTaskId), text(b.note, '远端任务核对说明', 2000)))); return true; }
  const retry = /^\/api\/generations\/([^/]+)\/retry-download$/.exec(path);
  if (retry && method === 'POST') { json(response, publicGeneration(generationRunner.retryDownload(resourceId(retry[1])))); return true; }
  const polling = /^\/api\/generations\/([^/]+)\/polling$/.exec(path);
  if (polling && method === 'POST') { const b = record(await jsonBody(request)); invariant(typeof b.paused === 'boolean', 'INVALID_INPUT', '需要明确是否暂停查询'); json(response, publicGeneration(generationRunner.pause(resourceId(polling[1]), b.paused))); return true; }
  const settle = /^\/api\/generations\/([^/]+)\/settle$/.exec(path);
  if (settle && method === 'POST') { json(response, generations.settle(resourceId(settle[1]), await jsonBody(request))); return true; }
  const reviews = /^\/api\/projects\/([^/]+)\/reviews$/.exec(path);
  if (reviews && method === 'GET') { json(response, generations.listReviews(resourceId(reviews[1]))); return true; }
  const review = /^\/api\/shots\/([^/]+)\/reviews$/.exec(path);
  if (review && method === 'POST') { json(response, generations.review(resourceId(review[1]), await jsonBody(request)), 201); return true; }
  return false;
}
