import type { DiscoveryImport, DiscoveryResult, DiscoverySource, Story } from '../types.ts';
import { request } from './api.ts';
export const discoveryApi = {
  status: () => request<{configured: boolean; sources: DiscoverySource[]}>('/story-discovery/status'),
  search: (source: DiscoverySource, q: string) => request<DiscoveryResult[]>(`/story-discovery?source=${source}&q=${encodeURIComponent(q)}`),
  save: (input: DiscoveryImport) => request<Story>('/story-discovery/save', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  }),
};
