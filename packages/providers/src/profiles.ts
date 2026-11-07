import { AppError, invariant } from '../../contracts/src/errors.ts';
import type { ProviderCapabilities, ProviderInputMode, ProviderKind, ProviderProfile } from '../../contracts/src/providers.ts';
import type { Ratio } from '../../contracts/src/index.ts';

export function strictRecord(value: unknown, keys: readonly string[], code = 'INVALID_PROVIDER'): Record<string, unknown> {
  invariant(value !== null && typeof value === 'object' && !Array.isArray(value), code, '配置必须是普通对象。');
  const prototype = Object.getPrototypeOf(value);
  invariant((prototype === Object.prototype || prototype === null) && Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key)), code, '配置包含不允许的字段。');
  return value as Record<string, unknown>;
}
export function boundedText(value: unknown, max: number, code = 'INVALID_PROVIDER', allowEmpty = false): string {
  invariant(typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value), code, '文本字段无效或超过长度限制。');
  const result = value.trim();
  invariant(allowEmpty || result.length > 0, code, '文本字段不能为空。');
  return result;
}
function integer(value: unknown, min: number, max: number): number {
  invariant(typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max, 'INVALID_PROVIDER', '数值配置超出允许范围。');
  return value;
}
function enumeration<T extends string>(value: unknown, choices: readonly T[]): T {
  invariant(typeof value === 'string' && choices.includes(value as T), 'INVALID_PROVIDER', '配置枚举值无效。');
  return value as T;
}
function list<T extends string>(value: unknown, choices: readonly T[]): T[] {
  invariant(Array.isArray(value) && value.length <= choices.length, 'INVALID_PROVIDER', '能力清单无效。');
  const items = value.map(item => enumeration(item, choices));
  invariant(new Set(items).size === items.length, 'INVALID_PROVIDER', '能力清单不能包含重复项。');
  return items;
}

export function normalizeBaseUrl(value: unknown): string {
  const source = boundedText(value, 2048);
  let url: URL;
  try { url = new URL(source); } catch { throw new AppError('INVALID_PROVIDER', '模型端点必须是完整的 HTTPS URL 或本机 HTTP URL。'); }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  invariant(url.protocol === 'https:' || url.protocol === 'http:' && local, 'INVALID_PROVIDER', '远端模型必须使用 HTTPS；HTTP 仅允许 localhost 或 127.0.0.1。');
  invariant(!url.username && !url.password && !source.includes('?') && !source.includes('#'), 'INVALID_PROVIDER', '模型端点不能包含凭据、查询参数或片段。');
  return url.toString().replace(/\/+$/, '');
}

export function validateProfile(value: unknown): ProviderProfile {
  const input = strictRecord(value, ['id', 'label', 'kind', 'baseUrl', 'model', 'capabilities', 'maxOutputTokens', 'timeoutMs', 'createdAt', 'updatedAt']);
  const id = boundedText(input.id, 128);
  invariant(/^[A-Za-z0-9_-]+$/.test(id), 'INVALID_PROVIDER', '连接标识无效。');
  const kind = enumeration<ProviderKind>(input.kind, ['chat-completions', 'openai-images', 'openai-image-edits', 'ark-video', 'openai-speech']);
  const rawCapabilities = strictRecord(input.capabilities, ['inputModes', 'ratios', 'durationsSec', 'maxReferences', 'speech', 'frameReview']);
  const inputModes = list<ProviderInputMode>(rawCapabilities.inputModes, ['text', 'first_frame', 'first_last_frame', 'references']);
  invariant(inputModes.length > 0, 'INVALID_PROVIDER', '请至少声明一种输入方式。');
  invariant(Array.isArray(rawCapabilities.durationsSec) && rawCapabilities.durationsSec.length <= 100, 'INVALID_PROVIDER', '时长能力清单无效。');
  const durationsSec = rawCapabilities.durationsSec.map(value => {
    invariant(typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 600, 'INVALID_PROVIDER', '单次生成时长能力必须介于 0–600 秒。');
    return value;
  });
  invariant(new Set(durationsSec).size === durationsSec.length, 'INVALID_PROVIDER', '时长能力清单不能包含重复项。');
  const capabilities: ProviderCapabilities = { inputModes, ratios: list<Ratio>(rawCapabilities.ratios, ['16:9', '9:16', '1:1']), durationsSec, maxReferences: integer(rawCapabilities.maxReferences, 0, 16) };
  if (rawCapabilities.speech !== undefined) {
    invariant(kind === 'openai-speech', 'INVALID_PROVIDER', '配音能力须声明在 Speech 连接上。');
    const speech = strictRecord(rawCapabilities.speech, ['voices', 'supportsInstructions', 'minSpeed', 'maxSpeed', 'maxInputChars']);
    invariant(Array.isArray(speech.voices) && speech.voices.length > 0 && speech.voices.length <= 100, 'INVALID_PROVIDER', '配音连接须声明 1–100 个可用声音。');
    const voices = speech.voices.map(value => boundedText(value, 128));
    invariant(new Set(voices).size === voices.length, 'INVALID_PROVIDER', '可用声音不能重复。');
    invariant(typeof speech.supportsInstructions === 'boolean', 'INVALID_PROVIDER', '须明确声明是否支持配音指令。');
    invariant(typeof speech.minSpeed === 'number' && Number.isFinite(speech.minSpeed) && speech.minSpeed >= 0.25 && typeof speech.maxSpeed === 'number' && Number.isFinite(speech.maxSpeed) && speech.maxSpeed <= 4 && speech.minSpeed <= speech.maxSpeed, 'INVALID_PROVIDER', '配音语速范围须在 0.25–4 之间。');
    capabilities.speech = { voices, supportsInstructions: speech.supportsInstructions, minSpeed: speech.minSpeed, maxSpeed: speech.maxSpeed, maxInputChars: integer(speech.maxInputChars, 1, 4096) };
  }
  if (rawCapabilities.frameReview !== undefined) {
    invariant(kind === 'chat-completions', 'INVALID_PROVIDER', '抽帧审核能力须声明在 Chat Completions 连接上。');
    const review = strictRecord(rawCapabilities.frameReview, ['maxImages']);
    capabilities.frameReview = { maxImages: integer(review.maxImages, 1, 16) };
  }
  const createdAt = boundedText(input.createdAt, 64), updatedAt = boundedText(input.updatedAt, 64);
  invariant(Number.isFinite(Date.parse(createdAt)) && Number.isFinite(Date.parse(updatedAt)), 'INVALID_PROVIDER', '连接时间字段无效。');
  return {
    id, label: boundedText(input.label, 120), kind,
    baseUrl: normalizeBaseUrl(input.baseUrl), model: boundedText(input.model, 200), capabilities,
    maxOutputTokens: integer(input.maxOutputTokens ?? 4096, 1, 8192), timeoutMs: integer(input.timeoutMs ?? 60_000, 1, 120_000), createdAt, updatedAt,
  };
}
