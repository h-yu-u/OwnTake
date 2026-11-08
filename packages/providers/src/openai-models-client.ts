import { AppError, invariant } from '../../contracts/src/errors.ts';
import type { OpenAIModelCatalog } from '../../contracts/src/openai.ts';
import { parseOpenAIModelList } from './openai-model-catalog.ts';
import { OPENAI_BASE_URL } from './openai-presets.ts';

export const OPENAI_MODEL_LIST_TIMEOUT_MS = 15_000;
export const OPENAI_MODEL_LIST_MAX_BYTES = 2 * 1024 * 1024;

interface DiscoveryOptions {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

function rejected(status: number): AppError {
  if (status === 401) return new AppError('OPENAI_MODELS_AUTH_FAILED', 'OpenAI 未接受此 Key，请检查后重新读取模型。', 502);
  if (status === 403) return new AppError('OPENAI_MODELS_FORBIDDEN', '此 Key 无权读取模型列表。可以调整 Key 权限，或继续手动填写模型 ID。', 502);
  if (status === 429) return new AppError('OPENAI_MODELS_RATE_LIMITED', '读取模型列表受到限流，请稍后重试。', 502);
  return new AppError('OPENAI_MODELS_HTTP_ERROR', `读取 OpenAI 模型列表失败（HTTP ${status}），请稍后重试。`, 502);
}

/** A bounded metadata GET to the pinned official origin; no redirects, generation, retries, or persistence. */
export async function fetchOpenAIModels(key: string, options: DiscoveryOptions = {}): Promise<OpenAIModelCatalog> {
  invariant(typeof key === 'string' && key.length > 0 && key.length <= 8192 && !/[\u0000-\u0020\u007f-\uffff]/.test(key),
    'INVALID_KEY', 'API Key 应为不含空白或控制字符的 ASCII 文本。');
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, options.timeoutMs ?? OPENAI_MODEL_LIST_TIMEOUT_MS);
  timeout.unref();
  try {
    if (options.signal?.aborted) controller.abort();
    if (controller.signal.aborted) throw new Error('Cancelled');
    const response = await (options.fetch ?? fetch)(`${OPENAI_BASE_URL}/models`, {
      method: 'GET', redirect: 'manual', signal: controller.signal,
      headers: { Accept: 'application/json', Authorization: `Bearer ${key}` },
    });
    if (!response.ok) throw rejected(response.status);
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > OPENAI_MODEL_LIST_MAX_BYTES) throw new AppError('OPENAI_MODELS_TOO_LARGE', 'OpenAI 模型列表超过读取上限。请手动填写模型 ID。', 502);
    if (!response.body) throw new AppError('OPENAI_MODELS_INVALID_RESPONSE', 'OpenAI 返回了空的模型列表响应。', 502);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > OPENAI_MODEL_LIST_MAX_BYTES) throw new AppError('OPENAI_MODELS_TOO_LARGE', 'OpenAI 模型列表超过读取上限。请手动填写模型 ID。', 502);
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    if (controller.signal.aborted) throw new Error('Interrupted');
    let body: unknown;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new AppError('OPENAI_MODELS_INVALID_RESPONSE', 'OpenAI 返回的模型列表不是有效 JSON。', 502); }
    return { models: parseOpenAIModelList(body), fetchedAt: new Date().toISOString() };
  } catch (error) {
    if (timedOut) throw new AppError('OPENAI_MODELS_TIMEOUT', '读取 OpenAI 模型列表超时，请重试或手动填写模型 ID。', 504);
    if (options.signal?.aborted) throw new AppError('OPENAI_MODELS_CANCELLED', '已取消读取模型列表。', 409);
    if (error instanceof AppError) throw error;
    throw new AppError('OPENAI_MODELS_UNAVAILABLE', '暂时无法读取 OpenAI 模型列表，请检查网络后重试，或手动填写模型 ID。', 502);
  } finally {
    clearTimeout(timeout);
    controller.abort();
    options.signal?.removeEventListener('abort', abort);
  }
}
