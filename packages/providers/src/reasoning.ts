import { invariant } from '../../contracts/src/errors.ts';
import type { ProviderProfile, ReasoningInput, ReasoningResult, ReasoningUsage } from '../../contracts/src/providers.ts';
import { parseDraftOperations, parseShotFields } from '../../domain/src/storyboard.ts';
import { strictRecord, validateProfile } from './profiles.ts';
import { invalidResponse } from './errors.ts';
import { postJsonOnce } from './http.ts';
import { directorInstruction, draftResponseSchema } from './reasoning-schema.ts';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidResponse();
  return value as Record<string, unknown>;
}
function parseUsage(value: unknown): ReasoningUsage | undefined {
  if (value === undefined) return undefined;
  const raw = object(value);
  const [inputTokens, outputTokens, totalTokens] = ['prompt_tokens', 'completion_tokens', 'total_tokens'].map(key => {
    const count = raw[key];
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || count > 1_000_000_000) throw invalidResponse('PROVIDER_INVALID_USAGE');
    return count;
  });
  return { inputTokens: inputTokens!, outputTokens: outputTokens!, totalTokens: totalTokens! };
}

export async function callReasoning(value: ProviderProfile, key: string, rawInput: ReasoningInput): Promise<ReasoningResult> {
  const profile = validateProfile(value);
  invariant(profile.kind === 'chat-completions', 'PROVIDER_KIND_UNSUPPORTED', '分镜推理需要 Chat Completions 连接。');
  invariant(profile.capabilities.inputModes.includes('text'), 'PROVIDER_CAPABILITY_UNSUPPORTED', '所选推理连接没有声明文本输入能力。');
  const input = strictRecord(rawInput, ['brief', 'shots', 'signal'], 'INVALID_REASONING_INPUT');
  invariant(typeof input.brief === 'string' && input.brief.trim().length > 0 && input.brief.length <= 20_000 && !input.brief.includes('\0'), 'INVALID_REASONING_INPUT', '请填写不超过 20000 字符的创作简报。');
  invariant(Array.isArray(input.shots) && input.shots.length <= 100, 'INVALID_REASONING_INPUT', '推理上下文最多包含 100 个镜头。');
  const shotIds = new Set<string>(), artifactIds = new Set<string>();
  const shots = input.shots.map(shot => {
    invariant(shot && typeof shot === 'object' && typeof shot.id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(shot.id) && !shotIds.has(shot.id), 'INVALID_REASONING_INPUT', '镜头标识无效或重复。');
    invariant(Number.isSafeInteger(shot.revision) && shot.revision >= 1, 'INVALID_REASONING_INPUT', '镜头修订版本无效。');
    shotIds.add(shot.id);
    const fields = parseShotFields({ title: shot.title, purpose: shot.purpose, description: shot.description, action: shot.action, durationMs: shot.durationMs, caption: shot.caption, mode: shot.mode, referenceArtifactIds: shot.referenceArtifactIds });
    for (const id of fields.referenceArtifactIds) artifactIds.add(id);
    return { id: shot.id, revision: shot.revision, ...fields };
  });
  const response = object(await postJsonOnce(profile, key, '/chat/completions', {
    model: profile.model, messages: [{ role: 'system', content: directorInstruction }, { role: 'user', content: JSON.stringify({ brief: input.brief, shots }) }],
    // The API rejects tool_choice without tools, including the value "none".
    max_completion_tokens: profile.maxOutputTokens, stream: false, n: 1, store: false,
    response_format: { type: 'json_schema', json_schema: { name: 'owntake_storyboard_draft', strict: true, schema: draftResponseSchema } },
  }, rawInput.signal));
  if (!Array.isArray(response.choices) || response.choices.length !== 1) throw invalidResponse();
  const choice = object(response.choices[0]), message = object(choice.message);
  if (choice.finish_reason !== 'stop') throw invalidResponse('PROVIDER_INCOMPLETE_RESPONSE');
  const hasToolCalls = message.tool_calls != null && !(Array.isArray(message.tool_calls) && message.tool_calls.length === 0);
  if (message.role !== 'assistant' || typeof message.content !== 'string' || hasToolCalls || message.function_call != null || message.refusal) throw invalidResponse();
  let operations;
  try {
    const draft = strictRecord(JSON.parse(message.content), ['operations'], 'INVALID_STORYBOARD');
    operations = parseDraftOperations(draft.operations);
    for (const operation of operations) {
      if (operation.shotId && !shotIds.has(operation.shotId)) throw new Error('Unknown shot');
      if (operation.fields?.referenceArtifactIds.some(id => !artifactIds.has(id))) throw new Error('Unknown reference');
    }
  } catch { throw invalidResponse(); }
  const usage = parseUsage(response.usage);
  return { operations, ...(usage ? { usage } : {}) };
}
