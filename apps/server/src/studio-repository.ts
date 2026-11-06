import { createHash, randomUUID } from 'node:crypto';
import type { Store } from '../../../packages/storage/src/index.ts';
import type { StoryboardStore } from '../../../packages/storage/src/storyboard.ts';
import type { Artifact } from '../../../packages/contracts/src/index.ts';
import type { Shot } from '../../../packages/contracts/src/storyboard.ts';
import type { ProviderProfile } from '../../../packages/contracts/src/providers.ts';
import type { LocalRuntimeProfile } from '../../../packages/contracts/src/runtimes.ts';
import type { Reservation } from '../../../packages/contracts/src/calls.ts';
import type { StudioOperation, StudioInput, StudioKind } from '../../../packages/contracts/src/studio.ts';
import { AppError, invariant } from '../../../packages/contracts/src/errors.ts';
import { finiteNumber, integer, record, resourceId, text } from '../../../packages/domain/src/validation.ts';
import { requestHash } from '../../../packages/storage/src/validation.ts';
import { validateSpeechInput } from '../../../packages/providers/src/speech.ts';
import { ProviderRepository, reservationInput } from './provider-repository.ts';
import type { RuntimeRepository } from './runtime-repository.ts';

export interface StoredStudioOperation extends StudioOperation {
  operationId: string; reservation: Reservation; outputArtifactId: string;
  provider?: ProviderProfile; runtime?: LocalRuntimeProfile; credentialRef: string | null;
  frozen: { artifact?: Artifact; expected?: { purpose: string; description: string; action: string }; brief?: string; shots?: Shot[] };
  settlementNote?: string;
}
export function publicStudio(o: StoredStudioOperation): StudioOperation {
  const { id, projectId, kind, status, jobId, targetId, targetLabel, targetModel, input, source, currency, reservedAmount, actualAmount, artifactId, draftId, review, error, createdAt, updatedAt } = o;
  return { id, projectId, kind, status, jobId, targetId, targetLabel, targetModel, input, source, currency, reservedAmount, actualAmount, artifactId, draftId, review, error, createdAt, updatedAt };
}
export class StudioRepository {
  readonly store: Store; readonly board: StoryboardStore; readonly providers: ProviderRepository; readonly runtimes: RuntimeRepository;
  constructor(store: Store, board: StoryboardStore, providers: ProviderRepository, runtimes: RuntimeRepository) { this.store=store; this.board=board; this.providers=providers; this.runtimes=runtimes; }
  get(id: string): StoredStudioOperation {
    const row=this.store.db.prepare('SELECT body_json FROM studio_operations WHERE id=?').get(resourceId(id));
    if (!row) throw new AppError('OPERATION_NOT_FOUND', '创作工具任务不存在', 404);
    return JSON.parse(String(row.body_json));
  }
  all(): StoredStudioOperation[] { return this.store.db.prepare('SELECT body_json FROM studio_operations ORDER BY rowid').all().map(row=>JSON.parse(String(row.body_json))); }
  list(projectId: string): StudioOperation[] { this.store.getProject(projectId); return this.all().filter(o=>o.projectId===projectId).map(publicStudio).reverse(); }
  save(o: StoredStudioOperation): void { o.updatedAt=new Date().toISOString(); this.store.db.prepare('UPDATE studio_operations SET status=?,body_json=? WHERE id=?').run(o.status,JSON.stringify(o),o.id); this.store.appendEvent(o.projectId,'studio.updated',{operationId:o.id,status:o.status}); }
  receive(o: StoredStudioOperation, bytes: Uint8Array, mime: string): void {
    invariant(bytes.byteLength>0 && bytes.byteLength<=32*1024*1024,'RECEIPT_TOO_LARGE','接收结果超过本地保存上限');
    this.store.transaction(()=>{
      this.store.db.prepare('INSERT INTO studio_receipts(operation_id,data,sha256,mime) VALUES(?,?,?,?)').run(o.id,bytes,createHash('sha256').update(bytes).digest('hex'),mime);
      o.status='received'; o.error=null; this.save(o); this.store.updateJob(o.jobId,{status:'running',error:null});
    });
  }
  receipt(id: string): { bytes: Buffer; sha256: string; mime: string } | null {
    const row=this.store.db.prepare('SELECT data,sha256,mime FROM studio_receipts WHERE operation_id=?').get(id); if(!row)return null;
    const bytes=Buffer.from(row.data as Uint8Array); invariant(createHash('sha256').update(bytes).digest('hex')===row.sha256,'RECEIPT_CHANGED','保存的完整回复摘要不一致',409);
    return {bytes,sha256:String(row.sha256),mime:String(row.mime)};
  }
  create(projectId: string,value: unknown): StoredStudioOperation {
    const b=record(value); invariant(Object.keys(b).every(k=>['kind','targetId','expectedTargetUpdatedAt','clientRequestId','reservation','input'].includes(k)),'INVALID_INPUT','创作请求包含不支持的字段');
    invariant(['tts','frame_review','runtime_draft'].includes(String(b.kind)),'INVALID_INPUT','创作工具类型无效');
    const kind=b.kind as StudioKind,targetId=resourceId(b.targetId),operationId=resourceId(b.clientRequestId),targetRevision=text(b.expectedTargetUpdatedAt,'连接版本',100),reservation=reservationInput(b.reservation),raw=record(b.input);
    const hash=requestHash({kind,targetId,targetRevision,reservation,input:raw});
    return this.store.transaction(()=>{
      const duplicate=this.store.db.prepare('SELECT request_hash,body_json FROM studio_operations WHERE project_id=? AND operation_id=?').get(projectId,operationId);
      if(duplicate){invariant(duplicate.request_hash===hash,'IDEMPOTENCY_CONFLICT','同一操作标识不能用于不同输入',409);return JSON.parse(String(duplicate.body_json));}
      const project=this.store.getProject(projectId),source:StudioOperation['source']={},frozen:StoredStudioOperation['frozen']={};
      let provider:ProviderProfile|undefined,runtime:LocalRuntimeProfile|undefined,credentialRef:string|null=null,input:StudioInput;
      if(kind==='runtime_draft'){
        invariant(Object.keys(raw).every(k=>['expectedBoardRevision','expectedProjectRevision'].includes(k)),'INVALID_INPUT','运行时只接收已冻结的项目与分镜快照');
        runtime=this.runtimes.get(targetId); invariant(runtime.enabled,'RUNTIME_DISABLED','请在设置中显式启用可信本机运行时',409);
        invariant(runtime.updatedAt===targetRevision,'TARGET_CHANGED','运行时配置已改变，请重新审阅',409);
        const board=this.board.snapshot(projectId),boardRevision=integer(raw.expectedBoardRevision,'分镜版本',0,Number.MAX_SAFE_INTEGER),projectRevision=integer(raw.expectedProjectRevision,'项目版本',1,Number.MAX_SAFE_INTEGER);
        invariant(boardRevision===board.revision&&projectRevision===project.revision,'REVISION_CONFLICT','简报或分镜已改变，请重新审阅',409);
        invariant(project.brief.trim(),'BRIEF_REQUIRED','请先填写创作简报');
        frozen.brief=project.brief;frozen.shots=board.shots.filter(s=>!s.archived); source.boardRevision=boardRevision;source.projectRevision=projectRevision;
        invariant(Buffer.byteLength(JSON.stringify(frozen))<=256*1024,'CONTEXT_TOO_LARGE','运行时上下文超过256KiB，请减少描述');
        input={expectedBoardRevision:boardRevision,expectedProjectRevision:projectRevision};
      }else{
        ({profile:provider,credentialRef}=this.providers.getProfile(targetId));
        invariant(provider.updatedAt===targetRevision,'TARGET_CHANGED','模型连接已改变，请重新审阅',409);
        const key=this.providers.vault.get(credentialRef); invariant(key.length>0||['localhost','127.0.0.1'].includes(new URL(provider.baseUrl).hostname),'CREDENTIAL_REQUIRED','请先配置远端模型密钥');
        if(kind==='tts') input=validateSpeechInput(provider,raw);
        else{
          invariant(Object.keys(raw).every(k=>k==='candidateId'),'INVALID_INPUT','抽样审核仅接受当前项目的候选标识');
          const candidate=this.board.getCandidate(resourceId(raw.candidateId)),artifact=this.store.getArtifact(candidate.artifactId),shot=this.board.getShot(candidate.shotId);
          invariant(candidate.projectId===projectId&&artifact.projectId===projectId&&artifact.kind!=='audio','INVALID_CANDIDATE','审核候选必须属于当前项目');
          invariant(provider.kind==='chat-completions'&&provider.capabilities.frameReview&&(provider.capabilities.frameReview.maxImages>= (artifact.kind==='video'?3:1)),'PROVIDER_CAPABILITY','连接需要声明支持本次抽样图片数及严格结构化审核');
          const history=shot.visualRevision===candidate.visualRevision?shot:JSON.parse(String(this.store.db.prepare('SELECT body_json FROM shot_revisions WHERE shot_id=? AND visual_revision=? ORDER BY revision DESC LIMIT 1').get(shot.id,candidate.visualRevision)?.body_json??'null')) as Shot|null;
          invariant(history,'REVISION_NOT_FOUND','候选对应的原视觉版本不存在',409);
          Object.assign(source,{artifactId:artifact.id,sha256:artifact.sha256,shotId:shot.id,visualRevision:candidate.visualRevision});
          frozen.artifact=artifact;frozen.expected={purpose:history.purpose,description:history.description,action:history.action};input={candidateId:candidate.id};
        }
      }
      invariant(this.providers.exposure(projectId,reservation.currency)+reservation.amount<=reservation.projectLimit+0.0000001,'BUDGET_EXCEEDED','该币种的已确认费用与未核对预留超过项目额度',409);
      const target=provider??runtime!,id=randomUUID(),now=new Date().toISOString(),job=this.store.createJob({projectId,type:'studio',payload:{operationId:id},dedupeKey:`studio:${projectId}:${operationId}`});
      const o:StoredStudioOperation={id,projectId,kind,status:'queued',jobId:job.id,targetId,targetLabel:target.label,targetModel:target.model,input,source,currency:reservation.currency,reservedAmount:reservation.amount,actualAmount:null,artifactId:null,draftId:null,review:null,error:null,createdAt:now,updatedAt:now,operationId,reservation,outputArtifactId:randomUUID(),provider,runtime,credentialRef,frozen};
      this.store.db.prepare('INSERT INTO studio_operations(id,project_id,operation_id,request_hash,status,body_json) VALUES(?,?,?,?,?,?)').run(id,projectId,operationId,hash,o.status,JSON.stringify(o));
      this.store.appendEvent(projectId,'studio.created',{operationId:id,kind,reservedAmount:reservation.amount,currency:reservation.currency});return o;
    });
  }
  settle(id:string,value:unknown):StudioOperation{
    const b=record(value),actual=finiteNumber(b.actualAmount,'实际费用',0,100000000),note=text(b.note,'核对说明',4000);
    return this.store.transaction(()=>{const o=this.get(id);invariant(!['queued','submitting','received'].includes(o.status),'CALL_IN_PROGRESS','任务仍在执行，请等待后再核对',409);invariant(b.currency===o.currency,'INVALID_CURRENCY','核对币种必须与原预留一致');o.actualAmount=actual;o.settlementNote=note;this.save(o);this.store.appendEvent(o.projectId,'cost.settled',{operationId:id,actualAmount:actual,currency:o.currency,note});return publicStudio(o);});
  }
}
