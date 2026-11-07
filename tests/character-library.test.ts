import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, restoreBackup } from '../packages/storage/src/index.ts';
import { CharacterRepository } from '../packages/storage/src/character-repository.ts';
import { AppError } from '../packages/contracts/src/errors.ts';

const identity={name:'林夏',biography:'来自海边的设计师',appearance:'中长黑发，五官轮廓稳定',style:'电影写实',voicePreset:'zh-CN-default'};
function fixture(t:{after:(fn:()=>void)=>void}) {
  const root=mkdtempSync(join(tmpdir(),'owntake-actors-'));
  const options={dataDir:join(root,'data'),projectsDir:join(root,'projects')};
  const store=new Store(options),characters=new CharacterRepository(store);
  t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  return {root,options,store,characters};
}
function png(root:string) {
  const path=join(root,'person.png');
  const p=spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=blue:s=320x320','-frames:v','1',path]);
  assert.equal(p.status,0,p.stderr?.toString());
  return readFileSync(path);
}

test('character visuals are immutable, and multiple projects receive independent assets',t=>{
  const f=fixture(t),actor=f.characters.create(identity),bytes=png(f.root);
  const first=f.characters.addVisual(actor.id,bytes,{mime:'image/png',width:320,height:320});
  const second=f.characters.addVisual(actor.id,bytes,{mime:'image/png',width:320,height:320});
  assert.equal(second.version,2);assert.equal(f.characters.get(actor.id).lockedVisualVersion,2);
  assert.equal(f.characters.visualContent(actor.id,1).visual.sha256,first.sha256);
  const look=f.characters.addLook(actor.id,{name:'雨夜',outfit:'黑风衣',mood:'冷静',visualVersion:1});
  const p1=f.store.createProject({name:'作品一'}),p2=f.store.createProject({name:'作品二'});
  const one=f.characters.bindRole({projectId:p1.id,characterId:actor.id,visualVersion:1,lookId:look.id,roleName:'乘客'});
  const two=f.characters.bindRole({projectId:p2.id,characterId:actor.id,visualVersion:2,lookId:null,roleName:'女主角'});
  assert.equal(one.role.visualVersion,1);assert.equal(two.role.visualVersion,2);
  assert.notEqual(one.artifact.id,two.artifact.id);
  assert.deepEqual(readFileSync(f.store.resolveArtifactPath(one.artifact.id)),bytes);
  assert.throws(()=>f.characters.bindRole({projectId:p1.id,characterId:actor.id,visualVersion:2,lookId:null,roleName:'重绑'}),
    (error:unknown)=>error instanceof AppError && error.code==='ROLE_ALREADY_BOUND');
  const update=f.characters.update(actor.id,{...identity,name:'林夏·新版'},1);
  assert.equal(update.revision,2);
  assert.equal(f.characters.role(one.role.id).visualVersion,1);
});

test('immutable character reference BLOBs survive backup and restore without external files',async t=>{
  const f=fixture(t),actor=f.characters.create(identity),bytes=png(f.root);
  f.characters.addVisual(actor.id,bytes,{mime:'image/png',width:320,height:320});
  const dest=join(f.root,'backup');
  await f.store.backupTo(dest);
  const target={dataDir:join(f.root,'restored-data'),projectsDir:join(f.root,'restored-projects')};
  await restoreBackup(dest,target);
  const recovered=new Store(target);
  try{
    const actors=new CharacterRepository(recovered);
    assert.equal(actors.visuals(actor.id).length,1);
    assert.deepEqual(actors.visualContent(actor.id,1).bytes,bytes);
  }finally{recovered.close();}
});
