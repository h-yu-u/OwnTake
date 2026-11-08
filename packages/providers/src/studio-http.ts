import { invariant } from '../../contracts/src/errors.ts';
import type { ProviderProfile } from '../../contracts/src/providers.ts';
import { ProviderCallError, invalidResponse } from './errors.ts';
import { normalizeBaseUrl } from './profiles.ts';
import { providerHttpError } from './http-error.ts';

export const MAX_STUDIO_REQUEST_BYTES = 8 * 1024 * 1024;
export const MAX_STUDIO_JSON_BYTES = 1024 * 1024;
export const MAX_SPEECH_BYTES = 32 * 1024 * 1024;

/** A single POST with bounded request/response bodies and a deadline through body completion. */
export async function postStudioBytesOnce(
  profile: ProviderProfile,
  key: string,
  endpoint: '/audio/speech' | '/chat/completions',
  body: Record<string, unknown>,
  options: { signal?: AbortSignal; response: 'wav' | 'json' },
): Promise<Uint8Array> {
  const baseUrl = normalizeBaseUrl(profile.baseUrl);
  invariant(endpoint === '/audio/speech' || endpoint === '/chat/completions', 'INVALID_PROVIDER_ENDPOINT', '增强操作接口路径无效。');
  invariant(typeof key === 'string' && key.length <= 8192 && !/[\u0000-\u0020\u007f]/.test(key), 'INVALID_PROVIDER_KEY', 'API Key 格式无效。');
  invariant(['localhost', '127.0.0.1'].includes(new URL(baseUrl).hostname) || key.length > 0, 'PROVIDER_KEY_REQUIRED', '远端连接需要先配置 API Key。');
  const encoded = JSON.stringify(body);
  invariant(Buffer.byteLength(encoded, 'utf8') <= MAX_STUDIO_REQUEST_BYTES, 'STUDIO_REQUEST_TOO_LARGE', '增强操作请求超过 8 MiB，请减少输入。');
  if (options.signal?.aborted) throw new ProviderCallError('cancelled', 'PROVIDER_CANCELLED', '调用在发送前已停止。', 409);
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, profile.timeoutMs);
  timeout.unref();
  const maximum = options.response === 'wav' ? MAX_SPEECH_BYTES : MAX_STUDIO_JSON_BYTES;
  try {
    if (options.signal?.aborted) throw new ProviderCallError('cancelled', 'PROVIDER_CANCELLED', '调用在发送前已停止。', 409);
    const response = await fetch(baseUrl + endpoint, {
      method: 'POST', redirect: 'manual', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Accept: options.response === 'wav' ? 'audio/wav, application/octet-stream' : 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: encoded,
    });
    if (!response.ok) {
      throw await providerHttpError(response, controller);
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maximum) { controller.abort(); throw invalidResponse('PROVIDER_RESPONSE_TOO_LARGE'); }
    if (!response.body) throw invalidResponse();
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maximum) { controller.abort(); throw invalidResponse('PROVIDER_RESPONSE_TOO_LARGE'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    if (controller.signal.aborted) throw new Error('Interrupted response');
    if (!bytes) throw invalidResponse();
    return Buffer.concat(chunks, bytes);
  } catch (error) {
    if (error instanceof ProviderCallError) throw error;
    throw new ProviderCallError('submission_unknown', 'PROVIDER_SUBMISSION_UNKNOWN', timedOut ? '增强操作调用超时，远端是否已处理不明；请核对原请求，不会自动重发。' : '增强操作连接中断或已停止，远端是否已处理不明；请核对原请求，不会自动重发。', timedOut ? 504 : 502);
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abort);
  }
}

export async function postStudioJsonOnce(profile: ProviderProfile, key: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const bytes = await postStudioBytesOnce(profile, key, '/chat/completions', body, { signal, response: 'json' });
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw invalidResponse('PROVIDER_INVALID_JSON'); }
}
