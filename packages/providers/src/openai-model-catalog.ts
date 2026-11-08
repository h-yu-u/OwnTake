import { AppError } from '../../contracts/src/errors.ts';
import type { OpenAICapability, OpenAIListedModel } from '../../contracts/src/openai.ts';

export const OPENAI_MODEL_LIST_MAX_ITEMS = 10_000;
export type OpenAIModelGroup = OpenAICapability | 'other' | 'unknown';

/** A name-based browsing hint only. Unknown future IDs remain available for manual selection. */
export function classifyOpenAIModel(id: string): OpenAIModelGroup {
  const name = (id.startsWith('ft:') ? id.split(':')[1] ?? id : id).toLowerCase();
  if (/^gpt-image-/.test(name)) return 'image';
  if (/^gpt-4o-mini-tts(?:-\d{4}-\d{2}-\d{2})?$/.test(name) || /^tts-1(?:-hd)?(?:-\d{4})?$/.test(name)) return 'speech';
  if (/(?:^|[-_])(?:embedding[s]?|realtime|audio|transcribe|transcription|live|whisper|codex|pro|cyber|rosalind|search|moderation)(?:[-_]|$)/.test(name)
    || /deep-research|chat-latest/.test(name) || /^(?:dall-e|sora|babbage|davinci|gpt-3|gpt-4(?:-|$))/.test(name)) return 'other';
  const base = name.replace(/-\d{4}-\d{2}-\d{2}$/, '');
  if (/^gpt-6(?:\.\d+)?-(?:astra|sol|terra|luna)$/.test(base)
    || /^gpt-5(?:\.\d+)?(?:-(?:mini|nano|sol|terra|luna))?$/.test(base)
    || /^gpt-(?:4\.1|4o)(?:-(?:mini|nano))?$/.test(base)
    || /^o(?:1|3|4)(?:-mini)?$/.test(base)) return 'reasoning';
  return 'unknown';
}

function invalidCatalog(): AppError {
  return new AppError('OPENAI_MODELS_INVALID_RESPONSE', 'OpenAI 返回的模型列表格式无效，请稍后重试或手动填写模型 ID。', 502);
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/** Keep only documented metadata, reject malformed lists, and make duplicate/order handling stable. */
export function parseOpenAIModelList(value: unknown): OpenAIListedModel[] {
  if (!object(value) || value.object !== 'list' || !Array.isArray(value.data) || value.data.length > OPENAI_MODEL_LIST_MAX_ITEMS) throw invalidCatalog();
  const models = new Map<string, OpenAIListedModel>();
  for (const item of value.data) {
    if (!object(item) || item.object !== 'model'
      || typeof item.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(item.id)
      || !Number.isSafeInteger(item.created) || (item.created as number) < 0
      || typeof item.owned_by !== 'string' || !item.owned_by.trim() || item.owned_by.length > 200 || /[\u0000-\u001f\u007f]/.test(item.owned_by)) throw invalidCatalog();
    const shutdownDate = item.shutdown_date ?? null;
    if (shutdownDate !== null && (typeof shutdownDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(shutdownDate)
      || !Number.isFinite(Date.parse(shutdownDate)) || new Date(shutdownDate).toISOString().slice(0, 10) !== shutdownDate)) throw invalidCatalog();
    if (!models.has(item.id)) models.set(item.id, {
      id: item.id, created: item.created as number, ownedBy: item.owned_by, shutdownDate,
    });
  }
  return [...models.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
