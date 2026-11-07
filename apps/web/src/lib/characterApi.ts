import type { Artifact, Character, CharacterInput, CharacterLook, CharacterVisual, ProjectRole } from '../types.ts';
import { request } from './api.ts';
const id = (value: string) => encodeURIComponent(value);
const json = <T>(path:string,method:string,body:unknown) => request<T>(path,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
export const characterApi = {
  list: (q='') => request<Character[]>(`/characters?q=${encodeURIComponent(q)}`),
  get: (value:string) => request<Character>(`/characters/${id(value)}`),
  create: (input:CharacterInput) => json<Character>('/characters','POST',input),
  update: (value:string,input:CharacterInput,expectedRevision:number) => json<Character>(`/characters/${id(value)}`,'PUT',{...input,expectedRevision}),
  visuals: (value:string) => request<CharacterVisual[]>(`/characters/${id(value)}/visuals`),
  importArtifact:(value:string,artifactId:string)=>
    json<CharacterVisual>(`/characters/${id(value)}/visuals/from-artifact`,'POST',{artifactId}),
  upload: (value:string,file:File) => request<CharacterVisual>(`/characters/${id(value)}/visuals`,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:file}),
  looks: (value:string) => request<CharacterLook[]>(`/characters/${id(value)}/looks`),
  createLook: (value:string,input:{name:string;outfit:string;mood:string;visualVersion:number}) => json<CharacterLook>(`/characters/${id(value)}/looks`,'POST',input),
  roles: (projectId:string) => request<ProjectRole[]>(`/projects/${id(projectId)}/characters`),
  bindRole: (projectId:string,input:{characterId:string;visualVersion:number;lookId:string|null;roleName:string}) =>
    json<{role:ProjectRole;artifact:Artifact}>(`/projects/${id(projectId)}/characters`,'POST',input),
};
export const characterVisualUrl=(characterId:string,version:number) => `/api/characters/${id(characterId)}/visuals/${version}/content`;
