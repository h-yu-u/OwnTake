import { invariant } from '../../contracts/src/errors.ts';
import type { CastReferenceSnapshot, ShotCastBinding } from '../../contracts/src/shot-cast.ts';
import type { BoardSnapshot } from '../../contracts/src/storyboard.ts';
import type { CharacterRepository } from './character-repository.ts';
import type { StoryboardStore } from './storyboard.ts';
import type { Store } from './store.ts';
import { integer, resourceId } from '../../domain/src/validation.ts';

export class ShotCastRepository {
  private readonly store:Store;
  private readonly board:StoryboardStore;
  private readonly characters:CharacterRepository;
  constructor(store:Store,board:StoryboardStore,characters:CharacterRepository){
    this.store=store;this.board=board;this.characters=characters;
  }
  list(shotId:string):ShotCastBinding[] {
    const id=resourceId(shotId);
    this.board.getShot(id);
    return this.store.db.prepare(`SELECT c.*,r.project_id,r.role_name,ch.name AS character_name
      FROM library_shot_cast c
      JOIN library_project_roles r ON r.id=c.role_id
      JOIN library_characters ch ON ch.id=c.character_id
      WHERE c.shot_id=? ORDER BY c.rowid`).all(id).map(row=>({
      shotId:String(row.shot_id),roleId:String(row.role_id),projectId:String(row.project_id),
      characterId:String(row.character_id),characterName:String(row.character_name),roleName:String(row.role_name),
      visualVersion:Number(row.visual_version),lookId:row.look_id==null?null:String(row.look_id),
      referenceArtifactId:String(row.reference_artifact_id),createdAt:String(row.created_at),
    }));
  }
  snapshot(shotId:string):CastReferenceSnapshot[] {
    return this.list(shotId).map(({roleId,characterId,visualVersion,lookId,referenceArtifactId})=>({
      roleId,characterId,visualVersion,lookId,referenceArtifactId,
    }));
  }
  bind(shotId:string,roleIds:string[],expectedRevision:number):BoardSnapshot {
    const shot=this.board.getShot(resourceId(shotId));
    integer(expectedRevision,'镜头版本',1,Number.MAX_SAFE_INTEGER);
    invariant(!shot.archived,'SHOT_ARCHIVED','归档镜头不可绑定人物',409);
    invariant(Array.isArray(roleIds)&&roleIds.length<=4&&new Set(roleIds).size===roleIds.length,
      'INVALID_CAST','每个镜头最多绑定四位不同人物',422);
    const roles=roleIds.map(id=>this.characters.role(resourceId(id)));
    invariant(roles.every(role=>role.projectId===shot.projectId),
      'INVALID_CAST','镜头不能引用其他作品的角色',409);
    for(const role of roles) {
      const reference=this.store.getArtifact(role.artifactId);
      invariant(reference.projectId===shot.projectId&&reference.kind==='image'&&
        reference.sha256===this.characters.visual(role.characterId,role.visualVersion).sha256,
        'INVALID_CAST','人物参考图不属于本作品或与锁定版本不一致',409);
    }
    return this.store.transaction(()=>{
      const current=this.board.getShot(shot.id);
      invariant(current.revision===expectedRevision,'REVISION_CONFLICT','镜头版本已更新',409);
      const previous=this.list(shot.id);
      const previousRefs=new Set(previous.map(item=>item.referenceArtifactId));
      const extras=current.referenceArtifactIds.filter(id=>!previousRefs.has(id));
      const references=[...extras,...roles.map(role=>role.artifactId)];
      invariant(references.length<=16&&new Set(references).size===references.length,
        'CAST_REFERENCE_LIMIT','当前镜头的参考图片已超过 16 张，请先减少素材引用',409);
      this.store.db.prepare('DELETE FROM library_shot_cast WHERE shot_id=?').run(shot.id);
      const now=new Date().toISOString();
      for(const role of roles)this.store.db.prepare('INSERT INTO library_shot_cast VALUES (?,?,?,?,?,?,?)')
        .run(shot.id,role.id,role.artifactId,role.visualVersion,role.characterId,role.lookId,now);
      const fields={
        title:current.title,purpose:current.purpose,description:current.description,action:current.action,
        durationMs:current.durationMs,caption:current.caption,mode:current.mode,
        referenceArtifactIds:references,
      };
      return this.board.updateShot(shot.id,fields,expectedRevision);
    });
  }
}
