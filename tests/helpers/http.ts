import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../../apps/server/src/app.ts';
import type { ServerConfig } from '../../apps/server/src/config.ts';
import type { ApiError } from '../../packages/contracts/src/index.ts';

export interface LocalSession {
  cookie: string;
  token: string;
  headers: Record<string, string>;
}

export async function openInjectedSession(
  app: FastifyInstance,
  host: string,
  cookie?: string,
): Promise<LocalSession> {
  const response = await app.inject({
    method: 'GET',
    url: '/api/session',
    headers: { host, ...(cookie ? { cookie } : {}) },
  });
  assert.equal(response.statusCode, 200, response.body);
  const { csrfToken } = response.json<{ csrfToken: string }>();
  assert.equal(typeof csrfToken, 'string');
  assert.ok(csrfToken.length > 0);
  const setCookie = response.headers['set-cookie'];
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
  const issued = cookies.find(value => value?.startsWith('owntake_session='));
  const sessionCookie = issued?.split(';')[0] ?? cookie;
  assert.ok(sessionCookie, 'session bootstrap must issue the local session cookie');
  return {
    cookie: sessionCookie,
    token: csrfToken,
    headers: {
      host,
      cookie: sessionCookie,
      'x-csrf-token': csrfToken,
      'content-type': 'application/json',
    },
  };
}

export function assertApiError(response: LightMyRequestResponse, status: number, code: string): ApiError {
  assert.equal(response.statusCode, status, response.body);
  assert.match(String(response.headers['content-type']), /^application\/json\b/);
  const body = response.json<ApiError>();
  assert.equal(body.error.code, code, response.body);
  assert.equal(typeof body.error.message, 'string');
  assert.equal('stack' in body.error, false);
  return body;
}

export async function httpFixture(t: TestContext, overrides: Partial<ServerConfig> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'owntake-http-contract-'));
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  t.after(async () => {
    try { await app?.close(); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  const webDir = join(root, 'web');
  await mkdir(webDir);
  await writeFile(join(webDir, 'index.html'), '<!doctype html><title>OwnTake HTTP fixture</title>');
  const config = { port: 4317, dataDir: join(root, 'data'), webDir, logLevel: 'silent' as const, ...overrides };
  app = await buildApp(config);
  const host = '127.0.0.1:' + config.port;
  const inject = (options: InjectOptions) => app!.inject({
    ...options,
    headers: { host, ...options.headers },
  });
  return { app, root, host, dataDir: config.dataDir, inject };
}
