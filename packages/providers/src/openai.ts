import { invariant } from '../../contracts/src/errors.ts';
import type { OpenAICapability, OpenAIConnection, OpenAIConnectionInput } from '../../contracts/src/openai.ts';
import type { ProviderProfile } from '../../contracts/src/providers.ts';
import { boundedText, strictRecord, validateProfile } from './profiles.ts';
import {
  OPENAI_BASE_URL, OPENAI_CAPABILITY_LABELS, OPENAI_LEGACY_SPEECH_VOICES,
  OPENAI_MAX_OUTPUT_TOKENS, OPENAI_REQUEST_TIMEOUT_MS, OPENAI_SPEECH_VOICES,
} from './openai-presets.ts';

const invalid = 'INVALID_OPENAI_CONNECTION';

/** Validate the complete account before any vault or database mutation. */
export function parseOpenAIConnectionInput(value: unknown, updating: boolean): OpenAIConnectionInput & { expectedRevision?: number } {
  const input = strictRecord(value, updating ? ['label', 'models', 'key', 'expectedRevision'] : ['label', 'models', 'key'], invalid);
  const models = strictRecord(input.models, ['reasoning', 'image', 'speech'], invalid);
  invariant(input.key === undefined || typeof input.key === 'string' && input.key.length <= 8192, 'INVALID_KEY', 'API 密钥必须是有效文本。');
  if (updating) invariant(Number.isSafeInteger(input.expectedRevision) && (input.expectedRevision as number) >= 1,
    invalid, '更新 OpenAI 连接需要有效的当前版本。');
  return {
    label: boundedText(input.label, 100, invalid),
    models: {
      reasoning: boundedText(models.reasoning, 200, invalid),
      image: boundedText(models.image, 200, invalid),
      speech: boundedText(models.speech, 200, invalid),
    },
    ...(input.key === undefined ? {} : { key: (input.key as string).trim() }),
    ...(updating ? { expectedRevision: input.expectedRevision as number } : {}),
  };
}

/** Reuse the existing protocol adapters without duplicating credentials or execution paths. */
export function openAIProfiles(connection: OpenAIConnection): Record<OpenAICapability, ProviderProfile> {
  const common = {
    baseUrl: OPENAI_BASE_URL,
    maxOutputTokens: OPENAI_MAX_OUTPUT_TOKENS,
    timeoutMs: OPENAI_REQUEST_TIMEOUT_MS,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
  const textCapabilities = { inputModes: ['text'], ratios: [], durationsSec: [], maxReferences: 0 };
  const supportsInstructions = /^gpt-4o-mini-tts(?:-|$)/.test(connection.models.speech);
  return {
    reasoning: validateProfile({
      ...common, id: connection.profileIds.reasoning, label: `${connection.label} · ${OPENAI_CAPABILITY_LABELS.reasoning}`,
      kind: 'chat-completions', model: connection.models.reasoning,
      capabilities: { ...textCapabilities, frameReview: { maxImages: 3 } },
    }),
    image: validateProfile({
      ...common, id: connection.profileIds.image, label: `${connection.label} · ${OPENAI_CAPABILITY_LABELS.image}`,
      kind: 'openai-images', model: connection.models.image,
      capabilities: { ...textCapabilities, ratios: ['16:9', '9:16', '1:1'] },
    }),
    speech: validateProfile({
      ...common, id: connection.profileIds.speech, label: `${connection.label} · ${OPENAI_CAPABILITY_LABELS.speech}`,
      kind: 'openai-speech', model: connection.models.speech,
      capabilities: {
        ...textCapabilities,
        speech: {
          voices: [...(supportsInstructions ? OPENAI_SPEECH_VOICES : OPENAI_LEGACY_SPEECH_VOICES)],
          supportsInstructions, minSpeed: 0.25, maxSpeed: 4, maxInputChars: 4096,
        },
      },
    }),
  };
}
