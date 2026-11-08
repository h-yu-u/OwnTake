<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue';
import { NAlert, NButton, NInput, NSelect, NTag, useDialog, useMessage } from 'naive-ui';
import type { Ratio, StoryInput, StoryRights, StorySource } from '../types.ts';
import { useStories } from '../composables/useStories.ts';
import { storyApi } from '../lib/storyApi.ts';
import { errorMessage } from '../lib/api.ts';
import { formatDate } from '../lib/timeline.ts';
import AppIcon from '../components/AppIcon.vue';
import EmptyState from '../components/EmptyState.vue';

const emit = defineEmits<{ 'project-created': [id: string] }>();
const state = useStories(), message = useMessage(), dialog = useDialog();
const query = ref(''), error = ref(''), tab = ref('story');
const editing = ref(false), textScript = ref(''), ratio = ref<Ratio>('16:9');
const genre = ref(''), title = ref(''), summary = ref(''), tags = ref(''), beats = ref('');
const source = ref<StorySource>({ platform: 'original', url: '', title: '', author: '', rights: 'original' });
const latest = computed(() => state.versions.value.at(-1));
const recentScript = computed(() => state.scripts.value.at(-1));
const locked = computed(() => state.busy.value || state.loading.value);
const writable = computed(() => title.value.trim().length > 0 && !locked.value);
const isExternalRestricted = computed(() => !['original', 'licensed'].includes(state.selected.value?.source.rights ?? 'original'));
const rightsLabels: Record<StoryRights, string> = { original: '原创', licensed: '已授权', inspiration_only: '仅作灵感', unknown: '授权待确认' };
const tabs = computed(() => [{ id: 'story', label: '故事设定' }, ...(state.selected.value ? [{ id: 'script', label: '剧本' }, { id: 'project', label: '创建作品' }] : [])]);
function inputKey(value: StoryInput) { return JSON.stringify([value.title, value.genre, value.summary, value.tags, value.beats, value.source.platform, value.source.url, value.source.title, value.source.author, value.source.rights]); }
const storyDirty = computed(() => editing.value && (state.selected.value && latest.value
  ? inputKey(payload()) !== inputKey(latest.value)
  : Boolean(title.value.trim() || genre.value.trim() || summary.value.trim() || tags.value.trim() || beats.value.trim())));
const scriptDirty = computed(() => editing.value && Boolean(state.selected.value) && textScript.value !== (recentScript.value?.text ?? ''));
function confirmSwitch(action: () => void) {
  if (locked.value) return;
  if (!storyDirty.value && !scriptDirty.value) { action(); return; }
  dialog.warning({ title: '离开当前故事？', content: '故事或剧本还有未保存的修改，继续将放弃这些输入。', positiveText: '放弃修改并继续', negativeText: '继续编辑', onPositiveClick: action });
}
function clearEditor(): void {
  confirmSwitch(() => {
    state.selected.value = null;
    editing.value = true; tab.value = 'story'; title.value = ''; genre.value = ''; summary.value = ''; tags.value = ''; beats.value = ''; textScript.value = '';
    source.value = { platform: 'original', url: '', title: '', author: '', rights: 'original' };
  });
}
function choose(id: string) {
  if (id === state.selected.value?.id) return;
  confirmSwitch(() => { void select(id); });
}
async function select(id: string): Promise<void> {
  try {
    error.value = '';
    await state.choose(id);
    const current = state.selected.value, version = state.versions.value.at(-1);
    if (!current) return;
    editing.value = true; tab.value = 'story'; title.value = current.title; genre.value = current.genre; summary.value = current.summary;
    tags.value = current.tags.join('，'); beats.value = version?.beats.join('\n') ?? '';
    source.value = { ...current.source }; textScript.value = state.scripts.value.at(-1)?.text ?? '';
  } catch (failure) { error.value = errorMessage(failure); }
}
function payload(): StoryInput {
  return { title: title.value.trim(), genre: genre.value.trim(), summary: summary.value.trim(),
    tags: tags.value.split(/[,，、]/u).map(item => item.trim()).filter(Boolean),
    beats: beats.value.split(/\n+/u).map(item => item.trim()).filter(Boolean), source: { ...source.value } };
}
async function search(): Promise<void> { try { error.value = ''; await state.refresh(query.value); } catch (failure) { error.value = errorMessage(failure); } }
async function save(): Promise<void> {
  if (!writable.value) return;
  try {
    error.value = '';
    const value = payload(), selected = state.selected.value, scriptInput = textScript.value;
    const saved = selected
      ? await state.mutate(() => storyApi.update(selected.id, value, selected.revision), query.value)
      : await state.mutate(() => storyApi.create(value), query.value);
    await select(saved.id); textScript.value = scriptInput;
    message.success(selected ? '故事新版本已保存' : '已加入故事库');
  } catch (failure) { error.value = errorMessage(failure); }
}
async function saveScript(): Promise<void> {
  const selected = state.selected.value, version = latest.value;
  if (!selected || !version || !textScript.value.trim() || locked.value) return;
  try {
    error.value = '';
    await state.mutate(() => storyApi.saveScript(selected.id, version.version, textScript.value), query.value);
    message.success('剧本已保存为独立版本，旧版本不会被覆盖');
  } catch (failure) { error.value = errorMessage(failure); }
}
async function createProject(): Promise<void> {
  const current = state.selected.value, version = latest.value;
  if (!current || !version || isExternalRestricted.value || locked.value || storyDirty.value || scriptDirty.value) return;
  try {
    error.value = '';
    const result = await state.mutate(() => storyApi.createProject(current.id, version.version, recentScript.value?.version ?? null, ratio.value), query.value);
    message.success('已从故事创建作品'); emit('project-created', result.project.id);
  } catch (failure) { error.value = errorMessage(failure); }
}
async function navigate(event: KeyboardEvent, index: number) {
  const next = event.key === 'ArrowRight' ? (index + 1) % tabs.value.length : event.key === 'ArrowLeft' ? (index + tabs.value.length - 1) % tabs.value.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.value.length - 1 : -1;
  if (next < 0) return;
  event.preventDefault(); tab.value = tabs.value[next]!.id;
  await nextTick(); document.getElementById(`library-tab-${tab.value}`)?.focus();
}
onMounted(async () => { await search(); if (state.stories.value[0]) await select(state.stories.value[0].id); });
</script>

<template>
  <div class="library-page readable-view">
    <header class="page-heading"><div><p class="eyebrow">STORY LIBRARY</p><h1>故事库</h1><p class="subheading">收好灵感，写成剧本，再让故事有画面。</p></div><NButton type="primary" :disabled="locked" @click="clearEditor"><template #icon><AppIcon name="plus" :size="17" /></template>新建原创故事</NButton></header>
    <NAlert v-if="error" type="error" :show-icon="false" closable class="library-alert" @close="error = ''">{{ error }}</NAlert>
    <div class="library-layout">
      <section class="library-index panel" aria-label="故事列表">
        <div class="library-index-heading"><h2>{{ query.trim() ? '搜索结果' : '全部故事' }} <span class="count">{{ state.stories.value.length }}</span></h2><span v-if="state.loading.value" role="status" class="small muted">载入中…</span></div>
        <form class="library-search" @submit.prevent="search"><NInput v-model:value="query" :input-props="{ 'aria-label': '搜索故事' }" clearable :maxlength="100" :disabled="state.busy.value" placeholder="搜索标题、题材或剧情" /><NButton attr-type="submit" :loading="state.loading.value" :disabled="state.busy.value">搜索</NButton></form>
        <div class="library-story-list" tabindex="0" aria-label="故事列表内容">
          <div v-if="!state.stories.value.length && !state.loading.value" class="library-list-empty"><AppIcon name="folder" :size="28" /><strong>{{ query.trim() ? '没有找到匹配的故事' : '还没有故事' }}</strong><p>{{ query.trim() ? '试试其他关键词，当前编辑的内容仍会保留。' : '新建一篇原创故事，记下第一份灵感。' }}</p></div>
          <button v-for="story in state.stories.value" :key="story.id" class="library-item" :class="{ active: state.selected.value?.id === story.id }" :aria-pressed="state.selected.value?.id === story.id" :disabled="locked" @click="choose(story.id)">
            <span class="library-item-top"><strong>{{ story.title }}</strong><span class="library-origin">{{ rightsLabels[story.source.rights] }}</span></span>
            <span class="library-item-summary">{{ story.summary || '还没有填写剧情简介' }}</span>
            <span class="library-item-tags"><span v-if="story.genre">{{ story.genre }}</span><span v-for="tag in story.tags.slice(0, 3)" :key="tag">#{{ tag }}</span></span>
            <span class="library-item-meta"><span>故事 v{{ story.revision }}</span><span>{{ formatDate(story.updatedAt) }}</span></span>
          </button>
        </div>
      </section>
      <section class="library-editor panel" aria-label="故事工作区">
        <EmptyState v-if="!editing" :title="state.loading.value ? '正在打开故事…' : '从一个想法开始'" description="写下故事概要和剧情节点，再把它打磨成剧本。" icon="storyboard"><NButton v-if="!state.loading.value" type="primary" @click="clearEditor">写第一篇故事</NButton></EmptyState>
        <template v-else>
          <div class="library-editor-heading"><div><p class="eyebrow">{{ state.selected.value ? 'STORY WORKSPACE' : 'NEW STORY' }}</p><h2>{{ title.trim() || '新建原创故事' }}</h2><p>{{ state.selected.value ? `${genre.trim() || '未分类'} · 故事 v${state.selected.value.revision}` : '先保存故事设定，即可继续编写剧本或创建作品。' }}</p></div><NTag v-if="storyDirty || scriptDirty" size="small" type="warning" :bordered="false">未保存</NTag><NTag v-else-if="state.selected.value" size="small" :bordered="false">已保存</NTag></div>
          <div class="library-tabs" role="tablist" aria-label="故事工作区分类"><button v-for="(item, index) in tabs" :id="`library-tab-${item.id}`" :key="item.id" role="tab" :aria-selected="tab === item.id" :aria-controls="`library-panel-${item.id}`" :tabindex="tab === item.id ? 0 : -1" @click="tab = item.id" @keydown="navigate($event, index)">{{ item.label }}</button></div>
          <div v-show="tab === 'story'" id="library-panel-story" class="library-pane" role="tabpanel" aria-labelledby="library-tab-story">
            <div class="library-pane-body" tabindex="0" aria-label="故事设定内容">
              <div class="library-form-row"><label>故事标题<NInput v-model:value="title" :input-props="{ 'aria-label': '故事标题' }" :disabled="locked" maxlength="200" placeholder="给故事起一个名字" /></label><label>题材<NInput v-model:value="genre" :input-props="{ 'aria-label': '故事题材' }" :disabled="locked" maxlength="80" placeholder="悬疑、爱情、喜剧……" /></label></div>
              <label>故事概要<NInput v-model:value="summary" :input-props="{ 'aria-label': '故事概要' }" :disabled="locked" type="textarea" :autosize="{ minRows: 3, maxRows: 7 }" maxlength="10000" show-count placeholder="用一段话写下人物、冲突与故事走向" /></label>
              <label>标签<NInput v-model:value="tags" :input-props="{ 'aria-label': '故事标签' }" :disabled="locked" placeholder="都市，反转，雨夜（用逗号分隔）" /></label>
              <label>剧情节点 <span class="library-label-note">每行一个，按故事顺序填写</span><NInput v-model:value="beats" :input-props="{ 'aria-label': '剧情节点' }" :disabled="locked" type="textarea" :autosize="{ minRows: 4, maxRows: 10 }" placeholder="开头钩子&#10;冲突升级&#10;故事反转" /></label>
              <div v-if="source.platform !== 'original'" class="library-source"><span class="muted">故事来源</span><a :href="source.url" target="_blank" rel="noopener noreferrer">{{ source.title || source.url }}</a><NTag size="small" :bordered="false">{{ rightsLabels[source.rights] }}</NTag></div>
            </div>
            <div class="library-pane-footer"><span>{{ state.selected.value ? `${state.versions.value.length} 个故事版本 · 保存后保留旧版` : '把这份灵感加入故事库' }}</span><NButton type="primary" :loading="state.busy.value" :disabled="!writable" @click="save">{{ state.selected.value ? '保存故事版本' : '创建故事' }}</NButton></div>
          </div>
          <div v-show="tab === 'script'" id="library-panel-script" class="library-pane" role="tabpanel" aria-labelledby="library-tab-script">
            <div class="library-pane-body library-script-body" tabindex="0" aria-label="剧本内容">
              <div class="library-section-title"><h3>剧本正文</h3><span>{{ state.scripts.value.length }} 个已保存版本</span></div><p class="form-note">写下场景、台词和旁白。保存后关联故事 v{{ latest?.version }}，旧剧本会继续保留。</p>
              <NInput v-model:value="textScript" :input-props="{ 'aria-label': '剧本正文' }" :disabled="locked" type="textarea" :autosize="{ minRows: 12, maxRows: 24 }" placeholder="场景一 · 深夜街道&#10;人物：司机 / 神秘乘客&#10;……" />
            </div>
            <div class="library-pane-footer"><span>{{ recentScript ? `最近保存：剧本 v${recentScript.version} · 故事 v${recentScript.sourceVersion}` : '还没有保存的剧本版本' }}</span><NButton type="primary" :loading="state.busy.value" :disabled="!textScript.trim() || locked" @click="saveScript">保存剧本版本</NButton></div>
          </div>
          <div v-show="tab === 'project'" id="library-panel-project" class="library-pane" role="tabpanel" aria-labelledby="library-tab-project">
            <div class="library-pane-body" tabindex="0" aria-label="创建作品设置">
              <div class="library-project-intro"><div class="library-project-icon"><AppIcon name="film" :size="27" /></div><h3>把故事带到片场</h3><p>使用已保存的故事与剧本创建作品，继续制作分镜、画面和声音。</p></div>
              <dl class="library-version-summary"><div><dt>故事版本</dt><dd>{{ state.selected.value?.title }} · v{{ latest?.version }}</dd></div><div><dt>剧本版本</dt><dd>{{ recentScript ? `剧本 v${recentScript.version} · 基于故事 v${recentScript.sourceVersion}` : '尚无剧本，将使用故事设定' }}</dd></div><div><dt>关联作品</dt><dd>{{ state.projects.value.length }} 个作品</dd></div></dl>
              <label>作品画幅<NSelect v-model:value="ratio" aria-label="作品画幅" :disabled="locked" :options="[{label:'16:9 横屏',value:'16:9'},{label:'9:16 竖屏',value:'9:16'},{label:'1:1 方形',value:'1:1'}]" class="library-ratio" /></label>
              <NAlert v-if="storyDirty || scriptDirty" type="info" :show-icon="false">故事或剧本还有未保存的修改，请先到对应标签保存。</NAlert>
              <NAlert v-if="isExternalRestricted" type="warning" :show-icon="false">外部故事尚无改编授权，不能直接用于作品。可将其作为题材灵感，重新创作有权使用的原创故事。</NAlert>
            </div>
            <div class="library-pane-footer"><span>创建后，作品保留所用故事与剧本版本。</span><NButton type="primary" :loading="state.busy.value" :disabled="isExternalRestricted || locked || storyDirty || scriptDirty" @click="createProject">从此故事创建作品</NButton></div>
          </div>
        </template>
      </section>
    </div>
  </div>
</template>

<style src="../styles/library.css"></style>
