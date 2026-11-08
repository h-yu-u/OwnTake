import type { BoardSnapshot, ShotCastBinding } from '../types.ts';
import { request } from './api.ts';
const segment=(value:string)=>encodeURIComponent(value);
export const shotCastApi={
  bindings:(shotId:string)=>request<ShotCastBinding[]>(`/shots/${segment(shotId)}/characters`),
  bind:(shotId:string,roleIds:string[],expectedShotRevision:number)=>
    request<BoardSnapshot>(`/shots/${segment(shotId)}/characters`,{
      method:'PUT',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({roleIds,expectedShotRevision}),
    }),
};
