import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AppError } from '../../../packages/contracts/src/errors.ts';
interface Session { csrf: string; expires: number }
export function createSecurity(port: () => number, devOrigin?: string) {
  const sessions = new Map<string, Session>();
  function validateOrigin(request: IncomingMessage): void {
    const host = request.headers.host;
    if (host !== `127.0.0.1:${port()}` && host !== `localhost:${port()}`) throw new AppError('FORBIDDEN_HOST', '仅允许本机访问', 403);
    const origin = request.headers.origin;
    if (origin && ![`http://127.0.0.1:${port()}`, `http://localhost:${port()}`, devOrigin].includes(origin)) throw new AppError('FORBIDDEN_ORIGIN', '来源未授权', 403);
    if (request.headers['sec-fetch-site'] === 'cross-site') throw new AppError('FORBIDDEN_ORIGIN', '拒绝跨站请求', 403);
  }
  function readSession(request: IncomingMessage): Session | undefined {
    const cookie = request.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith('owntake_session='))?.slice(16);
    const found = cookie ? sessions.get(cookie) : undefined;
    return found && found.expires > Date.now() ? found : undefined;
  }
  function bootstrap(request: IncomingMessage, response: ServerResponse): { csrfToken: string } {
    const previous = readSession(request); if (previous) return { csrfToken: previous.csrf };
    for (const [key, session] of sessions) if (session.expires <= Date.now()) sessions.delete(key);
    if (sessions.size > 100) throw new AppError('TOO_MANY_SESSIONS', '本机会话数量过多，请重启服务', 429);
    const id = randomBytes(24).toString('hex'), session = { csrf: randomBytes(24).toString('hex'), expires: Date.now() + 12 * 60 * 60 * 1000 };
    sessions.set(id, session);
    response.setHeader('Set-Cookie', `owntake_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);
    return { csrfToken: session.csrf };
  }
  function authorize(request: IncomingMessage): void {
    const session = readSession(request); if (!session) throw new AppError('AUTH_REQUIRED', '本机会话已过期，请刷新页面', 401);
    if (!['GET', 'HEAD'].includes(request.method || '')) {
      const token = request.headers['x-csrf-token'];
      if (typeof token !== 'string' || token.length !== session.csrf.length || !timingSafeEqual(Buffer.from(token), Buffer.from(session.csrf))) throw new AppError('CSRF_INVALID', '请求验证失败，请刷新页面', 403);
    }
  }
  return { validateOrigin, bootstrap, authorize };
}
