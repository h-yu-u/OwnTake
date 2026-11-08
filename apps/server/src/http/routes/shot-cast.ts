import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { ApplicationContext } from '../../application/context.ts';
import { IdParams } from '../schemas/common.ts';
import { ShotCastInput } from '../schemas/shot-cast.ts';
export function registerShotCastRoutes(fastify:FastifyInstance,{shotCast}:Pick<ApplicationContext,'shotCast'>):void {
  const app=fastify.withTypeProvider<TypeBoxTypeProvider>();
  app.get('/shots/:id/characters',{schema:{params:IdParams}},async request=>shotCast.list(request.params.id));
  app.put('/shots/:id/characters',{schema:{params:IdParams,body:ShotCastInput}},async request=>
    shotCast.bind(request.params.id,request.body.roleIds,request.body.expectedShotRevision));
}
