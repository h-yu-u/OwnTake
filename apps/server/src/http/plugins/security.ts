import { randomBytes } from 'node:crypto';
import cookie from '@fastify/cookie';
import session, { MemoryStore } from '@fastify/session';
import csrf from '@fastify/csrf-protection';
import helmet from '@fastify/helmet';
import { LRUCache } from 'lru-cache';
import type { FastifyInstance, FastifyRequest, FastifyReply, Session } from 'fastify';
import { AppError } from '../../../../../packages/contracts/src/errors.ts';
import { SESSION_POLICY, CONTENT_SECURITY_POLICY } from '../../config/security.ts';

declare module 'fastify' {
  interface Session {
    ownTakeExpiresAt?: number;
    csrfToken?: string;
  }
  interface FastifyContextConfig {
    sessionBootstrap?: boolean;
  }
}

/** Use the plugin's signing/CAS implementation with bounded, expiring storage. */
export async function registerSecurity(app: FastifyInstance): Promise<void> {
  const cache = new LRUCache<string, Session>({
    max: SESSION_POLICY.maxSessions,
    ttl: SESSION_POLICY.ttlMs,
    ttlAutopurge: true,
  });
  await app.register(helmet, {
    contentSecurityPolicy: { useDefaults: false, directives: CONTENT_SECURITY_POLICY },
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'no-referrer' },
    // A loopback HTTP app must not upgrade its own media/resources to HTTPS.
    strictTransportSecurity: false,
  });
  await app.register(cookie);
  await app.register(session, {
    secret: randomBytes(SESSION_POLICY.secretBytes).toString('hex'),
    cookieName: SESSION_POLICY.cookieName,
    // MemoryStore uses get/set/delete. LRUCache supplies those operations; only
    // the libraries' iterator return typings differ from the ES Map interface.
    store: new MemoryStore(cache as unknown as Map<string, Session>),
    saveUninitialized: false,
    rolling: false,
    cookie: {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      secure: false,
      maxAge: SESSION_POLICY.ttlMs,
    },
  });
  await app.register(csrf, {
    sessionPlugin: '@fastify/session',
    getToken: request => {
      const value = request.headers[SESSION_POLICY.csrfHeader];
      return typeof value === 'string' ? value : '';
    },
  });
  app.addHook('onRequest', async request => {
    if (request.routeOptions.config.sessionBootstrap && !request.session.ownTakeExpiresAt && cache.size >= SESSION_POLICY.maxSessions) {
      throw new AppError('TOO_MANY_SESSIONS', '本机会话数量过多，请稍后再试', 429);
    }
  });
  app.addHook('onClose', async () => { cache.clear(); });
}

export function bootstrapSession(request: FastifyRequest, reply: FastifyReply): { csrfToken: string } {
  if (!request.session.ownTakeExpiresAt || request.session.ownTakeExpiresAt <= Date.now()) {
    request.session.ownTakeExpiresAt = Date.now() + SESSION_POLICY.ttlMs;
    request.session.csrfToken = reply.generateCsrf();
  }
  return { csrfToken: request.session.csrfToken! };
}

export function requireSession(request: FastifyRequest): void {
  if (!request.session.ownTakeExpiresAt || request.session.ownTakeExpiresAt <= Date.now()) {
    throw new AppError('AUTH_REQUIRED', '本机会话已过期，请刷新页面', 401);
  }
}

export function protectApi(app: FastifyInstance): void {
  app.addHook('onRequest', (request, reply, done) => {
    if (request.routeOptions.config.sessionBootstrap) { done(); return; }
    try { requireSession(request); }
    catch (error) { done(error as Error); return; }
    if (request.method === 'GET' || request.method === 'HEAD') done();
    else app.csrfProtection(request, reply, done);
  });
}
