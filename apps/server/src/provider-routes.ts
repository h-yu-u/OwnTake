import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteContext } from './routes.ts';
import { resourceId } from '../../../packages/domain/src/validation.ts';
import { json, jsonBody } from './http.ts';
import { publicCall } from './provider-repository.ts';
export async function providerRoutes(request: IncomingMessage, response: ServerResponse, url: URL, context: RouteContext): Promise<boolean> {
  const { providers, models } = context, method = request.method, path = url.pathname;
  if (path === '/api/providers' && method === 'GET') { json(response, providers.listProfiles()); return true; }
  if (path === '/api/providers' && method === 'POST') { json(response, providers.saveProfile(await jsonBody(request)), 201); return true; }
  const profile = /^\/api\/providers\/([^/]+)$/.exec(path);
  if (profile && method === 'PUT') { json(response, providers.saveProfile(await jsonBody(request), resourceId(profile[1]))); return true; }
  const calls = /^\/api\/projects\/([^/]+)\/calls$/.exec(path);
  if (calls && method === 'GET') { json(response, providers.listCalls(resourceId(calls[1]))); return true; }
  const reasoning = /^\/api\/projects\/([^/]+)\/reasoning$/.exec(path);
  if (reasoning && method === 'POST') { const call = providers.createReasoning(resourceId(reasoning[1]), await jsonBody(request)); models.tick(); json(response, publicCall(providers.getCall(call.id)), 202); return true; }
  const settle = /^\/api\/calls\/([^/]+)\/settle$/.exec(path);
  if (settle && method === 'POST') { json(response, providers.settle(resourceId(settle[1]), await jsonBody(request))); return true; }
  return false;
}
