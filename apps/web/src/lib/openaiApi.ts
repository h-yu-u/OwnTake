import type { OpenAIConnectionInput, OpenAIConnectionSummary, OpenAIConnectionUpdate, OpenAIModelCatalog, OpenAIModelDiscoveryInput } from '../types.ts';
import { request } from './api.ts';

export type OpenAIConnectionSave =
  | { id: null; input: OpenAIConnectionInput }
  | { id: string; input: OpenAIConnectionUpdate };

function write(path: string, input: OpenAIConnectionInput | OpenAIConnectionUpdate, method = 'POST'): Promise<OpenAIConnectionSummary> {
  return request<OpenAIConnectionSummary>(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export const openaiApi = {
  list: () => request<OpenAIConnectionSummary[]>('/openai-connections'),
  create: (input: OpenAIConnectionInput) => write('/openai-connections', input),
  update: (id: string, input: OpenAIConnectionUpdate) => write(`/openai-connections/${encodeURIComponent(id)}`, input, 'PUT'),
  models: (input: OpenAIModelDiscoveryInput, signal?: AbortSignal) => request<OpenAIModelCatalog>('/openai-connections/models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal,
  }),
};
