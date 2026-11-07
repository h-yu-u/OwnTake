import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../packages/storage/src/store.ts';
import { StoryboardStore } from '../packages/storage/src/storyboard.ts';
import { StoryRepository } from '../packages/storage/src/story-repository.ts';
import { CharacterRepository } from '../packages/storage/src/character-repository.ts';
import { ShotCastRepository } from '../packages/storage/src/shot-cast-repository.ts';
import { AppError } from '../packages/contracts/src/errors.ts';
import { splitScriptScenes, scriptToDraftOperations } from '../packages/domain/src/script-scenes.ts';
import { storyScriptToStoryboard } from '../apps/server/src/application/story-to-board.ts';
import { compileGenerationRequest, validateGeneration } from '../packages/providers/src/generation.ts';
import type { GenerationPlan, ProviderProfile } from '../packages/contracts/src/providers.ts';

const source={
  title:'出租车',genre:'悬疑',summary:'雨夜偶遇',tags:['都市'],beats:['出发','反转'],
  source:{platform:'original' as const,url:'',title:'',author:'',rights:'original' as const},
};
const identity={name:'林夏',biography:'虚构演员',appearance:'中长黑发',style:'写实',voicePreset:''};
const shot={
  title:'雨夜',purpose:'建立悬念',description:'林夏望向窗外',action:'抬头',durationMs:4000,caption:'',
  mode:'generate_image' as const,referenceArtifactIds:[],
};
function fixture(t:{after:(fn:()=>void)=>void}) {
  const root=mkdtempSync(join(tmpdir(),'owntake-cast-film-'));
  const store=new Store({dataDir:join(root,'data'),projectsDir:join(root,'projects')});
  const board=new StoryboardStore(store),stories=new StoryRepository(store),characters=new CharacterRepository(store);
  const shotCast=new ShotCastRepository(store,board,characters);
  t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  return{root,store,board,stories,characters,shotCast};
}
function png(root:string):Buffer{
  const path=join(root,'frame.png');
  const p=spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=red:s=320x320','-frames:v','1',path]);
  assert.equal(p.status,0,p.stderr?.toString());
  return readFileSync(path);
}
test('deterministic story script breakdown is bounded and reviewable',()=>{
  const scenes=splitScriptScenes('场景一：雨夜\n司机等待。\n场景二：车厢\n乘客上车。');
  assert.equal(scenes.length,2);
  assert.equal(scenes[1]?.title,'场景二：车厢');
  assert.equal(scriptToDraftOperations('场景一：雨夜\n司机等待。',()=> 'draftop_test').length,1);
  assert.throws(()=>splitScriptScenes('a'.repeat(13_000)),(e:unknown)=>e instanceof AppError&&e.code==='SCRIPT_SCENE_TOO_LONG');
});
test('script to storyboard requires frozen source project and leaves board unchanged until accepted',t=>{
  const f=fixture(t),s=f.stories.create(source);
  const script=f.stories.saveScript(s.id,1,'场景一：车内\n司机开口。\n场景二：窗外\n雨水滑过玻璃。');
  const {project}=f.stories.createProject(s.id,1,script.version,'9:16');
  const draft=storyScriptToStoryboard({stories:f.stories,board:f.board},s.id,{
    projectId:project.id,scriptVersion:script.version,expectedBoardRevision:0,
  });
  assert.equal(draft.operations.length,2);
  assert.equal(f.board.snapshot(project.id).shots.length,0);
  const board=f.board.applyDraft(draft.id,draft.operations.map(item=>item.id),0);
  assert.equal(board.shots.length,2);
  assert.throws(()=>storyScriptToStoryboard({stories:f.stories,board:f.board},s.id,{
    projectId:project.id,scriptVersion:script.version,expectedBoardRevision:0,
  }),(e:unknown)=>e instanceof AppError&&e.code==='REVISION_CONFLICT');
  const unrelated=f.store.createProject({name:'其他作品'});
  assert.throws(()=>storyScriptToStoryboard({stories:f.stories,board:f.board},s.id,{
    projectId:unrelated.id,scriptVersion:script.version,expectedBoardRevision:0,
  }),(e:unknown)=>e instanceof AppError&&e.code==='STORY_PROJECT_MISMATCH');
});
test('shot character bindings freeze visual version and reject cross-project roles',t=>{
  const f=fixture(t),bytes=png(f.root),actor=f.characters.create(identity);
  const first=f.characters.addVisual(actor.id,bytes,{mime:'image/png',width:320,height:320});
  f.characters.addVisual(actor.id,bytes,{mime:'image/png',width:320,height:320});
  const a=f.store.createProject({name:'A'}),b=f.store.createProject({name:'B'});
  const roleA=f.characters.bindRole({projectId:a.id,characterId:actor.id,visualVersion:first.version,lookId:null,roleName:'乘客'});
  const roleB=f.characters.bindRole({projectId:b.id,characterId:actor.id,visualVersion:2,lookId:null,roleName:'另一故事'});
  const active=f.board.addShot(a.id,shot,0).shots[0]!;
  assert.throws(()=>f.shotCast.bind(active.id,[roleB.role.id],active.revision),
    (e:unknown)=>e instanceof AppError&&e.code==='INVALID_CAST');
  const next=f.shotCast.bind(active.id,[roleA.role.id],active.revision).shots[0]!;
  assert.equal(next.visualRevision,2);
  assert.deepEqual(next.referenceArtifactIds,[roleA.artifact.id]);
  const bindings=f.shotCast.list(active.id);
  assert.equal(bindings[0]?.visualVersion,1);
  assert.equal(bindings[0]?.referenceArtifactId,roleA.artifact.id);
  const after=f.characters.update(actor.id,{...identity,name:'林夏新版'},1);
  assert.equal(after.revision,2);
  assert.equal(f.shotCast.snapshot(active.id)[0]?.visualVersion,1);
  assert.throws(()=>f.shotCast.bind(active.id,[roleA.role.id],active.revision),
    (e:unknown)=>e instanceof AppError&&e.code==='REVISION_CONFLICT');
  const cleared=f.shotCast.bind(active.id,[],next.revision).shots[0]!;
  assert.deepEqual(cleared.referenceArtifactIds,[]);
  assert.equal(f.shotCast.list(active.id).length,0);
});
test('image edit connector compiles frozen references into JSON without silently downgrading',()=>{
  const time=new Date().toISOString();
  const profile:ProviderProfile={
    id:'p_edit',label:'Reference edits',kind:'openai-image-edits',baseUrl:'https://api.openai.com/v1',model:'gpt-image-1.5',
    capabilities:{inputModes:['references'],ratios:['1:1'],durationsSec:[],maxReferences:4},
    maxOutputTokens:4096,timeoutMs:60000,createdAt:time,updatedAt:time,
  };
  const plan:GenerationPlan={
    kind:'image',inputMode:'references',prompt:'保持人物身份与面部结构，置于雨夜车厢',ratio:'1:1',referenceArtifactIds:['photo_a'],
  };
  const bytes=Buffer.from('not-a-real-image');
  const data='data:image/png;base64,'+bytes.toString('base64');
  const compiled=compileGenerationRequest(profile,plan,{photo_a:data});
  assert.equal(compiled.endpoint,'/images/edits');
  assert.equal((compiled.body.images as {image_url:string}[])[0]?.image_url,data);
  assert.equal(compiled.body.model,'gpt-image-1.5');
  assert.equal(validateGeneration(profile,{...plan,inputMode:'text',referenceArtifactIds:[]},[]).status,'needs_replan');
  assert.throws(()=>compileGenerationRequest(profile,plan,{photo_a:'data:image/bmp;base64,'+bytes.toString('base64')}),
    (e:unknown)=>e instanceof AppError&&e.code==='EDIT_REFERENCE_FORMAT');
});
