<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { NAlert, NButton, NInput, NSelect, NTag, useMessage } from 'naive-ui';
import type { DiscoveryResult, DiscoverySource } from '../types.ts';
import { discoveryApi } from '../lib/discoveryApi.ts';
import { errorMessage } from '../lib/api.ts';
const emit = defineEmits<{ saved: [id: string] }>();
const message = useMessage();
const source = ref<DiscoverySource>('zhihu'), q = ref('');
const configured = ref(false), searching = ref(false), saving = ref(''), error = ref('');
const results = ref<DiscoveryResult[]>([]);
const link = ref(''), manualTitle = ref(''), manualAuthor = ref('');
const manualPlatform = ref<'zhihu'|'xiaohongshu'|'web'|'manual'>('xiaohongshu');
onMounted(async () => { try { configured.value = (await discoveryApi.status()).configured; } catch { /* Offline notice is handled by the caller. */ } });
async function search(): Promise<void> {
  if (!q.value.trim()) return;
  error.value = ''; searching.value = true;
  try { results.value = await discoveryApi.search(source.value, q.value); }
  catch (failure) { results.value = []; error.value = errorMessage(failure); }
  finally { searching.value = false; }
}
async function save(input: { platform: 'zhihu'|'xiaohongshu'|'web'|'manual'; title: string; url: string; author: string; snippet: string }): Promise<void> {
  saving.value = input.url; error.value = '';
  try {
    const story = await discoveryApi.save(input);
    message.success('来源已登记为灵感，不代表取得改编权');
    emit('saved', story.id);
  } catch (failure) { error.value = errorMessage(failure); }
  finally { saving.value = ''; }
}
</script>
<template>
  <section class="discovery-panel">
    <h3>发现故事灵感</h3><p>仅检索标题、摘要与来源链接，不读取需登录的正文，不自动赋予改编权。</p>
    <NAlert v-if="!configured" type="info" :show-icon="false">官方搜索 API 未配置。在本机启动前设置 OWNTAKE_ZHIHU_ACCESS_SECRET；没有凭据仍可使用下方手动链接收藏。</NAlert>
    <NAlert v-if="error" type="error" :show-icon="false" closable @close="error = ''">{{ error }}</NAlert>
    <div class="discovery-row"><NSelect v-model:value="source" :options="[{label:'知乎站内',value:'zhihu'},{label:'小红书（授权全网索引）',value:'xiaohongshu'}]" style="min-width:180px;width:245px" /><NInput v-model:value="q" clearable placeholder="输入关键词，如 都市悬疑反转" @keyup.enter="search" /><NButton :loading="searching" :disabled="!configured || !q.trim()" @click="search">检索来源</NButton></div>
    <div v-if="results.length" class="discovery-results">
      <article v-for="result in results" :key="result.url" class="discovery-hit"><div><NTag size="small">{{ result.platform }}</NTag><h4>{{ result.title }}</h4><p>{{ result.snippet || '无公开摘要，打开原文查看来源。' }}</p><small>{{ result.author || '作者未提供' }} · {{ result.contentType }}</small></div><div class="discovery-actions"><a :href="result.url" target="_blank" rel="noopener noreferrer">查看来源</a><NButton size="small" :loading="saving === result.url" @click="save(result)">收藏灵感</NButton></div></article>
    </div>
    <div v-else-if="configured && !searching" class="discovery-empty">输入关键词搜索；若搜索服务未收录，可粘贴来源链接。</div>
    <div class="manual-source"><h4>手动收藏来源链接</h4><p>适合小红书等未开放通用正文接口的平台。只保存你填写的标题及链接。</p>
      <div class="discovery-row"><NSelect v-model:value="manualPlatform" :options="[{label:'小红书',value:'xiaohongshu'},{label:'知乎',value:'zhihu'},{label:'网站',value:'web'},{label:'其他',value:'manual'}]" style="width:150px" /><NInput v-model:value="link" placeholder="https://..." /></div>
      <div class="discovery-row"><NInput v-model:value="manualTitle" maxlength="300" placeholder="来源标题" /><NInput v-model:value="manualAuthor" maxlength="200" placeholder="作者（可空）" /><NButton :loading="saving === link" :disabled="!link.trim() || !manualTitle.trim()" @click="save({platform:manualPlatform,title:manualTitle,url:link,author:manualAuthor,snippet:''})">保存链接</NButton></div>
    </div>
  </section>
</template>
<style scoped>
.discovery-panel{background:#191f2a;border:1px solid #343c4c;border-radius:16px;padding:22px;margin:0 0 22px}
.discovery-panel h3{font-size:19px;margin:0 0 8px}.discovery-panel p,.discovery-empty{color:#abb5c7}
.discovery-row{display:flex;gap:10px;align-items:center;margin-top:14px}.discovery-results{display:grid;gap:10px;margin:20px 0}
.discovery-hit{background:#222938;border:1px solid #354052;border-radius:11px;padding:16px;display:flex;gap:18px;justify-content:space-between}
.discovery-hit h4{font-size:16px;margin:8px 0}.discovery-hit p{font-size:13px;margin:0 0 8px}.discovery-hit small{color:#93a2bb}
.discovery-actions{display:flex;gap:12px;align-items:center;flex-shrink:0}.discovery-actions a{color:#9dbdff}
.manual-source{padding-top:15px;border-top:1px solid #384052}.manual-source h4{margin:6px 0}
@media(max-width:700px){.discovery-row,.discovery-hit{flex-wrap:wrap}.discovery-row>*{flex:1;min-width:120px}}
</style>
