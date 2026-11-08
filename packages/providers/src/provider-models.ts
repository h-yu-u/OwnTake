import { AppError, invariant } from '../../contracts/src/errors.ts';
import type { ProviderListedModel, ProviderModelCatalog } from '../../contracts/src/providers.ts';
import { normalizeBaseUrl } from './profiles.ts';

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ITEMS = 10_000;
const domains = new Set(['LLM', 'VLM', 'ImageGeneration', 'VideoGeneration', '3DGeneration', 'Audio', 'Embedding']);
const modalities = new Set(['text', 'image', 'video', 'audio', '3D', 'embedding']);
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function invalid(): AppError { return new AppError('PROVIDER_MODELS_INVALID_RESPONSE', '服务返回的模型列表格式无效，可继续手动填写模型 ID。', 502); }

/** Catalog metadata is not proof of inference permission or supported generation parameters. */
export function parseProviderModelList(value: unknown): ProviderListedModel[] {
  const body = object(value);
  if (!body || body.object !== undefined && body.object !== 'list' || !Array.isArray(body.data) || body.data.length > MAX_ITEMS) throw invalid();
  const models = new Map<string, ProviderListedModel>();
  for (const entry of body.data) {
    const item = object(entry);
    if (!item || item.object !== undefined && item.object !== 'model' || typeof item.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(item.id)) throw invalid();
    const name = item.name ?? null;
    if (name !== null && (typeof name !== 'string' || name.length > 200 || /[\u0000-\u001f\u007f]/.test(name))) throw invalid();
    const output = object(item.modalities)?.output_modalities ?? [];
    if (!Array.isArray(output) || output.length > 8 || output.some(value => typeof value !== 'string')) throw invalid();
    if (!models.has(item.id)) models.set(item.id, {
      id: item.id, name,
      domain: typeof item.domain === 'string' && domains.has(item.domain) ? item.domain : null,
      outputModalities: [...new Set(output.filter(value => modalities.has(value)))],
    });
  }
  return [...models.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function rejected(status: number): AppError {
  const message = status === 401 ? '服务未接受此 Key，请检查后重新读取模型。'
    : status === 403 ? '此 Key 无权读取模型列表，可检查权限或手动填写模型 ID。'
    : status === 404 || status === 405 ? '此服务未提供模型列表接口，请手动填写模型 ID。'
    : status === 429 ? '读取模型列表受到限流，请稍后手动刷新。'
    : `读取模型列表失败（HTTP ${status}），可手动刷新或填写模型 ID。`;
  return new AppError('PROVIDER_MODELS_HTTP_ERROR', message, 502);
}

/** One metadata GET to the user's configured origin, with no redirects, retries or persistence. */
export async function fetchProviderModels(baseUrl: string, key: string, options: { fetch?: typeof fetch; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<ProviderModelCatalog> {
  const url = normalizeBaseUrl(baseUrl);
  invariant(typeof key === 'string' && key.length <= 8192 && !/[\u0000-\u0020\u007f-\uffff]/.test(key), 'INVALID_KEY', 'API Key 应为不含空白或控制字符的 ASCII 文本。');
  invariant(key || ['localhost', '127.0.0.1'].includes(new URL(url).hostname), 'CREDENTIAL_REQUIRED', '请先填写该服务的 API Key。', 409);
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, options.timeoutMs ?? 15_000);
  timeout.unref();
  try {
    if (options.signal?.aborted) controller.abort();
    if (controller.signal.aborted) throw new Error('Cancelled');
    const response = await (options.fetch ?? fetch)(`${url}/models`, {
      method: 'GET', redirect: 'manual', signal: controller.signal,
      headers: { Accept: 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    });
    if (!response.ok) throw rejected(response.status);
    const tooLarge = (): AppError => new AppError('PROVIDER_MODELS_TOO_LARGE', '模型列表超过读取上限，请手动填写模型 ID。', 502);
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_BYTES) throw tooLarge();
    if (!response.body) throw invalid();
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_BYTES) throw tooLarge();
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    if (controller.signal.aborted) throw new Error('Interrupted');
    let body: unknown;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw invalid(); }
    const models = parseProviderModelList(body);
    if (key && JSON.stringify(models).includes(key)) throw invalid();
    return { models, fetchedAt: new Date().toISOString() };
  } catch (error) {
    if (timedOut) throw new AppError('PROVIDER_MODELS_TIMEOUT', '读取模型列表超时，可手动刷新或填写模型 ID。', 504);
    if (options.signal?.aborted) throw new AppError('PROVIDER_MODELS_CANCELLED', '已取消读取模型列表。', 409);
    if (error instanceof AppError) throw error;
    throw new AppError('PROVIDER_MODELS_UNAVAILABLE', '暂时无法读取模型列表，请检查服务地址与网络，或手动填写模型 ID。', 502);
  } finally {
    clearTimeout(timeout); controller.abort(); options.signal?.removeEventListener('abort', abort);
  }
}
