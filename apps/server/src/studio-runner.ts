import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AppError, invariant } from '../../../packages/contracts/src/errors.ts';
import type { JobStatus } from '../../../packages/contracts/src/index.ts';
import type { ReviewFrame, FrameReviewResult, SpeechInput } from '../../../packages/contracts/src/studio-provider.ts';
import { parseDraftOperations } from '../../../packages/domain/src/storyboard.ts';
import { extractThumbnail, probe } from '../../../packages/media/src/index.ts';
import { submitSpeech } from '../../../packages/providers/src/speech.ts';
import { callFrameReview } from '../../../packages/providers/src/frame-review.ts';
import { ProviderCallError } from '../../../packages/providers/src/errors.ts';
import { runLocalDraft, RuntimeCallError } from '../../../packages/runtimes/src/local.ts';
import { hashFile, resolveAsset } from './assets.ts';
import type { StudioRepository, StoredStudioOperation } from './studio-repository.ts';

function jobStatus(o:StoredStudioOperation):JobStatus { return o.status==='queued'?'queued':o.status==='submitting'||o.status==='received'?'running':o.status==='submission_unknown'||o.status==='ingest_failed'?'blocked':o.status; }
async function checkedDirectory(parent:string,name:string):Promise<string> {
  const path=join(parent,name);try{await mkdir(path,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  const info=await lstat(path);invariant(info.isDirectory()&&!info.isSymbolicLink()&&await realpath(path)===path,'FORBIDDEN_PATH','创作任务目录不能是符号链接',403);return path;
}
export class StudioRunner {
  readonly repository:StudioRepository;
  private timer?:ReturnType<typeof setInterval>;
  private active?:{id:string;controller:AbortController;promise:Promise<void>};
  private stopping=false;
  constructor(repository:StudioRepository){this.repository=repository;}
  private persist(o:StoredStudioOperation):void{
    const {store}=this.repository;store.transaction(()=>{const current=this.repository.get(o.id);if(['succeeded','cancelled'].includes(current.status))return;o.actualAmount=current.actualAmount??o.actualAmount;o.settlementNote=current.settlementNote??o.settlementNote;this.repository.save(o);store.updateJob(o.jobId,{status:jobStatus(o),error:o.error,...(o.status==='succeeded'?{progress:1,result:{operationId:o.id,artifactId:o.artifactId,draftId:o.draftId}}:{})});});
  }
  start():void{
    for(const o of this.repository.all()){
      if(o.status!=='submitting'&&o.status!=='received')continue;
      if(this.repository.receipt(o.id)){o.status='received';o.error=null;}
      else{o.status='submission_unknown';o.error={code:'SUBMISSION_UNKNOWN',message:'服务在执行期间中断，外部服务可能已处理。不会再次提交或启动 CLI，请核对原调用。'};}
      this.persist(o);
    }
    this.timer=setInterval(()=>this.tick(),300);this.timer.unref();this.tick();
  }
  tick():void{
    if(this.stopping||this.active)return;
    const operations=this.repository.all();
    for(const pending of operations.filter(o=>o.status==='queued'&&o.speechBatch)){
      const blocked=operations.some(o=>o.projectId===pending.projectId&&o.speechBatch?.id===pending.speechBatch!.id&&o.speechBatch.index<pending.speechBatch!.index&&['failed','cancelled','submission_unknown','ingest_failed'].includes(o.status));
      if(blocked){pending.status='cancelled';pending.actualAmount=0;pending.error={code:'BATCH_STOPPED',message:'前面的配音未完成，本镜头尚未调用。已停止本批次后续请求。'};this.persist(pending);}
    }
    const o=this.repository.all().find(o=>o.status==='queued'||o.status==='received');if(!o)return;
    const controller=new AbortController(),promise=this.run(o,controller.signal).catch(()=>{console.error('[OwnTake] studio state persistence failed; inspect the saved operation');}).finally(()=>{this.active=undefined;});
    this.active={id:o.id,controller,promise};
  }
  private async run(o:StoredStudioOperation,signal:AbortSignal):Promise<void>{
    let work:string|undefined;
    try{
      const root=await realpath(this.repository.store.getProjectDir(o.projectId)),area=await checkedDirectory(root,'.work'),parent=await checkedDirectory(area,o.id);work=await checkedDirectory(parent,randomUUID());
      if(o.status==='queued'){
        const key=o.kind==='runtime_draft'?'':this.repository.providers.vault.get(o.credentialRef);
        let frames:Array<ReviewFrame & {dataUrl:string}>=[];
        if(o.kind==='frame_review')frames=await this.sample(o,work,signal);
        if(signal.aborted||this.repository.get(o.id).status==='cancelled')return;
        this.repository.store.transaction(()=>{
          for(const frame of frames){const {dataUrl,...metadata}=frame;this.repository.store.db.prepare('INSERT INTO studio_frames(operation_id,frame_id,data,metadata_json) VALUES(?,?,?,?)').run(o.id,frame.id,Buffer.from(dataUrl.split(',')[1]!,'base64'),JSON.stringify(metadata));}
          o.status='submitting';this.persist(o);
        });
        if(o.kind==='runtime_draft'){
          const result=await runLocalDraft(o.runtime!,{taskId:o.id,workDir:work,brief:o.frozen.brief!,shots:o.frozen.shots!,signal});
          this.repository.receive(o,Buffer.from(JSON.stringify({operations:result.operations})),'application/json');
        }else{
          if(o.kind==='tts'){const result=await submitSpeech(o.provider!,key,o.input as SpeechInput,{signal});this.repository.receive(o,result.bytes,result.mime);}
          else{const result=await callFrameReview(o.provider!,key,{expected:o.frozen.expected!,frames,signal});this.repository.receive(o,Buffer.from(JSON.stringify(result)),'application/json');}
        }
      }
      if(o.status==='received')await this.finalize(o,work,signal);
    }catch(error){
      const current=this.repository.get(o.id);if(['cancelled','succeeded'].includes(current.status))return;
      if(o.status==='queued'&&this.stopping)return;
      if(o.status==='received'){o.status='ingest_failed';o.error={code:error instanceof AppError?error.code:'INGEST_FAILED',message:error instanceof AppError?error.message:'完整回复已保存，本地入库失败；可仅恢复入库，不会重新调用。'};}
      else if(o.status==='queued'||error instanceof RuntimeCallError&&error.classification==='preflight_failed'){
        o.status='failed';o.actualAmount=0;o.error={code:'LOCAL_PREFLIGHT_FAILED',message:error instanceof AppError||error instanceof RuntimeCallError?error.message:'本机工具或输入检查失败，尚未发起模型调用。'};
      }else{
        const known=error instanceof ProviderCallError&&['http_rejected','invalid_response'].includes(error.classification)||error instanceof RuntimeCallError&&error.classification==='invalid_output';
        o.status=known?'failed':'submission_unknown';o.error={code:known?'INVALID_EXTERNAL_RESULT':'SUBMISSION_UNKNOWN',message:error instanceof ProviderCallError&&error.classification==='http_rejected'?error.message:known?'外部返回拒绝或无效结果，既有作品未改变；费用仍需核对。':o.budgetMode==='none'?'执行结果不明，外部服务或 CLI 可能已处理；不会自动再次提交或启动 CLI，请核对原记录。':'执行结果不明，外部服务可能已处理；不会自动再次提交或启动 CLI，预留继续保留。'};
      }
      this.persist(o);
    }finally{if(work)await rm(work,{recursive:true,force:true}).catch(()=>undefined);}
  }
  private async sample(o:StoredStudioOperation,work:string,signal:AbortSignal):Promise<Array<ReviewFrame & {dataUrl:string}>>{
    const {artifact,path}=await resolveAsset(this.repository.store,o.frozen.artifact!.id);
    invariant(artifact.projectId===o.projectId&&artifact.sha256===o.source.sha256&&await hashFile(path,signal)===o.source.sha256,'ASSET_CHANGED','审核源素材已改变，请恢复原文件',409);
    const positions=artifact.kind==='image'?[0]:[0.1,0.5,0.9].map(r=>Math.min(artifact.media.durationMs-1,Math.floor(artifact.media.durationMs*r))),frames:Array<ReviewFrame & {dataUrl:string}>=[];
    for(const [i,at]of positions.entries()){
      const target=join(work,`frame-${i}.png`),media=await extractThumbnail(path,target,{...this.repository.store.getSettings(),atMs:at,width:640,height:640,signal});
      const bytes=await readFile(target,{signal});invariant(bytes.length<=2*1024*1024,'FRAME_TOO_LARGE','抽样帧超过2MiB限制');
      frames.push({id:`frame-${i+1}`,requestedTimeMs:at,sha256:createHash('sha256').update(bytes).digest('hex'),width:media.width!,height:media.height!,mime:'image/png',dataUrl:`data:image/png;base64,${bytes.toString('base64')}`});
    }invariant(await hashFile(path,signal)===o.source.sha256,'ASSET_CHANGED','审核抽帧期间源素材发生变化，尚未提交模型',409);return frames;
  }
  private async finalize(o:StoredStudioOperation,work:string,signal:AbortSignal):Promise<void>{
    const receipt=this.repository.receipt(o.id);invariant(receipt,'RECEIPT_MISSING','完整回复记录缺失，请核对本地备份；不会重新调用',409);
    const {store,board}=this.repository;
    if(o.kind==='tts'){
      invariant(receipt.mime==='audio/wav','RECEIPT_MISMATCH','接收音频格式不一致',409);
      const source=join(work,'received.wav'),file=await open(source,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY,0o600);try{await file.writeFile(receipt.bytes);await file.sync();}finally{await file.close();}
      const media=await probe(source,{ffprobePath:store.getSettings().ffprobePath,signal});invariant(media.kind==='audio'&&media.hasAudio,'INVALID_SPEECH','收到的结果不是有效音频',422);
      const root=await realpath(store.getProjectDir(o.projectId)),area=await checkedDirectory(root,'assets'),directory=await checkedDirectory(area,o.outputArtifactId),target=join(directory,'speech.wav');
      try{await link(source,target);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;const info=await lstat(target);invariant(info.isFile()&&!info.isSymbolicLink()&&info.size===receipt.bytes.length&&await hashFile(target,signal)===receipt.sha256,'RESULT_CHANGED','已有配音结果与完整回复不同，原文件未覆盖',409);}
      const parent=await open(directory,'r');try{await parent.sync();}finally{await parent.close();}
      store.transaction(()=>{store.addArtifact({id:o.outputArtifactId,projectId:o.projectId,name:o.speechBatch?`配音-${String(o.speechBatch.index+1).padStart(2,'0')}-${o.speechBatch.shotTitle}.wav`:`配音-${o.id.slice(0,8)}.wav`,kind:'audio',relativePath:`assets/${o.outputArtifactId}/speech.wav`,sha256:receipt.sha256,sizeBytes:receipt.bytes.length,media,source:'generated',metadata:{operationId:o.id,...(o.speechBatch?{speechBatchId:o.speechBatch.id,shotId:o.source.shotId,shotRevision:o.speechBatch.shotRevision}:{}),providerId:o.targetId,model:o.targetModel,voice:(o.input as SpeechInput).voice,aiGenerated:true}});o.artifactId=o.outputArtifactId;o.status='succeeded';o.error=null;this.persist(o);store.db.prepare('DELETE FROM studio_receipts WHERE operation_id=?').run(o.id);});
    }else{
      invariant(receipt.mime==='application/json','RECEIPT_MISMATCH','接收结构化结果格式不一致',409);
      const result=JSON.parse(receipt.bytes.toString('utf8'));
      store.transaction(()=>{
        if(o.kind==='runtime_draft'){const operations=parseDraftOperations(result.operations);const draft=board.createDraft(o.projectId,{operations,baseRevision:o.source.boardRevision!,source:'model'});o.draftId=draft.id;}
        else{o.review={ruleVersion:'sampled-visual-v1',samplingVersion:'fixed-three-v1',frames:store.db.prepare('SELECT metadata_json FROM studio_frames WHERE operation_id=? ORDER BY frame_id').all(o.id).map(row=>JSON.parse(String(row.metadata_json))),report:result as FrameReviewResult,coverage:{visual:'sampled_frames',motion:'not_checked',audio:'not_checked'}};}
        o.status='succeeded';o.error=null;this.persist(o);store.db.prepare('DELETE FROM studio_receipts WHERE operation_id=?').run(o.id);
      });
    }
  }
  cancel(id:string):StoredStudioOperation{
    const o=this.repository.get(id);if(o.status==='queued'){o.status='cancelled';o.actualAmount=0;o.error=null;this.persist(o);if(this.active?.id===id)this.active.controller.abort();}
    else if(o.status==='submitting'&&this.active?.id===id)this.active.controller.abort();
    return this.repository.get(id);
  }
  retryIngest(id:string):StoredStudioOperation{const o=this.repository.get(id);invariant(o.status==='ingest_failed'&&this.repository.receipt(id),'CANNOT_RETRY_INGEST','没有可恢复的完整本地回复',409);o.status='received';o.error=null;this.persist(o);this.tick();return this.repository.get(id);}
  async stop():Promise<void>{this.stopping=true;clearInterval(this.timer);this.active?.controller.abort();await this.active?.promise;}
}
