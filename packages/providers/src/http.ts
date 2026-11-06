import { invariant } from '../../contracts/src/errors.ts';
import type { ProviderProfile } from '../../contracts/src/providers.ts';
import { ProviderCallError, invalidResponse } from './errors.ts';

const MAX_RESPONSE_BYTES = 1024 * 1024;

/** One POST only. Redirects and network retries are deliberately disabled. */
export async function postJsonOnce(profile: ProviderProfile, key: string, endpoint: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
  invariant(typeof key === 'string' && key.length <= 8192 && !/[\u0000-\u0020\u007f]/.test(key), 'INVALID_PROVIDER_KEY', 'API Key 格式无效。');
  const local = ['localhost', '127.0.0.1'].includes(new URL(profile.baseUrl).hostname);
  invariant(local || key.length > 0, 'PROVIDER_KEY_REQUIRED', '远端连接需要先配置 API Key。');
  const encoded = JSON.stringify(body);
  invariant(Buffer.byteLength(encoded) <= 1024 * 1024, 'CONTEXT_TOO_LARGE', '推理上下文超过 1 MiB，请减少镜头或描述长度。');
  if (signal?.aborted) throw new ProviderCallError('cancelled', 'PROVIDER_CANCELLED', '调用在发送前已取消。', 409);
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, profile.timeoutMs);
  timeout.unref();
  try {
    if (signal?.aborted) throw new ProviderCallError('cancelled', 'PROVIDER_CANCELLED', '调用在发送前已取消。', 409);
    const response = await fetch(profile.baseUrl + endpoint, {
      method: 'POST', redirect: 'manual', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: encoded,
    });
    if (!response.ok) {
      controller.abort();
      if (response.status >= 500 || response.status === 408) throw new ProviderCallError('submission_unknown', 'PROVIDER_SUBMISSION_UNKNOWN', `模型服务返回 HTTP ${response.status}，无法据此确认未处理请求；请核对，不会自动重发。`, 502, response.status);
      throw new ProviderCallError('http_rejected', 'PROVIDER_HTTP_REJECTED', `模型服务返回 HTTP ${response.status}；不会自动重试。`, 502, response.status);
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) { controller.abort(); throw invalidResponse('PROVIDER_RESPONSE_TOO_LARGE'); }
    if (!response.body) throw invalidResponse();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) { controller.abort(); throw invalidResponse('PROVIDER_RESPONSE_TOO_LARGE'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    if (controller.signal.aborted) throw new Error('Interrupted response');
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw invalidResponse('PROVIDER_INVALID_JSON'); }
  } catch (error) {
    if (error instanceof ProviderCallError) throw error;
    throw new ProviderCallError('submission_unknown', 'PROVIDER_SUBMISSION_UNKNOWN', timedOut ? '模型调用超时，远端是否已处理不明。请核对后再决定是否重新调用；不会自动重发。' : '连接中断或调用已停止，远端是否已处理不明。请核对后再决定是否重新调用；不会自动重发。', timedOut ? 504 : 502);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}
