#!/usr/bin/env node
/** Real Electron smoke. No provider credentials or paid calls; isolated user data. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { _electron } from 'playwright-core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const exec = promisify(execFile);
const packaged = process.env.OWNTAKE_DESKTOP_EXECUTABLE ? resolve(root,process.env.OWNTAKE_DESKTOP_EXECUTABLE) : undefined;
const screenshot = process.env.OWNTAKE_DESKTOP_SCREENSHOT ? resolve(root,process.env.OWNTAKE_DESKTOP_SCREENSHOT) : undefined;
const unsafeSandbox = process.env.OWNTAKE_DESKTOP_TEST_NO_SANDBOX === '1';
const headless = process.platform === 'linux' && process.env.OWNTAKE_DESKTOP_HEADLESS !== '0'
  && (process.env.OWNTAKE_DESKTOP_HEADLESS === '1' || !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY);
const flags = [...(headless ? ['--ozone-platform=headless'] : []), ...(unsafeSandbox ? ['--no-sandbox'] : [])];
const pageErrors = [], remoteRequests = [], failedResponses = [];
let currentPage;
let application, child, temporary, success = false;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const step = text => console.log(`[desktop-smoke] ${text}`);
async function until(read, ready, label, timeout = 15000) {
  const end = Date.now() + timeout;
  let value;
  do { value = await read(); if (ready(value)) return value; await delay(100); } while (Date.now() < end);
  throw new Error(`${label} timed out: ${JSON.stringify(value)}`);
}
async function exists(path) {
  try { await access(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}
async function executable(setting, name) {
  const candidates = setting ? [resolve(root, setting)] : (process.env.PATH || '').split(delimiter).filter(Boolean)
    .flatMap(dir => (process.platform === 'win32' ? [name+'.exe',name] : [name]).map(binary=>join(dir,binary)));
  for (const candidate of candidates) {
    try { await access(candidate,constants.X_OK); if ((await stat(candidate)).isFile()) return await realpath(candidate); }
    catch { /* Continue through PATH; a missing tool is reported after the last candidate. */ }
  }
  throw new Error(`Missing ${name}; install it or set OWNTAKE_SMOKE_${name.toUpperCase()}`);
}
async function tool(path,args) {
  return exec(path,args,{cwd:root,timeout:30000,maxBuffer:1024*1024,windowsHide:true});
}
async function launch(env) {
  application = await _electron.launch({cwd:root,args:[...flags,...(packaged?[]:['.'])],
    ...(packaged?{executablePath:packaged}:{}),chromiumSandbox:!unsafeSandbox,env,timeout:45000});
  child = application.process();
  await application.context().route('**/*',route=>{
    const url=new URL(route.request().url());
    if (['http:','https:'].includes(url.protocol) && !['127.0.0.1','localhost','[::1]'].includes(url.hostname)) {
      remoteRequests.push(url.origin); return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  const page=await application.firstWindow({timeout:35000}); currentPage=page;
  page.on('response',response=>{if(response.status()>=400)failedResponses.push({path:new URL(response.url()).pathname,status:response.status()});});
  page.setDefaultTimeout(15000);
  page.on('pageerror',error=>pageErrors.push(error.message));
  page.on('crash',()=>pageErrors.push('Renderer crashed'));
  await application.evaluate(({BrowserWindow})=>{
    const window=BrowserWindow.getAllWindows()[0]; window.setContentSize(1280,800); window.show();
  });
  await page.waitForFunction(()=>typeof window.ownTakeDesktop?.info==='function');
  await page.locator('.initial-loading').waitFor({state:'detached'});
  await page.getByRole('navigation',{name:'主导航'}).waitFor({state:'visible'});
  const info=await page.evaluate(()=>window.ownTakeDesktop.info());
  const origin=new URL(info.coreUrl);
  assert.equal(origin.hostname,'127.0.0.1'); assert.equal(origin.protocol,'http:'); assert.ok(Number(origin.port)>0);
  assert.equal(new URL(page.url()).origin,origin.origin); assert.equal(info.background,true);
  assert.ok(info.version && info.electron && info.node);
  return {page,info};
}
async function clickVisible(locator) {
  await locator.waitFor({state:'visible'});
  await locator.scrollIntoViewIfNeeded();
  await locator.click();
}
async function navigate(page,label) {
  const button=page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:label,exact:true});
  await clickVisible(button);
  await until(()=>button.getAttribute('aria-current'),value=>value==='page',`${label} navigation selected`);
}
async function session(coreUrl) {
  const bootstrap=await fetch(coreUrl+'/api/session',{signal:AbortSignal.timeout(10000)});
  assert.equal(bootstrap.status,200);
  const cookie=bootstrap.headers.get('set-cookie')?.split(';')[0], {csrfToken}=await bootstrap.json();
  assert.ok(cookie&&csrfToken);
  async function send(path,{method='GET',body,raw=false,expected=200}={}) {
    assert.ok(path.startsWith('/api/'));
    const response=await fetch(coreUrl+path,{method,redirect:'error',signal:AbortSignal.timeout(20000),headers:{
      Cookie:cookie,'X-CSRF-Token':csrfToken,...(body===undefined?{}:{'Content-Type':raw?'application/octet-stream':'application/json'}),
    },...(body===undefined?{}:{body:raw?body:JSON.stringify(body)})});
    if(response.status!==expected)throw new Error(`${method} ${path}: ${response.status}: ${(await response.text()).slice(0,2000)}`);
    return response;
  }
  return {json:async(path,options)=>(await send(path,options)).json(),bytes:async path=>Buffer.from(await(await send(path)).arrayBuffer())};
}
async function nativeMocks() {
  await application.evaluate(({dialog,shell})=>{
    const state=globalThis.__ownTakeSmoke={results:[],dialogs:[],opened:[],revealed:[]};
    dialog.showOpenDialog=async(...args)=>{
      state.dialogs.push(args.at(-1));
      if(!state.results.length)throw new Error('Unexpected native picker');
      return state.results.shift();
    };
    shell.openPath=async path=>{state.opened.push(path);return '';};
    shell.showItemInFolder=path=>state.revealed.push(path);
  });
}
async function chooseFile(page,label,path) {
  const previous=await application.evaluate(()=>globalThis.__ownTakeSmoke.dialogs.length);
  await application.evaluate((_,value)=>globalThis.__ownTakeSmoke.results.push({canceled:value===null,filePaths:value===null?[]:[value]}),path);
  const button=page.getByRole('button',{name:label,exact:true});
  await clickVisible(button);
  await until(()=>application.evaluate(()=>({count:globalThis.__ownTakeSmoke.dialogs.length,pending:globalThis.__ownTakeSmoke.results.length})),s=>s.count===previous+1&&s.pending===0,label);
  await until(()=>button.isEnabled(),Boolean,`${label} complete`);
}
async function openExport(page,name) {
  await navigate(page,'作品');
  await clickVisible(page.locator('.project-card').filter({hasText:name}));
  await page.getByRole('button',{name:'打开当前项目目录',exact:true}).waitFor({state:'visible'});
  await navigate(page,'导出');
  await page.getByRole('heading',{name:'让故事成为作品',exact:true}).waitFor({state:'visible'});
}
async function noPaidCalls(api,projectId) {
  assert.deepEqual(await api.json('/api/providers'),[]); assert.deepEqual(await api.json('/api/runtimes'),[]);
  for(const kind of ['calls','generations','studio-operations'])assert.deepEqual(await api.json(`/api/projects/${projectId}/${kind}`),[]);
}
async function quit(dataDir,coreUrl) {
  const owned=child;
  await application.close(); application=undefined;
  await until(()=>owned.exitCode,value=>value!==null,'Electron exit'); assert.equal(owned.exitCode,0); child=undefined;
  await until(()=>exists(join(dataDir,'instance.lock')),locked=>!locked,'Data lock release');
  await until(async()=>{
    try{const r=await fetch(coreUrl+'/api/session',{signal:AbortSignal.timeout(1000)});await r.arrayBuffer();return false;}
    catch{return true;}
  },Boolean,'Core shutdown');
}

try {
  if(process.platform==='linux'&&process.getuid?.()===0&&!unsafeSandbox)throw new Error('Use a normal user; sandbox opt-out is only for isolated CI');
  const [ffmpeg,ffprobe]=await Promise.all([executable(process.env.OWNTAKE_SMOKE_FFMPEG,'ffmpeg'),executable(process.env.OWNTAKE_SMOKE_FFPROBE,'ffprobe')]);
  temporary=await mkdtemp(join(tmpdir(),'owntake-desktop-smoke-'));
  const dataDir=join(temporary,'data'),projectsDir=join(temporary,'projects'),sourcePath=join(temporary,'桌面 clip.mp4');
  const env=Object.fromEntries(Object.entries(process.env).filter(([key,value])=>value!==undefined&&!key.startsWith('OWNTAKE_')&&!['NODE_OPTIONS','ELECTRON_RUN_AS_NODE'].includes(key)));
  Object.assign(env,{OWNTAKE_DATA_DIR:dataDir,OWNTAKE_PROJECTS_DIR:projectsDir,OWNTAKE_PORT:'0'});
  await tool(ffmpeg,['-nostdin','-v','error','-f','lavfi','-i','color=c=blue:s=320x180:r=24:d=2','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=2','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac','-shortest','-y',sourcePath]);
  const bytes=await readFile(sourcePath),first=await launch(env),{page}=first,api=await session(first.info.coreUrl);
  step('Renderer isolation and native settings');
  assert.ok(await exists(join(dataDir,'instance.lock')));
  const prefs=await application.evaluate(({BrowserWindow,app})=>{
    const p=BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return {sandbox:p.sandbox,contextIsolation:p.contextIsolation,nodeIntegration:p.nodeIntegration,webSecurity:p.webSecurity,webviewTag:p.webviewTag,noSandbox:app.commandLine.hasSwitch('no-sandbox')};
  });
  assert.deepEqual(prefs,{sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,webviewTag:false,noSandbox:unsafeSandbox});
  assert.deepEqual(await page.evaluate(()=>({require:typeof window.require,process:typeof window.process,bridge:Object.keys(window.ownTakeDesktop).sort()})),{require:'undefined',process:'undefined',bridge:['choosePath','info','openProject','revealArtifact']});
  await nativeMocks(); await navigate(page,'设置');
  await page.getByRole('heading',{name:'桌面工作台',exact:true}).waitFor({state:'visible'});
  const oldSettings=await api.json('/api/settings');
  const ffmpegInput=page.getByRole('textbox',{name:'FFmpeg 可执行文件',exact:true});
  const originalForm=await ffmpegInput.inputValue();
  await chooseFile(page,'选择FFmpeg 可执行文件',null);
  assert.equal(await ffmpegInput.inputValue(),originalForm,'Cancelled picker preserves input');
  await chooseFile(page,'选择FFmpeg 可执行文件',ffmpeg);
  await chooseFile(page,'选择ffprobe 可执行文件',ffprobe);
  assert.equal((await api.json('/api/settings')).ffmpegPath,oldSettings.ffmpegPath,'Selecting a path is not saving settings');
  const saved=page.waitForResponse(r=>r.request().method()==='PUT'&&new URL(r.url()).pathname==='/api/settings');
  await clickVisible(page.getByRole('button',{name:'保存并检测',exact:true})); assert.equal((await saved).status(),200);
  const settings=await api.json('/api/settings'); assert.equal(settings.ffmpegPath,ffmpeg); assert.equal(settings.ffprobePath,ffprobe);
  await chooseFile(page,'选择字幕字体文件',null);
  assert.equal(await page.getByRole('textbox',{name:'字幕字体文件',exact:true}).inputValue(),'');
  await clickVisible(page.getByRole('button',{name:'添加本机 CLI',exact:true}));
  await chooseFile(page,'选择本机 CLI 可执行文件',await realpath(process.execPath));
  const runtimeModal=page.locator('.provider-modal');
  assert.equal(await runtimeModal.getByRole('textbox',{name:'可执行文件绝对路径',exact:true}).inputValue(),await realpath(process.execPath));
  await clickVisible(runtimeModal.getByRole('button',{name:'取消',exact:true}));
  const dialogs=await application.evaluate(()=>globalThis.__ownTakeSmoke.dialogs);
  assert.equal(dialogs.length,5);
  assert.deepEqual(dialogs[3].filters[0].extensions,['otf','ttf','ttc']);
  assert.ok(dialogs.every(item=>item.properties.includes('openFile')&&!item.properties.includes('openDirectory')));
  const health=await api.json('/api/health'); assert.ok(health.ffmpeg.available&&health.ffprobe.available);
  assert.equal(await realpath(health.dataDir),await realpath(dataDir));
  step('Real media, project UI and background export');
  const project=await api.json('/api/projects',{method:'POST',expected:201,body:{name:`Desktop smoke ${randomUUID().slice(0,8)}`,brief:'Local fixture; no paid provider',ratio:'16:9'}});
  const source=await api.json(`/api/projects/${project.id}/assets?name=${encodeURIComponent('桌面 clip.mp4')}`,{method:'POST',expected:201,raw:true,body:bytes});
  assert.equal(source.sha256,digest(bytes)); assert.equal(source.kind,'video');
  const timeline=await api.json(`/api/projects/${project.id}/timeline`,{method:'PUT',body:{expectedVersion:0,width:320,height:180,fps:24,clips:[{artifactId:source.id,sourceInMs:0,durationMs:1500,fit:'contain',muteSource:false}],captions:[],audio:[]}});
  const reloadedProjects=page.waitForResponse(r=>r.request().method()==='GET'&&new URL(r.url()).pathname==='/api/projects');
  await page.reload({waitUntil:'domcontentloaded'});
  const projectList=await reloadedProjects;
  assert.equal(projectList.status(),200);
  assert.ok((await projectList.json()).some(item=>item.id===project.id),'Reloaded UI received its project');
  await page.waitForFunction(()=>!document.querySelector('.initial-loading')&&document.querySelector('.open-project-folder'));
  await openExport(page,project.name);
  await clickVisible(page.getByRole('button',{name:'打开当前项目目录',exact:true}));
  const directory=await realpath(join(projectsDir,project.id));
  await until(()=>application.evaluate(()=>globalThis.__ownTakeSmoke.opened),v=>v.length===1,'Open project directory');
  assert.deepEqual(await application.evaluate(()=>globalThis.__ownTakeSmoke.opened),[directory]);
  assert.deepEqual(await application.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.close();return{visible:w.isVisible(),destroyed:w.isDestroyed()};}),{visible:false,destroyed:false});
  const job=await api.json(`/api/projects/${project.id}/exports`,{method:'POST',expected:202,body:{timelineId:timeline.id,clientRequestId:randomUUID()}});
  const finished=await until(()=>api.json(`/api/jobs/${job.id}`),v=>['succeeded','failed','cancelled'].includes(v.status),'Hidden-window export',60000);
  assert.equal(finished.status,'succeeded',JSON.stringify(finished.error));
  const snapshot=await api.json(`/api/projects/${project.id}`),output=snapshot.artifacts.find(a=>a.id===finished.result.artifactId);
  assert.ok(output); const videoBytes=await api.bytes(`/api/artifacts/${output.id}/content`); assert.equal(digest(videoBytes),output.sha256);
  const rendered=join(temporary,'rendered.mp4'); await writeFile(rendered,videoBytes);
  const probe=JSON.parse((await tool(ffprobe,['-v','error','-show_streams','-show_format','-of','json',rendered])).stdout);
  const video=probe.streams.find(s=>s.codec_type==='video'),audio=probe.streams.find(s=>s.codec_type==='audio');
  assert.equal(video.codec_name,'h264'); assert.equal(audio.codec_name,'aac'); assert.deepEqual([video.width,video.height],[320,180]);
  assert.ok(Math.abs(Number(probe.format.duration)-1.5)<0.2);
  await application.evaluate(({app})=>app.emit('activate'));
  await until(()=>application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()),Boolean,'Reopen');
  await navigate(page,'导出');
  await until(()=>page.getByRole('link',{name:'下载成片',exact:true}).getAttribute('href'),v=>v===`/api/artifacts/${output.id}/content`,'Result displayed');
  const player=page.locator('.output-preview video'); await player.waitFor({state:'visible'});
  await player.evaluate(async element=>{element.muted=true;await element.play();});
  await page.waitForFunction(()=>{const v=document.querySelector('.output-preview video');if(v?.error)throw Error('Video decode failed');return v&&v.videoWidth===320&&v.currentTime>0.05;});
  await player.evaluate(element=>element.pause());
  await clickVisible(page.getByRole('button',{name:'在文件夹中显示',exact:true}));
  await until(()=>application.evaluate(()=>globalThis.__ownTakeSmoke.revealed),v=>v.length===1,'Reveal artifact');
  assert.deepEqual(await application.evaluate(()=>globalThis.__ownTakeSmoke.revealed),[await realpath(join(directory,output.relativePath))]);
  if(screenshot){await mkdir(dirname(screenshot),{recursive:true});await page.screenshot({path:screenshot,fullPage:true});}
  await noPaidCalls(api,project.id); await quit(dataDir,first.info.coreUrl);
  step('Normal quit, lock release and restart persistence');
  const second=await launch(env),reopened=await session(second.info.coreUrl),recovered=await reopened.json(`/api/projects/${project.id}`);
  assert.equal(recovered.timeline.id,timeline.id); assert.equal(recovered.project.name,project.name);
  assert.deepEqual(recovered.artifacts.map(a=>[a.id,a.sha256]).sort(),[[source.id,source.sha256],[output.id,output.sha256]].sort());
  assert.equal(recovered.jobs.length,1); assert.equal(recovered.jobs[0].status,'succeeded');
  assert.equal(digest(await reopened.bytes(`/api/artifacts/${output.id}/content`)),output.sha256);
  await openExport(second.page,project.name); await noPaidCalls(reopened,project.id); await quit(dataDir,second.info.coreUrl);
  assert.deepEqual(pageErrors,[]); assert.deepEqual(remoteRequests,[]); success=true;
  step(`PASS ${process.platform}/${process.arch}, ${packaged?'extracted package':'source build'}; real media, isolation, background export and restart`);
} catch(error) {
  console.error('[desktop-smoke] FAIL',error.stack||error);
  console.error('[desktop-smoke] Renderer errors:',JSON.stringify(pageErrors),'HTTP failures:',JSON.stringify(failedResponses));
  if(currentPage&&!currentPage.isClosed()){
    console.error('[desktop-smoke] Current fixture UI:',await currentPage.locator('body').innerText().catch(()=>'<unavailable>'));
    const failureScreenshot=screenshot||join(root,'test-results','desktop-failure.png');
    await mkdir(dirname(failureScreenshot),{recursive:true});
    await currentPage.screenshot({path:failureScreenshot,fullPage:true}).catch(()=>undefined);
  }
  process.exitCode=1;
}
finally {
  if(application){try{await application.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1});});await application.close();}catch{child?.kill('SIGKILL');}}
  if(temporary){if(success)await rm(temporary,{recursive:true,force:true});else console.error(`[desktop-smoke] Fixture retained: ${temporary}`);}
