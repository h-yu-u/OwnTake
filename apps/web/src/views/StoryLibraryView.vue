<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { NAlert, NButton, NInput, NSelect, NTag, useMessage } from 'naive-ui';
import type { Ratio, StoryInput, StorySource } from '../types.ts';
import { useStories } from '../composables/useStories.ts';
import StoryDiscoverPanel from '../components/StoryDiscoverPanel.vue';
import { storyboardApi } from '../lib/storyboardApi.ts';
import { storyApi } from '../lib/storyApi.ts';
import { errorMessage } from '../lib/api.ts';

const emit = defineEmits<{ 'project-created': [id: string]; 'storyboard-draft': [projectId: string] }>();
const state = useStories(), message = useMessage();
const query = ref(''), error = ref('');
const showDiscovery = ref(false);
const editing = ref(false), textScript = ref(''), ratio = ref<Ratio>('16:9');
const genre = ref(''), title = ref(''), summary = ref(''), tags = ref(''), beats = ref('');
const source = ref<StorySource>({ platform: 'original', url: '', title: '', author: '', rights: 'original' });
const selectedProjectId=ref<string|null>(null);
const projectOptions=computed(()=>state.projects.value.map(link=>({label:link.projectId,value:link.projectId})));
const latest = computed(() => state.versions.value.at(-1));
const recentScript = computed(() => state.scripts.value.at(-1));
const writable = computed(() => title.value.trim().length > 0 && !state.busy.value);
const isExternalRestricted = computed(() => !['original', 'licensed'].includes(state.selected.value?.source.rights ?? 'original'));

function clearEditor(): void {
  state.selected.value = null;
  editing.value = true; title.value = ''; genre.value = ''; summary.value = ''; tags.value = ''; beats.value = ''; textScript.value = '';
  source.value = { platform: 'original', url: '', title: '', author: '', rights: 'original' };
}
async function select(id: string): Promise<void> {
  try {
    await state.choose(id);
    const current = state.selected.value, version = state.versions.value.at(-1);
    if (!current) return;
    editing.value = true; title.value = current.title; genre.value = current.genre; summary.value = current.summary;
    tags.value = current.tags.join('，'); beats.value = version?.beats.join('\n') ?? '';
    source.value = { ...current.source }; textScript.value = state.scripts.value.at(-1)?.text ?? '';
    selectedProjectId.value = state.projects.value[0]?.projectId ?? null;
  } catch (failure) { error.value = errorMessage(failure); }
}
function payload(): StoryInput {
  return { title: title.value.trim(), genre: genre.value.trim(), summary: summary.value.trim(),
    tags: tags.value.split(/[,，、]/u).map(item => item.trim()).filter(Boolean),
    beats: beats.value.split(/\n+/u).map(item => item.trim()).filter(Boolean), source: { ...source.value } };
}
async function search(): Promise<void> { try { error.value = ''; await state.refresh(query.value); } catch (failure) { error.value = errorMessage(failure); } }
async function save(): Promise<void> {
  try {
    error.value = '';
    const value = payload(), selected = state.selected.value;
    const saved = selected
      ? await state.mutate(() => storyApi.update(selected.id, value, selected.revision), query.value)
      : await state.mutate(() => storyApi.create(value), query.value);
    await select(saved.id); message.success(selected ? '故事新版本已保存' : '已加入故事库');
  } catch (failure) { error.value = errorMessage(failure); }
}
async function saveScript(): Promise<void> {
  const selected = state.selected.value, version = latest.value;
  if (!selected || !version) return;
  try {
    error.value = '';
    await state.mutate(() => storyApi.saveScript(selected.id, version.version, textScript.value), query.value);
    message.success('剧本已保存为独立版本，旧版本不会被覆盖');
  } catch (failure) { error.value = errorMessage(failure); }
}
async function createStoryboardDraft():Promise<void>{
  const current=state.selected.value,script=recentScript.value,projectId=selectedProjectId.value;
  if(!current||!script||!projectId)return;
  try{
    error.value='';
    const board=await storyboardApi.snapshot(projectId);
    await storyApi.toStoryboard(current.id,projectId,script.version,board.revision);
    message.success('已创建可审阅的分镜草稿；需在草稿页逐条确认');
    emit('storyboard-draft',projectId);
  }catch(failure){error.value=errorMessage(failure);}
}
async function createProject(): Promise<void> {
  const current = state.selected.value, version = latest.value;
  if (!current || !version) return;
  try {
    error.value = '';
    const result = await state.mutate(() => storyApi.createProject(current.id, version.version, recentScript.value?.version ?? null, ratio.value), query.value);
    message.success('已从故事创建作品'); emit('project-created', result.project.id);
  } catch (failure) { error.value = errorMessage(failure); }
}
async function imported(id: string) { await search(); showDiscovery.value = false; await select(id); }
onMounted(() => { void search(); });
</script>
<template>
  <div class="library-page">
    <header class="library-heading"><div><p class="eyebrow">STORY LIBRARY · LOCAL FIRST</p><h1>故事库</h1><p>从灵感到结构化剧本，让每个值得拍的故事都能持续打磨。</p></div><div class="library-actions"><NButton @click="showDiscovery = !showDiscovery">{{ showDiscovery ? '收起发现' : '发现故事' }}</NButton><NButton type="primary" @click="clearEditor">新建原创故事</NButton></div></header>
    <NAlert v-if="error" type="error" :show-icon="false" closable @close="error = ''">{{ error }}</NAlert>
    <StoryDiscoverPanel v-if="showDiscovery" @saved="imported" />
    <div class="library-layout">
      <section class="library-index" aria-label="故事列表">
        <div class="library-search"><NInput v-model:value="query" clearable placeholder="搜索标题、题材、标签或剧情" @keyup.enter="search" /><NButton :loading="state.loading.value" @click="search">检索</NButton></div>
        <div v-if="!state.stories.value.length" class="library-empty">还没有故事。可以先创建原创故事，保存剧情结构与剧本版本。</div>
        <button v-for="story in state.stories.value" :key="story.id" class="library-item" :class="{ active: state.selected.value?.id === story.id }" @click="select(story.id)">
          <span class="library-item-top"><strong>{{ story.title }}</strong><NTag size="small" :bordered="false">{{ story.source.platform }}</NTag></span>
          <span class="library-item-summary">{{ story.summary || '还没有填写剧情简介' }}</span>
          <span class="library-item-tags">{{ story.genre }} · v{{ story.revision }} · {{ story.tags.join(' / ') }}</span>
        </button>
      </section>
      <section class="library-editor" aria-label="故事编辑">
        <div v-if="!editing" class="library-empty">选择一篇故事进行开发，或创建第一篇原创故事。</div>
        <template v-else>
          <div class="library-section-title"><h2>{{ state.selected.value ? '编辑故事' : '新建原创故事' }}</h2><NTag v-if="state.selected.value" size="small" type="info">当前 v{{ state.selected.value.revision }}</NTag></div>
          <label>故事标题<NInput v-model:value="title" maxlength="200" show-count placeholder="给故事起一个名字" /></label>
          <label>题材<NInput v-model:value="genre" maxlength="80" placeholder="悬疑、爱情、喜剧……" /></label>
          <label>一句话与剧情概要<NInput v-model:value="summary" type="textarea" :autosize="{ minRows: 3, maxRows: 8 }" maxlength="10000" show-count /></label>
          <label>标签（用逗号分隔）<NInput v-model:value="tags" placeholder="都市，反转，雨夜" /></label>
          <label>剧情节点（每行一个）<NInput v-model:value="beats" type="textarea" :autosize="{ minRows: 4, maxRows: 12 }" placeholder="开头钩子&#10;冲突升级&#10;故事反转" /></label>
          <div v-if="source.platform !== 'original'" class="library-source"><strong>来源</strong><a :href="source.url" target="_blank" rel="noopener noreferrer">{{ source.title || source.url }}</a><NTag type="warning" size="small">{{ source.rights }}</NTag></div>
          <div class="library-actions"><NButton type="primary" :disabled="!writable" @click="save">{{ state.selected.value ? '保存新故事版本' : '创建故事' }}</NButton><span v-if="state.selected.value">{{ state.versions.value.length }} 个历史故事版本</span></div>
          <div v-if="state.selected.value" class="library-script">
            <div class="library-section-title"><h3>剧本工作区</h3><span>{{ state.scripts.value.length }} 个不可变剧本版本</span></div>
            <p>使用场景、台词和旁白编写剧本；保存时绑定当前故事版本。可以继续编辑，不会修改旧版本。</p>
            <NInput v-model:value="textScript" type="textarea" :autosize="{ minRows: 9, maxRows: 22 }" placeholder="场景一 · 深夜街道&#10;人物：司机 / 神秘乘客&#10;……" />
            <div class="library-actions"><NButton :disabled="!textScript.trim() || state.busy.value" @click="saveScript">保存剧本版本</NButton><span v-if="recentScript">最近保存：剧本 v{{ recentScript.version }}（故事 v{{ recentScript.sourceVersion }}）</span></div>
            <div class="library-project"><h3>创建影视作品</h3><p>从当前故事及剧本的确定版本创建项目，保留素材来源追溯。</p>
              <NAlert v-if="isExternalRestricted" type="warning" :show-icon="false">外部故事尚无改编授权，不能直接用于作品。可将其作为题材灵感，重新创作有权使用的原创故事。</NAlert>
              <div class="library-actions"><NSelect v-model:value="ratio" :options="[{label:'16:9 横屏',value:'16:9'},{label:'9:16 竖屏',value:'9:16'},{label:'1:1 方形',value:'1:1'}]" style="width:180px" /><NButton type="primary" :disabled="isExternalRestricted || state.busy.value" @click="createProject">从此故事创建作品</NButton></div>
              <div v-if="state.projects.value.length" class="library-project"><h3>将剧本拆成分镜草稿</h3><p>从确定版本提取场景，创建待审阅的分镜草稿，不直接覆盖已有镜头。</p>
                <div class="library-actions"><NSelect v-model:value="selectedProjectId" :options="projectOptions" placeholder="选择关联作品" style="min-width:210px;width:310px" />
                <NButton :disabled="!recentScript || !selectedProjectId || state.busy.value || isExternalRestricted" @click="createStoryboardDraft">生成分镜草稿</NButton></div></div>
              <p v-if="state.projects.value.length">已关联 {{ state.projects.value.length }} 个作品。</p>
            </div>
          </div>
        </template>
      </section>
    </div>
  </div>
</template>
<style scoped>
.library-page{padding:32px 40px;max-width:1500px;margin:auto;color:var(--text-primary,#eaeef4)}
.library-heading{display:flex;justify-content:space-between;align-items:center;gap:22px;margin-bottom:28px}
.library-heading h1{font-size:34px;margin:8px 0}.library-heading p{color:#99a3b5}
.library-layout{display:grid;grid-template-columns:minmax(270px,360px) minmax(0,1fr);gap:20px;align-items:start}
.library-index,.library-editor{border:1px solid #303747;border-radius:18px;background:#161a22;padding:22px}
.library-search{display:flex;gap:8px;margin-bottom:16px}.library-item{display:flex;flex-direction:column;gap:10px;text-align:left;width:100%;padding:16px;border:1px solid transparent;border-radius:12px;background:#20252f;color:inherit;margin-bottom:10px;cursor:pointer}
.library-item:hover,.library-item.active{border-color:#7a849c}.library-item-top{display:flex;justify-content:space-between;gap:8px;align-items:center}.library-item-summary{color:#b9bfcd;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}.library-item-tags{font-size:12px;color:#858fa3}
.library-editor{display:flex;flex-direction:column;gap:18px}.library-editor label{display:flex;flex-direction:column;gap:8px;color:#bec7d7}.library-empty{padding:38px 14px;color:#96a1b7;text-align:center}.library-section-title,.library-actions{display:flex;justify-content:space-between;align-items:center;gap:15px;flex-wrap:wrap}.library-section-title h2,.library-section-title h3{margin:0}.library-actions span,.library-script p{color:#8f9ab0;font-size:13px}
.library-script,.library-project{border-top:1px solid #303747;padding-top:20px;display:flex;flex-direction:column;gap:14px}.library-source{display:flex;align-items:center;gap:12px}
@media(max-width:850px){.library-page{padding:18px}.library-layout{grid-template-columns:1fr}.library-heading{align-items:flex-start}}
</style>
