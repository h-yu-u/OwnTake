import { randomUUID } from 'node:crypto';
import { invariant } from '../../contracts/src/errors.ts';
import type { DraftOperation } from '../../contracts/src/storyboard.ts';
import { text } from './validation.ts';

export interface ScriptScene {
  title: string;
  description: string;
  durationMs: number;
}

/** Deterministic structural breakdown. Never misrepresents it as an AI interpretation. */
export function splitScriptScenes(value: unknown): ScriptScene[] {
  const source=text(value,'剧本文本',20_000);
  const normalized=source.replace(/\r\n?/g,'\n');
  const lines=normalized.split('\n');
  const sections:string[]=[];
  let current:string[]=[];
  const isHeading=(line:string)=>/^(?:场景[：:\s\d一二三四五六七八九十]|第[一二三四五六七八九十\d]+场|镜头[：:\s\d一二三四五六七八九十]|SCENE\b|INT\.|EXT\.)/i.test(line.trim());
  for(const line of lines) {
    if(isHeading(line) && current.some(row=>row.trim())) {
      sections.push(current.join('\n').trim());
      current=[];
    }
    current.push(line);
  }
  if(current.some(row=>row.trim()))sections.push(current.join('\n').trim());
  const expanded=sections.length===1 ? normalized.split(/\n\s*\n+/u).filter(item=>item.trim()) : sections;
  invariant(expanded.length>0 && expanded.length<=25,'SCRIPT_STRUCTURE_INVALID','剧本需要 1–25 个可识别的场景；请按场景标题或空行拆分',422);
  return expanded.map((raw,index)=>{
    const block=raw.trim();
    invariant(block.length<=12_000,'SCRIPT_SCENE_TOO_LONG','单场剧情不能超过 12000 字，请先拆分场景',422);
    const first=(block.split('\n')[0]??'').trim();
    return {
      title: (first.length>0?first:`镜头 ${index+1}`).slice(0,200),
      description:block,
      durationMs:4_000,
    };
  });
}
/** Generates a reviewable draft, not changes to the live board. */
export function scriptToDraftOperations(script:string):DraftOperation[] {
  return splitScriptScenes(script).map(scene=>({
    id:`draftop_${randomUUID()}`,
    kind:'add',
    fields:{
      title:scene.title,
      purpose:'剧本结构转分镜，待人工审阅',
      description:scene.description,
      action:'',
      durationMs:scene.durationMs,
      caption:'',
      mode:'generate_image',
      referenceArtifactIds:[],
    },
  }));
}
