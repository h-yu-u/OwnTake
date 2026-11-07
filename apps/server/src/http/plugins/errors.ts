import type { FastifyError, FastifyInstance, FastifyRequest } from 'fastify';
import { AppError } from '../../../../../packages/contracts/src/errors.ts';
import { HTTP_CACHE } from '../../config/http.ts';
import { validationError } from '../schemas/errors.ts';

const transportErrors: Record<string, readonly [string, string, number]> = {
  FST_ERR_CTP_INVALID_MEDIA_TYPE: ['INVALID_CONTENT_TYPE', '请求内容类型不受支持', 415],
  FST_ERR_CTP_BODY_TOO_LARGE: ['BODY_TOO_LARGE', '请求内容过大', 413],
  FST_ERR_CTP_EMPTY_JSON_BODY: ['INVALID_JSON', 'JSON 格式无效', 400],
  FST_ERR_CTP_INVALID_JSON_BODY: ['INVALID_JSON', 'JSON 格式无效', 400],
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: ['INVALID_INPUT', '请求长度无效', 400],
  FST_CSRF_MISSING_SECRET: ['CSRF_INVALID', '请求验证失败，请刷新页面', 403],
  FST_CSRF_INVALID_TOKEN: ['CSRF_INVALID', '请求验证失败，请刷新页面', 403],
  FST_ERR_BAD_URL: ['INVALID_ID', '资源地址不合法', 400],
  FST_STATIC_FORBIDDEN_PATH: ['FORBIDDEN_PATH', '不允许访问该路径', 403],
};

function publicError(error: FastifyError, request: FastifyRequest): AppError {
  if (error instanceof AppError) return error;
  if (error.validation) return validationError(error, request);
  const known = transportErrors[error.code];
  if (known) return new AppError(...known);
  if (error.statusCode === 403) return new AppError('FORBIDDEN_PATH', '不允许访问该路径', 403);
  if (error.statusCode === 416) return new AppError('INVALID_RANGE', '请求的媒体范围无效', 416);
  return new AppError('INTERNAL_ERROR', '操作未完成，请检查本地日志或任务详情', 500);
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler<FastifyError>((error, request, reply) => {
    const failure = publicError(error, request);
    if (failure.status >= 500) request.log.error({ err: error }, 'Local API request failed');
    // A failed stream has already sent its status. Never append JSON to media/SSE.
    if (reply.raw.headersSent) { reply.raw.destroy(); return; }
    // Stop reading a rejected streamed body after the JSON error is delivered.
    if (failure.status === 413) reply.header('Connection', 'close');
    if (failure.status === 416) {
      const headers = (error as FastifyError & { headers?: Record<string, string> }).headers;
      const range = headers?.['Content-Range'] ?? headers?.['content-range'];
      if (range) reply.header('Content-Range', range);
    }
    return reply.code(failure.status).header('Cache-Control', HTTP_CACHE.api).send({
      error: {
        code: failure.code,
        message: failure.message,
        ...(failure.details === undefined ? {} : { details: failure.details }),
      },
    });
  });
}
