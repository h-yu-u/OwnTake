<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { NAlert, NButton, NSelect } from 'naive-ui';
import type { ProjectRole, Shot, ShotCastBinding } from '../types.ts';
import { characterApi } from '../lib/characterApi.ts';
import { shotCastApi } from '../lib/shotCastApi.ts';
import { errorMessage } from '../lib/api.ts';

const props=defineProps<{shot:Shot;projectId:string;disabled:boolean}>();
const emit=defineEmits<{bound:[];characters:[]}>();
const roles=ref<ProjectRole[]>([]),existing=ref<ShotCastBinding[]>([]),selected=ref<string[]>([]);
const loading=ref(false),saving=ref(false),error=ref('');
let sequence=0;
async function refresh():Promise<void> {
  const seq=++sequence;loading.value=true;error.value='';
  try {
    const [projectRoles,bindings]=await Promise.all([characterApi.roles(props.projectId),shotCastApi.bindings(props.shot.id)]);
    if(seq!==sequence)return;
    roles.value=projectRoles;existing.value=bindings;selected.value=bindings.map(item=>item.roleId);
  }catch(failure){if(seq===sequence)error.value=errorMessage(failure);}
  finally{if(seq===sequence)loading.value=false;}
}
async function bind():Promise<void> {
  if(saving.value||props.disabled)return;
  saving.value=true;error.value='';
  try{
    await shotCastApi.bind(props.shot.id,selected.value,props.shot.revision);
    emit('bound');
  }catch(failure){error.value=errorMessage(failure);}
  finally{saving.value=false;}
}
watch(()=>[props.shot.id,props.projectId],()=>{void refresh();});
onMounted(()=>{void refresh();});
</script>
<template>
  <section class="cast-panel">
    <div class="cast-heading"><strong>镜头出场人物</strong><NButton text size="small" @click="emit('characters')">管理人物库</NButton></div>
    <p>将作品演员表中的锁定形象绑定到本镜头。系统会自动添加项目内的不可变参考图；每次改动都产生新的镜头视觉修订。</p>
    <NAlert v-if="error" type="error" :show-icon="false">{{error}}</NAlert>
    <NAlert v-if="!roles.length&&!loading" type="info" :show-icon="false">当前作品还未添加演员。先在人物库锁定人物形象，并绑定到此作品。</NAlert>
    <NSelect v-model:value="selected" multiple filterable :max-tag-count="2" :loading="loading"
      :disabled="disabled||saving||loading||!roles.length" :options="roles.map(role=>({label:role.roleName+' · 视觉 v'+role.visualVersion,value:role.id}))"
      placeholder="选择本镜头出现的人物（最多四位）" />
    <div class="cast-heading"><small>当前绑定：{{existing.length}} 位 · 选择：{{selected.length}} 位</small>
      <NButton size="small" :disabled="disabled||loading||saving||selected.length>4||JSON.stringify(selected)===JSON.stringify(existing.map(item=>item.roleId))" :loading="saving" @click="bind">保存镜头人物</NButton></div>
  </section>
</template>
<style scoped>
.cast-panel{border:1px solid #353e50;border-radius:13px;background:#1c2230;padding:17px;display:flex;flex-direction:column;gap:12px;margin:16px 0}.cast-heading{display:flex;justify-content:space-between;align-items:center;gap:16px}
.cast-panel p,.cast-panel small{margin:0;font-size:12px;line-height:1.6;color:#a4b1c6}
</style>
