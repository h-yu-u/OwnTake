import type { IncomingMessage, ServerResponse } from 'node:http';
import { AppError } from '../../../packages/contracts/src/errors.ts';
export function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}
export async function jsonBody(request: IncomingMessage, limit = 1024 * 1024): Promise<unknown> {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new AppError('INVALID_CONTENT_TYPE', '需要 application/json', 415);
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of request) { bytes += chunk.length; if (bytes > limit) throw new AppError('BODY_TOO_LARGE', '请求内容过大', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AppError('INVALID_JSON', 'JSON 格式无效'); }
}
export function sendError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) { response.end(); return; }
  if (error instanceof AppError) json(response, { error: { code: error.code, message: error.message, details: error.details } }, error.status);
  else json(response, { error: { code: 'INTERNAL_ERROR', message: '操作未完成，请检查本地日志或任务详情' } }, 500);
}
export function headers(response: ServerResponse): void {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
}
