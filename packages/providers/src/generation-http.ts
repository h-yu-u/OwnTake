import { invariant } from '../../contracts/src/errors.ts';
import type { ProviderProfile } from '../../contracts/src/providers.ts';
import { ProviderCallError } from './errors.ts';
import { MAX_GENERATION_REQUEST_BYTES } from './generation-validation.ts';

interface RequestOptions {
  method: 'POST' | 'GET' | 'DELETE';
  phase: 'submit' | 'poll' | 'cancel';
  body?: Record<string, unknown>;
  signal?: AbortSignal;
  maxResponseBytes: number;
  unknownOnInvalidResponse?: boolean;
  allowEmpty?: boolean;
}

export function submissionUnknown(): ProviderCallError {
  return new ProviderCallError('submission_unknown', 'PROVIDER_SUBMISSION_UNKNOWN', '生成请求的远端处理结果不明。请核对原请求；不会自动再次提交。');
}

/** Exactly one request, bounded bytes and deadline through the final response body byte. */
export async function generationJsonRequest(profile: ProviderProfile, key: string, endpoint: string, options: RequestOptions): Promise<unknown> {
  invariant(typeof key === 'string' && key.length <= 8192 && !/[\u0000-\u0020\u007f]/.test(key), 'INVALID_PROVIDER_KEY', 'API Key 格式无效。');
  invariant(['localhost', '127.0.0.1'].includes(new URL(profile.baseUrl).hostname) || key.length > 0, 'PROVIDER_KEY_REQUIRED', '远端连接需要先配置 API Key。');
  invariant(/^\/[A-Za-z0-9_/-]+$/.test(endpoint) && !endpoint.startsWith('//') && !endpoint.includes('..'), 'INVALID_PROVIDER_ENDPOINT', '生成接口路径无效。');
  const encoded = options.body === undefined ? undefined : JSON.stringify(options.body);
  invariant(encoded === undefined || Buffer.byteLength(encoded) <= MAX_GENERATION_REQUEST_BYTES, 'GENERATION_REQUEST_TOO_LARGE', '生成请求超过 32 MiB。');
  if (options.signal?.aborted) throw new ProviderCallError('cancelled', 'PROVIDER_REQUEST_ABORTED', '请求在发送前已停止；这不表示远端任务已经取消。', 409);
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, profile.timeoutMs);
  timeout.unref();
  const malformed = (code: string): ProviderCallError => options.unknownOnInvalidResponse
    ? submissionUnknown()
    : new ProviderCallError('invalid_response', code, '生成服务响应未通过结构或大小检查；不会重新提交生成请求。');
  try {
    if (options.signal?.aborted) throw new ProviderCallError('cancelled', 'PROVIDER_REQUEST_ABORTED', '请求在发送前已停止；这不表示远端任务已经取消。', 409);
    const response = await fetch(profile.baseUrl + endpoint, {
      method: options.method, redirect: 'manual', signal: controller.signal,
      headers: { Accept: 'application/json', ...(encoded === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      ...(encoded === undefined ? {} : { body: encoded }),
    });
    if (!response.ok) {
      controller.abort();
      if (options.phase === 'submit' && (response.status >= 500 || response.status === 408)) throw new ProviderCallError('submission_unknown', 'PROVIDER_SUBMISSION_UNKNOWN', `生成服务返回 HTTP ${response.status}，无法确认是否已处理；不会自动重发。`, 502, response.status);
      throw new ProviderCallError('http_rejected', 'PROVIDER_HTTP_REJECTED', `生成服务拒绝本次 ${options.method} 请求（HTTP ${response.status}）；未重新提交生成任务。`, 502, response.status);
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > options.maxResponseBytes) { controller.abort(); throw malformed('PROVIDER_RESPONSE_TOO_LARGE'); }
    if (!response.body) {
      if (options.allowEmpty) return {};
      throw malformed('PROVIDER_INVALID_RESPONSE');
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > options.maxResponseBytes) { controller.abort(); throw malformed('PROVIDER_RESPONSE_TOO_LARGE'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    if (controller.signal.aborted) throw new Error('Interrupted body');
    if (bytes === 0 && options.allowEmpty) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw malformed('PROVIDER_INVALID_JSON'); }
  } catch (error) {
    if (error instanceof ProviderCallError) throw error;
    if (options.phase === 'submit') throw new ProviderCallError('submission_unknown', 'PROVIDER_SUBMISSION_UNKNOWN', timedOut ? '生成请求超时，远端是否已处理不明；不会自动重发。' : '生成请求连接中断，远端是否已处理不明；不会自动重发。', timedOut ? 504 : 502);
    throw new ProviderCallError('invalid_response', options.phase === 'poll' ? 'PROVIDER_POLL_UNAVAILABLE' : 'PROVIDER_CANCEL_UNCONFIRMED', options.phase === 'poll' ? '暂时无法查询原任务状态；请保留原任务标识并再次查询，不应重新提交。' : '取消请求未得到可靠确认；请查询原任务状态，不应认为任务已经取消。', timedOut ? 504 : 502);
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abort);
  }
}
