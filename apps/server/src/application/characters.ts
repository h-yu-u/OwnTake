import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { AppError, invariant } from '../../../../packages/contracts/src/errors.ts';
import { resolveAsset } from '../assets.ts';
import { createHash } from 'node:crypto';
import { probe } from '../../../../packages/media/src/index.ts';
import type { CharacterVisual } from '../../../../packages/contracts/src/character.ts';
import type { ApplicationContext } from './context.ts';
import { CHARACTER_POLICY } from '../config/character.ts';

function fileType(bytes: Buffer): {extension:string;mime:CharacterVisual['mime']} {
  if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return {extension:'png',mime:'image/png'};
  if(bytes[0]===0xff && bytes[1]===0xd8 && bytes[2]===0xff) return {extension:'jpg',mime:'image/jpeg'};
  if(bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')return {extension:'webp',mime:'image/webp'};
  throw new AppError('UNSUPPORTED_MEDIA','人物形象只支持静态 PNG、JPEG、WebP 图片',422);
}
export async function registerCharacterVisual(context:Pick<ApplicationContext,'store'|'characters'>,characterId:string,stream:Readable,signal?:AbortSignal):Promise<CharacterVisual> {
  const chunks:Buffer[]=[];let length=0;
  for await(const raw of stream.iterator({destroyOnReturn:false})){
    signal?.throwIfAborted();
    const chunk=Buffer.from(raw as Uint8Array);
    length+=chunk.length;
    invariant(length<=CHARACTER_POLICY.maxReferenceBytes,'BODY_TOO_LARGE','参考图片不能超过 16 MiB',413);
    chunks.push(chunk);
  }
  invariant(length>0,'EMPTY_FILE','参考图不能为空');
  const bytes=Buffer.concat(chunks),kind=fileType(bytes);
  invariant(context.characters.visuals(characterId).length<CHARACTER_POLICY.maxVisualsPerCharacter,'CHARACTER_LIMIT','人物形象版本数量达到上限',409);
  const work=await mkdtemp(join(context.store.dataDir,'character-preview-'));
  try{
    const path=join(work,`reference.${kind.extension}`);
    await writeFile(path,bytes,{flag:'wx',mode:0o600});
    const media=await probe(path,{ffprobePath:context.store.getSettings().ffprobePath,signal});
    invariant(media.kind==='image'&&media.width&&media.height,'UNSUPPORTED_MEDIA','人物参考图必须是有效静态图片',422);
    invariant(media.width>=300&&media.height>=300&&media.width<=6000&&media.height<=6000&&
      media.width/media.height>=0.4&&media.width/media.height<=2.5,
      'CHARACTER_IMAGE_DIMENSIONS','参考图须为 300–6000 像素，宽高比 0.4–2.5',422);
    signal?.throwIfAborted();
    return context.characters.addVisual(characterId,bytes,{mime:kind.mime,width:media.width,height:media.height});
  }finally{await rm(work,{recursive:true,force:true});}
}

/** Promote an existing immutable project image into the global actor library without reuploading. */
export async function importCharacterVisualFromArtifact(
  context:Pick<ApplicationContext,'store'|'characters'>,characterId:string,artifactId:string
):Promise<CharacterVisual> {
  const { artifact,path }=await resolveAsset(context.store,artifactId);
  invariant(artifact.kind==='image'&&artifact.sizeBytes>0&&artifact.sizeBytes<=CHARACTER_POLICY.maxReferenceBytes,
    'INVALID_REFERENCE','只能从项目中已登记的静态图片建立人物形象',422);
  const bytes=await readFile(path);
  invariant(bytes.length===artifact.sizeBytes&&
    createHash('sha256').update(bytes).digest('hex')===artifact.sha256,
    'REFERENCE_CHANGED','项目素材已改变，不能用作人物形象',409);
  return registerCharacterVisual(context,characterId,Readable.from([bytes]));
}
