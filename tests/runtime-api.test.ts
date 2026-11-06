import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../apps/server/src/app.ts';
import type { StudioOperation, StudioCreateRequest } from '../packages/contracts/src/studio.ts';
import type { LocalRuntimeProfile } from '../packages/contracts/src/runtimes.ts';
import { SCHEMA_VERSION } from '../packages/storage/src/index.ts';

test('runtime API requires explicit trust, creates reviewable drafts, and never respawns unknown or received operations', {timeout:30000}, async t=>{
  const root=await mkdtemp(join(tmpdir(),'owntake-runtime-api-')),binary=join(root,'fixture-cli'),countPath=join(root,'calls.txt');
  const fields={title:'CLI 提出的镜头',purpose:'叙事',description:'窗边晨光',action:'保持',durationMs:1000,caption:'自己的作品',mode:'import',referenceArtifactIds:[]};
  const draft={operations:[{id:'op_fixture',kind:'add',fields}]};
  const flags='--print --output-format --json-schema --model --tools --disallowedTools --permission-mode --safe-mode --strict-mcp-config --mcp-config --setting-sources --no-session-persistence --max-turns --system-prompt';
  await writeFile(binary,`#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);if(args.includes('--version')){console.log('Claude Code 2.1.300');process.exit(0);}if(args.includes('--help')){console.log(${JSON.stringify(flags)});process.exit(0);}let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{fs.appendFileSync(${JSON.stringify(countPath)},'model\\n');if(args[args.indexOf('--model')+1]==='unknown'){process.stderr.write('private-cli-secret');setInterval(()=>{},1000);return;}console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,structured_output:${JSON.stringify(draft)}}));});\n`,{mode:0o700});
  await chmod(binary,0o700);
  const config={dataDir:join(root,'data'),port:0};let app=await startServer(config),cookie='',csrf='';
  t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});
  async function login(){const r=await fetch(app.url+'/api/session');cookie=r.headers.get('set-cookie')!.split(';')[0]!;csrf=(await r.json() as {csrfToken:string}).csrfToken;}
  await login();
  async function api<T=any>(path:string,method='GET',body?:unknown,status=200):Promise<T>{const r=await fetch(app.url+path,{method,headers:{Cookie:cookie,'X-CSRF-Token':csrf,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const v=await r.json();assert.equal(r.status,status,JSON.stringify(v));return v as T;}
  async function until(id:string,status:string):Promise<StudioOperation>{for(let i=0;i<200;i++){const o=app.studio.get(id);if(o.status===status)return o;await new Promise(r=>setTimeout(r,25));}assert.fail(JSON.stringify(app.studio.get(id)));}
  const project=await api('/api/projects','POST',{name:'运行时集成',brief:'中文 brief with $(not-a-command)',ratio:'16:9'},201);
  const profile={label:'测试 CLI',kind:'claude-code',binaryPath:binary,model:'fixture',timeoutMs:500};
  const disabled=await api<LocalRuntimeProfile>('/api/runtimes','POST',profile,201);assert.equal(disabled.enabled,false);
  await api(`/api/runtimes/${disabled.id}`,'PUT',{...profile,enabled:true},409);
  let runtime=await api<LocalRuntimeProfile>(`/api/runtimes/${disabled.id}`,'PUT',{...profile,enabled:true,trustAcknowledged:true});
  const inspection=await api(`/api/runtimes/${runtime.id}/inspect`,'POST',{});assert.equal(inspection.compatible,true);assert.equal(inspection.authentication,'not_checked');
  const intent=(key:string):StudioCreateRequest=>({kind:'runtime_draft',targetId:runtime.id,expectedTargetUpdatedAt:runtime.updatedAt,clientRequestId:key,reservation:{currency:'USD',amount:0.2,singleLimit:1,projectLimit:3},input:{expectedBoardRevision:app.board.snapshot(project.id).revision,expectedProjectRevision:1}});
  const request=intent('runtime-once'),first=await api<StudioOperation>(`/api/projects/${project.id}/studio-operations`,'POST',request,202);
  const duplicate=await api<StudioOperation>(`/api/projects/${project.id}/studio-operations`,'POST',request,202);assert.equal(duplicate.id,first.id);
  const complete=await until(first.id,'succeeded');assert(complete.draftId);assert.equal(app.board.snapshot(project.id).shots.length,0);assert.equal(app.board.getDraft(complete.draftId!).status,'pending');assert.equal(complete.actualAmount,null);
  await api(`/api/drafts/${complete.draftId}/apply`,'POST',{acceptedOperationIds:['op_fixture'],expectedBoardRevision:0});assert.equal(app.board.snapshot(project.id).shots.length,1);
  runtime=await api<LocalRuntimeProfile>(`/api/runtimes/${runtime.id}`,'PUT',{...profile,model:'unknown',enabled:true,trustAcknowledged:true});
  const uncertain=await api<StudioOperation>(`/api/projects/${project.id}/studio-operations`,'POST',intent('runtime-unknown'),202);await until(uncertain.id,'submission_unknown');
  assert.equal((await readFile(countPath,'utf8')).trim().split('\n').length,2);
  const before=await api(`/api/projects/${project.id}/studio-operations`);assert(!JSON.stringify(before).includes('private-cli-secret'));assert(!JSON.stringify(before).includes('credentialRef'));
  await app.close();app=await startServer(config);await login();assert.equal(app.store.schemaVersion,SCHEMA_VERSION);assert.equal(app.studio.get(uncertain.id).status,'submission_unknown');
  await app.studioRunner.stop();const recovered=app.studio.create(project.id,intent('runtime-received'));app.studio.receive(recovered,Buffer.from(JSON.stringify(draft)),'application/json');
  await app.close();app=await startServer(config);await login();const recoveredResult=await until(recovered.id,'succeeded');assert(recoveredResult.draftId);assert.equal(app.board.snapshot(project.id).shots.length,1);assert.equal((await readFile(countPath,'utf8')).trim().split('\n').length,2);
  assert.equal(app.store.db.prepare('SELECT COUNT(*) AS n FROM studio_receipts').get()!.n,0);
});
