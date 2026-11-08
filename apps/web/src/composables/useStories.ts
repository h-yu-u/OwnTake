import { ref } from 'vue';
import type { ScriptVersion, Story, StoryProjectLink, StoryVersion } from '../types.ts';
import { storyApi } from '../lib/storyApi.ts';

export function useStories() {
  const stories = ref<Story[]>([]);
  const selected = ref<Story | null>(null);
  const versions = ref<StoryVersion[]>([]);
  const scripts = ref<ScriptVersion[]>([]);
  const projects = ref<StoryProjectLink[]>([]);
  const loading = ref(false);
  const busy = ref(false);
  let selection = 0;
  async function refresh(q = ''): Promise<void> {
    loading.value = true;
    try {
      stories.value = await storyApi.list(q);
      // Filtering the index must not turn an open story into an unsaved new story.
      if (selected.value) selected.value = stories.value.find(item => item.id === selected.value?.id) ?? selected.value;
    } finally { loading.value = false; }
  }
  async function choose(id: string): Promise<void> {
    const current = ++selection;
    loading.value = true;
    try {
      const [story, nextVersions, nextScripts, nextProjects] = await Promise.all([
        storyApi.get(id), storyApi.versions(id), storyApi.scripts(id), storyApi.projects(id),
      ]);
      if (selection !== current) return;
      selected.value = story;
      versions.value = nextVersions;
      scripts.value = nextScripts;
      projects.value = nextProjects;
    } finally { if (selection === current) loading.value = false; }
  }
  async function mutate<T>(effect: () => Promise<T>, q = ''): Promise<T> {
    busy.value = true;
    try {
      const result = await effect();
      await refresh(q);
      if (selected.value) await choose(selected.value.id);
      return result;
    } finally { busy.value = false; }
  }
  return { stories, selected, versions, scripts, projects, loading, busy, refresh, choose, mutate };
}
