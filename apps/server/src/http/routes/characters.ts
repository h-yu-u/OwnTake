import { AppError } from '../../../../../packages/contracts/src/errors.ts';
import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import type { ApplicationContext } from '../../application/context.ts';
import type { ServerConfig } from '../../config.ts';
import type { AssetUpload } from '../../application/assets.ts';
import { registerCharacterVisual } from '../../application/characters.ts';
import { registerUploads } from '../plugins/uploads.ts';
import { IdParams } from '../schemas/common.ts';
import { CharacterInput, CharacterParams, CharacterSearch, CharacterUpdate, LookInput, ProjectRoleInput, VisualParams } from '../schemas/characters.ts';

export function registerCharacterRoutes(fastify:FastifyInstance,context:Pick<ApplicationContext,'store'|'characters'>):void {
  const app=fastify.withTypeProvider<TypeBoxTypeProvider>();
  app.get('/characters',{schema:{querystring:CharacterSearch}},async request=>context.characters.list(request.query.q??''));
  app.post('/characters',{schema:{body:CharacterInput}},async(request,reply)=>reply.code(201).send(context.characters.create(request.body)));
  app.get('/characters/:id',{schema:{params:CharacterParams}},async request=>context.characters.get(request.params.id));
  app.put('/characters/:id',{schema:{params:CharacterParams,body:CharacterUpdate}},async request=>{
    const {expectedRevision,...payload}=request.body;
    return context.characters.update(request.params.id,payload,expectedRevision);
  });
  app.get('/characters/:id/visuals',{schema:{params:CharacterParams}},async request=>context.characters.visuals(request.params.id));
  app.get('/characters/:id/visuals/:version/content',{schema:{params:VisualParams}},async(request,reply)=>{
    const {visual,bytes}=context.characters.visualContent(request.params.id,request.params.version);
    return reply.type(visual.mime).header('Cache-Control','private, max-age=31536000, immutable').send(bytes);
  });
  app.get('/characters/:id/looks',{schema:{params:CharacterParams}},async request=>context.characters.looks(request.params.id));
  app.post('/characters/:id/looks',{schema:{params:CharacterParams,body:LookInput}},async(request,reply)=>{
    return reply.code(201).send(context.characters.addLook(request.params.id,request.body));
  });
  app.get('/projects/:id/characters',{schema:{params:IdParams}},async request=>context.characters.roles(request.params.id));
  app.post('/projects/:id/characters',{schema:{params:IdParams,body:ProjectRoleInput}},async(request,reply)=>{
    return reply.code(201).send(context.characters.bindRole({projectId:request.params.id,...request.body}));
  });
}
interface VisualUpload { Params:{id:string}; Body:AssetUpload }
export async function registerCharacterUploads(app:FastifyInstance,context:Pick<ApplicationContext,'store'|'characters'>,config:ServerConfig):Promise<void> {
  await app.register(async child=>{
    const upload=registerUploads(child,config.maxUploadBytes);
    child.post<VisualUpload>('/characters/:id/visuals',{schema:{params:CharacterParams}},async(request,reply)=>{
      const body=request.body;
      if(!body?.stream)throw new AppError('EMPTY_FILE','人物参考图不能为空');
      return reply.code(201).send(await upload(body,part=>registerCharacterVisual(context,request.params.id,part.stream,part.signal)));
    });
  });
}
