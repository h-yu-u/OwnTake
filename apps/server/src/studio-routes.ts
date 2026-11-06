import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { invariant } from '../../../packages/contracts/src/errors.ts';
import { resourceId } from '../../../packages/domain/src/validation.ts';
import { inspectLocalRuntime } from '../../../packages/runtimes/src/local.ts';
import type { RouteContext } from './routes.ts';
import { publicStudio } from './studio-repository.ts';
import { json, jsonBody } from './http.ts';
export async function studioRoutes(request:IncomingMessage,response:ServerResponse,url:URL,c:RouteContext):Promise<boolean>{
  const path=url.pathname,method=request.method;
  if(path==='/api/runtimes'&&method==='GET'){json(response,c.runtimes.list());return true;}
  if(path==='/api/runtimes'&&method==='POST'){json(response,c.runtimes.save(await jsonBody(request)),201);return true;}
  const runtime=/^\/api\/runtimes\/([^/]+)$/.exec(path);if(runtime&&method==='PUT'){json(response,c.runtimes.save(await jsonBody(request),resourceId(runtime[1])));return true;}
  const inspect=/^\/api\/runtimes\/([^/]+)\/inspect$/.exec(path);if(inspect&&method==='POST'){json(response,await inspectLocalRuntime(c.runtimes.get(resourceId(inspect[1]))));return true;}
  const collection=/^\/api\/projects\/([^/]+)\/studio-operations$/.exec(path);
  if(collection&&method==='GET'){json(response,c.studio.list(resourceId(collection[1])));return true;}
  if(collection&&method==='POST'){const o=c.studio.create(resourceId(collection[1]),await jsonBody(request));c.studioRunner.tick();json(response,publicStudio(c.studio.get(o.id)),202);return true;}
  const action=/^\/api\/studio-operations\/([^/]+)\/(cancel|retry-ingest|settle)$/.exec(path);
  if(action&&method==='POST'){const id=resourceId(action[1]);json(response,action[2]==='settle'?c.studio.settle(id,await jsonBody(request)):publicStudio(action[2]==='cancel'?c.studioRunner.cancel(id):c.studioRunner.retryIngest(id)));return true;}
  const frame=/^\/api\/studio-operations\/([^/]+)\/frames\/([^/]+)$/.exec(path);
  if(frame&&method==='GET'){
    const id=resourceId(frame[1]);c.studio.get(id);const row=c.store.db.prepare('SELECT data,metadata_json FROM studio_frames WHERE operation_id=? AND frame_id=?').get(id,resourceId(frame[2]));
    invariant(row,'FRAME_NOT_FOUND','该任务没有此抽样帧',404);const bytes=Buffer.from(row.data as Uint8Array),metadata=JSON.parse(String(row.metadata_json));invariant(createHash('sha256').update(bytes).digest('hex')===metadata.sha256,'FRAME_CHANGED','抽样证据摘要不一致',409);
    response.writeHead(200,{'Content-Type':'image/png','Content-Length':bytes.length,'Cache-Control':'private, max-age=3600'});response.end(bytes);return true;
  }return false;
}
