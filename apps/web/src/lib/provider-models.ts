import type { ProviderKind, ProviderListedModel } from '../types.ts';

/** Use explicit metadata only; unclassified IDs remain selectable, not assumed compatible. */
export function providerModelsForKind(models: ProviderListedModel[], kind: ProviderKind): ProviderListedModel[] {
  const modality = { 'ark-video': 'video', 'openai-images': 'image', 'openai-speech': 'audio', 'chat-completions': 'text' }[kind];
  const domains = { 'ark-video': ['VideoGeneration'], 'openai-images': ['ImageGeneration'], 'openai-speech': ['Audio'], 'chat-completions': ['LLM', 'VLM'] }[kind];
  return models.filter(model => model.domain ? domains.includes(model.domain) : model.outputModalities.length ? model.outputModalities.includes(modality) : true);
}
