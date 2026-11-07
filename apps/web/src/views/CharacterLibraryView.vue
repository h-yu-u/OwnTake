<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { NAlert, NButton, NInput, NSelect, NTag, useMessage } from 'naive-ui';
import type { Artifact, CharacterInput, Project } from '../types.ts';
import { useCharacters } from '../composables/useCharacters.ts';
import { characterApi, characterVisualUrl } from '../lib/characterApi.ts';
import { errorMessage } from '../lib/api.ts';
const props=defineProps<{projects:Project[];artifacts:Artifact[];currentProjectId?:string}>();
const state=useCharacters(),message=useMessage();
const query=ref(''),error=ref(''),editing=ref(false);
const name=ref(''),biography=ref(''),appearance=ref(''),style=ref(''),voicePreset=ref('');
const selectedVersion=ref<number|null>(null),lookName=ref(''),outfit=ref(''),mood=ref('');
const lookId=ref<string|null>(null),projectId=ref<string|null>(props.currentProjectId??null),roleName=ref('');
const inputFile=ref<HTMLInputElement|null>(null);
const candidateArtifactId=ref<string|null>(null);
const artifactOptions=computed(()=>props.artifacts.filter(item=>item.kind==='image'&&item.sizeBytes>0&&item.sizeBytes<=16*1024*1024)
  .map(item=>({label:item.name,value:item.id})));
const locked= computed(()=>state.selected.value?.lockedVisualVersion??null);
const currentVisual=computed(()=>state.visuals.value.find(item=>item.version===selectedVersion.value));
const lookOptions=computed(()=>state.looks.value.filter(item=>item.visualVersion===selectedVersion.value).map(item=>({label:item.name,value:item.id})));
const bound=computed(()=>state.roles.value.some(item=>item.characterId===state.selected.value?.id && item.projectId===projectId.value));
watch(()=>props.currentProjectId,next=>{if(!projectId.value)projectId.value=next??null;});
async function search(){try{error.value='';await state.refresh(query.value);}catch(failure){error.value=errorMessage(failure);}}
function reset(){
  editing.value=true;state.selected.value=null;name.value='';biography.value='';appearance.value='';style.value='';voicePreset.value='';
  selectedVersion.value=null;lookId.value=null;roleName.value='';
}
async function choose(id:string){
  try{error.value='';await state.choose(id,projectId.value??undefined);
    const value=state.selected.value;if(!value)return;
    editing.value=true;name.value=value.name;biography.value=value.biography;appearance.value=value.appearance;
    style.value=value.style;voicePreset.value=value.voicePreset;roleName.value=value.name;
    selectedVersion.value=value.lockedVisualVersion;lookId.value=null;
  }catch(failure){error.value=errorMessage(failure);}
}
function payload():CharacterInput{return{name:name.value,biography:biography.value,appearance:appearance.value,style:style.value,voicePreset:voicePreset.value};}
async function save(){
  try{error.value='';const old=state.selected.value;
    const current=old?await state.mutate(()=>characterApi.update(old.id,payload(),old.revision),query.value,projectId.value??undefined)
      :await state.mutate(()=>characterApi.create(payload()),query.value,projectId.value??undefined);
    await choose(current.id);message.success(old?'人物档案已更新':'人物已创建');
  }catch(failure){error.value=errorMessage(failure);}
}
async function upload(event:Event){
  const file=(event.target as HTMLInputElement).files?.[0],actor=state.selected.value;
  if(!file||!actor)return;
  if(file.size>16*1024*1024){error.value='参考图片不能超过 16 MiB';return;}
  try{error.value='';const visual=await state.mutate(()=>characterApi.upload(actor.id,file),query.value,projectId.value??undefined);
    selectedVersion.value=visual.version;lookId.value=null;message.success('已锁定不可变人物形象版本');
  }catch(failure){error.value=errorMessage(failure);}
  finally{if(inputFile.value)inputFile.value.value='';}
}
async function importProjectArtifact(){
  const actor=state.selected.value,source=candidateArtifactId.value;
  if(!actor||!source)return;
  try{
    error.value='';
    const visual=await state.mutate(()=>characterApi.importArtifact(actor.id,source),query.value,projectId.value??undefined);
    selectedVersion.value=visual.version;lookId.value=null;
    message.success('已将项目内图片保存为新的不可变人物形象');
  }catch(failure){error.value=errorMessage(failure);}
}
async function saveLook(){
  const actor=state.selected.value,version=selectedVersion.value;
  if(!actor||!version)return;
  try{error.value='';const look=await state.mutate(()=>characterApi.createLook(actor.id,{name:lookName.value,outfit:outfit.value,mood:mood.value,visualVersion:version}),query.value,projectId.value??undefined);
    lookId.value=look.id;lookName.value='';outfit.value='';mood.value='';message.success('造型版本已保存');
  }catch(failure){error.value=errorMessage(failure);}
}
async function bind(){
  const actor=state.selected.value,version=selectedVersion.value;
  if(!actor||!version||!projectId.value)return;
  try{error.value='';await state.mutate(()=>characterApi.bindRole(projectId.value!,{characterId:actor.id,visualVersion:version,lookId:lookId.value,roleName:roleName.value}),query.value,projectId.value);
    message.success('人物已加入作品，参考图已复制为该作品的不可变素材');
  }catch(failure){error.value=errorMessage(failure);}
}
watch(projectId,()=>{if(state.selected.value)void state.choose(state.selected.value.id,projectId.value??undefined);});
onMounted(()=>{void search();});
</script>
<template>
  <div class="actor-page">
    <header class="actor-heading"><div><p class="eyebrow">CHARACTER LIBRARY · CAST</p><h1>人物库</h1><p>固定演员身份、多视角形象版本与跨作品角色复用。</p></div><NButton type="primary" @click="reset">新建人物</NButton></header>
    <NAlert v-if="error" type="error" :show-icon="false" closable @close="error=''">{{ error }}</NAlert>
    <div class="actor-layout">
      <section class="actor-index"><div class="actor-search"><NInput v-model:value="query" placeholder="搜索人物" @keyup.enter="search" /><NButton @click="search">检索</NButton></div>
        <p v-if="!state.list.value.length">还没有角色。创建一位虚拟演员并上传固定参考图。</p>
        <button v-for="actor in state.list.value" :key="actor.id" class="actor-card" :class="{active:state.selected.value?.id===actor.id}" @click="choose(actor.id)">
          <div class="actor-card-avatar"><img v-if="actor.lockedVisualVersion" :src="characterVisualUrl(actor.id,actor.lockedVisualVersion)" :alt="actor.name" /><span v-else>未定型</span></div>
          <div><strong>{{ actor.name }}</strong><p>{{ actor.appearance||'待补充外貌设定' }}</p><small>档案 v{{ actor.revision }} · 形象 {{ actor.lockedVisualVersion?'v'+actor.lockedVisualVersion:'未锁定' }}</small></div>
        </button>
      </section>
      <section class="actor-details">
        <p v-if="!editing" class="actor-muted">选择人物或创建第一位虚拟演员。</p>
        <template v-else>
          <div class="actor-row"><h2>{{ state.selected.value?'人物档案':'创建人物' }}</h2><NTag v-if="state.selected.value" size="small">v{{ state.selected.value.revision }}</NTag></div>
          <label>人物姓名<NInput v-model:value="name" maxlength="120" placeholder="林夏" /></label>
          <label>人物经历 / 性格<NInput v-model:value="biography" type="textarea" :autosize="{minRows:2,maxRows:7}" /></label>
          <label>稳定外貌特征<NInput v-model:value="appearance" type="textarea" :autosize="{minRows:2,maxRows:6}" /></label>
          <label>视觉风格<NInput v-model:value="style" placeholder="电影写实、自然光" /></label>
          <label>声音预设 / TTS voice id<NInput v-model:value="voicePreset" placeholder="仅保存声音配置；不自动克隆真人声音" /></label>
          <div><NButton type="primary" :disabled="!name.trim()||state.busy.value" @click="save">{{ state.selected.value?'保存人物档案':'创建人物' }}</NButton></div>
          <template v-if="state.selected.value">
            <div class="actor-section"><div class="actor-row"><h3>锁定视觉形象</h3><NTag size="small" :bordered="false">历史版本不可覆盖</NTag></div>
              <p class="actor-muted">上传静态 PNG / JPEG / WebP（最大 16 MiB、300～6000 像素）。每次上传生成新的锁定形象版本；旧作品仍使用原版本。</p>
              <input ref="inputFile" hidden type="file" accept="image/png,image/jpeg,image/webp" @change="upload" /><NButton :disabled="state.busy.value" @click="inputFile?.click()">上传并锁定新形象</NButton>
              <div v-if="artifactOptions.length" class="actor-import"><p class="actor-muted">也可将当前项目已有的 AI 生成图片直接保存为人物参考形象，无需重新上传或发起模型调用。</p>
                <NSelect v-model:value="candidateArtifactId" :options="artifactOptions" filterable clearable placeholder="选择当前作品中已生成的图片" />
                <NButton :disabled="!candidateArtifactId || state.busy.value" @click="importProjectArtifact">从项目图片创建形象</NButton>
              </div>
              <div v-if="state.visuals.value.length" class="actor-gallery"><button v-for="visual in state.visuals.value" :key="visual.id" :class="{active:selectedVersion===visual.version}" @click="selectedVersion=visual.version;lookId=null">
                <img :src="characterVisualUrl(visual.characterId,visual.version)" :alt="'人物形象 v'+visual.version" /><span>v{{visual.version}} · {{visual.width}}×{{visual.height}}</span>
              </button></div>
            </div>
            <div v-if="selectedVersion" class="actor-section"><h3>专属造型</h3><p class="actor-muted">造型与当前人物形象版本绑定；衣服变化不改变演员身份。</p>
              <div class="actor-row"><NInput v-model:value="lookName" placeholder="造型名称，例如雨夜风衣" /><NInput v-model:value="outfit" placeholder="服饰描述" /></div>
              <NInput v-model:value="mood" placeholder="情绪 / 表情" /><NButton :disabled="!lookName.trim()||state.busy.value" @click="saveLook">保存造型</NButton>
              <NSelect v-model:value="lookId" clearable :options="lookOptions" placeholder="选择用于当前作品的造型（可选）" />
            </div>
            <div v-if="selectedVersion" class="actor-section"><h3>用于影视作品</h3><p class="actor-muted">将锁定参考图复制到所选作品的素材库，后续修改人物形象不会改变已有作品。</p>
              <NSelect v-model:value="projectId" :options="projects.map(item=>({label:item.name,value:item.id}))" placeholder="选择影视作品" />
              <NInput v-model:value="roleName" placeholder="该作品里的角色名" />
              <NAlert v-if="bound" type="info" :show-icon="false">此人物已在所选作品中绑定；可在分镜中使用。</NAlert>
              <NButton type="primary" :disabled="!projectId||!roleName.trim()||bound||state.busy.value" @click="bind">绑定人物到作品</NButton>
            </div>
          </template>
        </template>
      </section>
    </div>
  </div>
</template>
<style scoped>
.actor-page{padding:32px 40px;max-width:1500px;margin:auto;color:#eef1f7}.actor-heading{display:flex;align-items:center;justify-content:space-between;margin-bottom:25px}.actor-heading h1{font-size:34px;margin:5px 0}.actor-heading p,.actor-muted,.actor-index p{color:#9ca9bf}.actor-layout{display:grid;grid-template-columns:330px minmax(0,1fr);gap:22px}
.actor-index,.actor-details{background:#161b25;border:1px solid #303949;border-radius:17px;padding:20px}.actor-search{display:flex;gap:8px;margin-bottom:18px}.actor-card{width:100%;display:flex;gap:15px;padding:13px;margin-bottom:10px;text-align:left;background:#242a36;color:inherit;border:1px solid transparent;border-radius:12px;cursor:pointer}.actor-card.active,.actor-card:hover{border-color:#7991b8}
.actor-card-avatar{width:75px;height:88px;flex-shrink:0;background:#394355;display:flex;align-items:center;justify-content:center;font-size:11px}.actor-card-avatar img{width:100%;height:100%;object-fit:cover}
.actor-card p{margin:6px 0;max-height:38px;overflow:hidden}.actor-card small{color:#98a5b7}.actor-details{display:flex;flex-direction:column;gap:15px}.actor-details label{display:grid;gap:8px;color:#bcc9de}.actor-row{display:flex;justify-content:space-between;align-items:center;gap:12px}.actor-row>*{flex:1}.actor-row h2{margin:0}.actor-section{display:grid;gap:13px;border-top:1px solid #343e4e;padding-top:20px;margin-top:8px}.actor-section h3{margin:0}
.actor-import{display:grid;gap:9px}.actor-gallery{display:flex;gap:12px;flex-wrap:wrap}.actor-gallery button{background:#293446;border:2px solid transparent;border-radius:10px;overflow:hidden;color:#d7e1ef;cursor:pointer;padding:4px}.actor-gallery button.active{border-color:#93b5ff}.actor-gallery img{width:112px;height:130px;display:block;object-fit:cover}.actor-gallery span{display:block;font-size:11px;padding:7px 0}
@media(max-width:850px){.actor-page{padding:18px}.actor-layout{grid-template-columns:1fr}}
</style>
