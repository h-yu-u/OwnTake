import type { OpenAIModels } from '../../contracts/src/openai.ts';

/** Official OpenAI presets checked on 2026-11-08; account access is not inferred. */
export const OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const OPENAI_DEFAULT_MODELS: Readonly<OpenAIModels> = {
  reasoning: 'gpt-6.1-sol',
  image: 'gpt-image-2.6-flare',
  speech: 'gpt-4o-mini-tts',
};
export const OPENAI_MODEL_OPTIONS = {
  reasoning: ['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-astra', 'gpt-6-luna', 'gpt-6-sol', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'],
  image: ['gpt-image-2.6-flare', 'gpt-image-2.6-sunburst', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'gpt-image-2'],
  speech: ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'],
} as const;
export const OPENAI_CAPABILITIES = ['reasoning', 'image', 'speech'] as const;
export const OPENAI_CAPABILITY_LABELS = { reasoning: '分镜与画面审核', image: '图片生成', speech: '配音' } as const;
export const OPENAI_REQUEST_TIMEOUT_MS = 120_000;
export const OPENAI_MAX_OUTPUT_TOKENS = 8192;
export const OPENAI_SPEECH_SHUTDOWN_DATE = '2027-01-06';
export const OPENAI_SPEECH_VOICES = ['coral', 'alloy', 'ash', 'ballad', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar'] as const;
export const OPENAI_LEGACY_SPEECH_VOICES = ['alloy', 'ash', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer'] as const;
