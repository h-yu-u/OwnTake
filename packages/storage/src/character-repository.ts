import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppError, invariant } from '../../contracts/src/errors.ts';
import type { Artifact, MediaInfo } from '../../contracts/src/index.ts';
import type { Character, CharacterInput, CharacterLook, CharacterVisual, ProjectRole } from '../../contracts/src/character.ts';
import { parseCharacter } from '../../domain/src/character.ts';
import { integer, resourceId, text } from '../../domain/src/validation.ts';
import type { Store } from './store.ts';

type Row = Record<string, unknown>;
function fromCharacter(row: Row): Character {
  return { id:String(row.id),name:String(row.name),biography:String(row.biography),appearance:String(row.appearance),
    style:String(row.style),voicePreset:String(row.voice_preset),revision:Number(row.revision),
    lockedVisualVersion:row.locked_visual_version==null?null:Number(row.locked_visual_version),
    createdAt:String(row.created_at),updatedAt:String(row.updated_at) };
}
function fromVisual(row: Row): CharacterVisual {
  return { id:String(row.id),characterId:String(row.character_id),version:Number(row.version),
    mime:row.mime as CharacterVisual['mime'],sha256:String(row.sha256),sizeBytes:Number(row.size_bytes),
    width:Number(row.width),height:Number(row.height),createdAt:String(row.created_at) };
}
function fromLook(row: Row): CharacterLook {
  return { id:String(row.id),characterId:String(row.character_id),name:String(row.name),
    outfit:String(row.outfit),mood:String(row.mood),visualVersion:Number(row.visual_version),createdAt:String(row.created_at) };
}
function fromRole(row: Row): ProjectRole {
  return { id:String(row.id),projectId:String(row.project_id),characterId:String(row.character_id),
    visualVersion:Number(row.visual_version),lookId:row.look_id==null?null:String(row.look_id),
    roleName:String(row.role_name),artifactId:String(row.artifact_id),createdAt:String(row.created_at) };
}
export class CharacterRepository {
  private readonly store: Store;
  constructor(store: Store) { this.store = store; }
  list(q = ''): Character[] {
    const keyword = text(q,'人物检索',100,true);
    return this.store.db.prepare("SELECT * FROM library_characters WHERE ?='' OR instr(name,?)>0 OR instr(biography,?)>0 ORDER BY updated_at DESC LIMIT 200")
      .all(keyword,keyword,keyword).map(fromCharacter);
  }
  get(id: string): Character {
    const row = this.store.db.prepare('SELECT * FROM library_characters WHERE id=?').get(resourceId(id));
    if (!row) throw new AppError('CHARACTER_NOT_FOUND','人物不存在',404);
    return fromCharacter(row);
  }
  create(raw: unknown): Character {
    const input = parseCharacter(raw), id = `character_${randomUUID()}`, now = new Date().toISOString();
    this.store.db.prepare('INSERT INTO library_characters VALUES (?,?,?,?,?,?,1,NULL,?,?)')
      .run(id,input.name,input.biography,input.appearance,input.style,input.voicePreset,now,now);
    return this.get(id);
  }
  update(id: string, raw: unknown, expectedRevision: number): Character {
    const input = parseCharacter(raw);
    integer(expectedRevision,'人物版本',1,Number.MAX_SAFE_INTEGER);
    return this.store.transaction(() => {
      const old = this.get(id);
      invariant(old.revision === expectedRevision,'REVISION_CONFLICT','人物档案已更新，请重新载入',409);
      this.store.db.prepare('UPDATE library_characters SET name=?,biography=?,appearance=?,style=?,voice_preset=?,revision=revision+1,updated_at=? WHERE id=?')
        .run(input.name,input.biography,input.appearance,input.style,input.voicePreset,new Date().toISOString(),id);
      return this.get(id);
    });
  }
  visuals(characterId: string): CharacterVisual[] {
    this.get(characterId);
    return this.store.db.prepare('SELECT * FROM library_character_visuals WHERE character_id=? ORDER BY version').all(characterId).map(fromVisual);
  }
  visual(characterId: string, version: number): CharacterVisual {
    this.get(characterId);
    integer(version,'人物形象版本',1,Number.MAX_SAFE_INTEGER);
    const row=this.store.db.prepare('SELECT * FROM library_character_visuals WHERE character_id=? AND version=?').get(characterId,version);
    if (!row) throw new AppError('CHARACTER_VISUAL_NOT_FOUND','人物形象版本不存在',404);
    return fromVisual(row);
  }
  visualContent(characterId: string, version: number): { visual: CharacterVisual; bytes: Buffer } {
    const visual = this.visual(characterId,version);
    const row = this.store.db.prepare('SELECT content FROM library_character_visuals WHERE id=?').get(visual.id);
    invariant(row?.content instanceof Uint8Array,'CHARACTER_IMAGE_MISSING','人物参考图不存在',409);
    const bytes = Buffer.from(row.content);
    invariant(bytes.length === visual.sizeBytes && createHash('sha256').update(bytes).digest('hex') === visual.sha256,
      'CHARACTER_IMAGE_CHANGED','人物参考图完整性检查失败',409);
    return { visual,bytes };
  }
  addVisual(characterId: string, bytes: Buffer, metadata: {mime: CharacterVisual['mime'];width:number;height:number}): CharacterVisual {
    this.get(characterId);
    invariant(bytes.length>0 && bytes.length<=16*1024*1024,'BODY_TOO_LARGE','人物参考图最大 16 MiB',413);
    integer(metadata.width,'图片宽度',1,16_384);integer(metadata.height,'图片高度',1,16_384);
    invariant(['image/png','image/jpeg','image/webp'].includes(metadata.mime),'INVALID_MEDIA','人物参考图格式不支持');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    return this.store.transaction(() => {
      const version=Number(this.store.db.prepare('SELECT COALESCE(MAX(version),0) AS v FROM library_character_visuals WHERE character_id=?').get(characterId)?.v??0)+1;
      const id=`visual_${randomUUID()}`,now=new Date().toISOString();
      this.store.db.prepare('INSERT INTO library_character_visuals VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(id,characterId,version,metadata.mime,sha256,bytes.length,metadata.width,metadata.height,bytes,now);
      this.store.db.prepare('UPDATE library_characters SET locked_visual_version=?,updated_at=? WHERE id=?').run(version,now,characterId);
      return this.visual(characterId,version);
    });
  }
  looks(characterId: string): CharacterLook[] {
    this.get(characterId);
    return this.store.db.prepare('SELECT * FROM library_character_looks WHERE character_id=? ORDER BY created_at').all(characterId).map(fromLook);
  }
  look(characterId: string,id: string): CharacterLook {
    const row=this.store.db.prepare('SELECT * FROM library_character_looks WHERE id=? AND character_id=?').get(resourceId(id),resourceId(characterId));
    if(!row)throw new AppError('CHARACTER_LOOK_NOT_FOUND','人物造型不存在',404);
    return fromLook(row);
  }
  addLook(characterId: string, raw:{name:string;outfit:string;mood:string;visualVersion:number}): CharacterLook {
    this.visual(characterId,raw.visualVersion);
    const name=text(raw.name,'造型名称',120),outfit=text(raw.outfit,'造型服装',1200,true),mood=text(raw.mood,'造型情绪',600,true);
    const id=`look_${randomUUID()}`,now=new Date().toISOString();
    this.store.db.prepare('INSERT INTO library_character_looks VALUES (?,?,?,?,?,?,?)').run(id,characterId,name,outfit,mood,raw.visualVersion,now);
    return this.look(characterId,id);
  }
  roles(projectId:string):ProjectRole[] {
    this.store.getProject(projectId);
    return this.store.db.prepare('SELECT * FROM library_project_roles WHERE project_id=? ORDER BY created_at').all(projectId).map(fromRole);
  }
  role(id:string):ProjectRole {
    const row=this.store.db.prepare('SELECT * FROM library_project_roles WHERE id=?').get(resourceId(id));
    if(!row)throw new AppError('PROJECT_ROLE_NOT_FOUND','作品角色不存在',404);
    return fromRole(row);
  }
  bindRole(input:{projectId:string;characterId:string;visualVersion:number;lookId:string|null;roleName:string}):{role:ProjectRole;artifact:Artifact} {
    const {projectId,characterId,visualVersion,lookId}=input;
    this.store.getProject(projectId);this.get(characterId);
    const selected = this.visualContent(characterId,visualVersion);
    if(lookId)invariant(this.look(characterId,lookId).visualVersion===visualVersion,
      'CHARACTER_LOOK_MISMATCH','造型与锁定形象版本不一致',409);
    invariant(!this.store.db.prepare('SELECT id FROM library_project_roles WHERE project_id=? AND character_id=?').get(projectId,characterId),
      'ROLE_ALREADY_BOUND','此人物已添加到作品；请在当前作品角色中使用现有绑定',409);
    const id=`artifact_${randomUUID()}`,extension=selected.visual.mime==='image/jpeg'?'jpg':selected.visual.mime==='image/webp'?'webp':'png';
    const relativePath=`assets/${id}/character.${extension}`,root=this.store.getProjectDir(projectId),directory=join(root,'assets',id);
    const media:MediaInfo={kind:'image',durationMs:0,hasAudio:false,format:extension==='jpg'?'jpeg':extension,
      codec:extension==='jpg'?'mjpeg':extension,width:selected.visual.width,height:selected.visual.height};
    mkdirSync(directory,{recursive:false,mode:0o700});
    try {
      writeFileSync(join(directory,`character.${extension}`),selected.bytes,{flag:'wx',mode:0o600});
      return this.store.transaction(()=>{
        const artifact=this.store.addArtifact({id,projectId,name:`${this.get(characterId).name} · 参考 v${visualVersion}`,
          kind:'image',relativePath,sha256:selected.visual.sha256,sizeBytes:selected.visual.sizeBytes,
          media,source:'import',metadata:{characterId,visualVersion,lookId}});
        const roleId=`role_${randomUUID()}`,now=new Date().toISOString();
        this.store.db.prepare('INSERT INTO library_project_roles VALUES (?,?,?,?,?,?,?,?)')
          .run(roleId,projectId,characterId,visualVersion,lookId,text(input.roleName,'角色名称',120),id,now);
        return {role:this.role(roleId),artifact};
      });
    } catch(error) { rmSync(directory,{recursive:true,force:true});throw error; }
  }
}
