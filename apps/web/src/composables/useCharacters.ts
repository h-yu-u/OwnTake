import { ref } from 'vue';
import type { Character, CharacterLook, CharacterVisual, ProjectRole } from '../types.ts';
import { characterApi } from '../lib/characterApi.ts';
export function useCharacters() {
  const list = ref<Character[]>([]), selected = ref<Character|null>(null);
  const visuals = ref<CharacterVisual[]>([]), looks = ref<CharacterLook[]>([]), roles = ref<ProjectRole[]>([]);
  const loading = ref(false), busy = ref(false);
  let active=0;
  async function refresh(q=''):Promise<void> { loading.value=true;try{list.value=await characterApi.list(q);}finally{loading.value=false;} }
  async function choose(id:string,projectId?:string):Promise<void> {
    const seq=++active;loading.value=true;
    try{
      const [character,images,variants,projectRoles]=await Promise.all([
        characterApi.get(id),characterApi.visuals(id),characterApi.looks(id),
        projectId?characterApi.roles(projectId):Promise.resolve([]),
      ]);
      if(seq!==active)return;
      selected.value=character;visuals.value=images;looks.value=variants;roles.value=projectRoles;
    }finally{if(seq===active)loading.value=false;}
  }
  async function mutate<T>(action:()=>Promise<T>,q='',projectId?:string):Promise<T>{
    busy.value=true;
    try{
      const result=await action();await refresh(q);
      if(selected.value)await choose(selected.value.id,projectId);
      return result;
    }finally{busy.value=false;}
  }
  return{list,selected,visuals,looks,roles,loading,busy,refresh,choose,mutate};
}
