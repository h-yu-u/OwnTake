import type { FastifyInstance } from 'fastify';
import { basename, dirname } from 'node:path';
import { realpath } from 'node:fs/promises';
import { Type } from 'typebox';
import { invariant } from '../../../../../packages/contracts/src/errors.ts';
import type { ApplicationContext } from '../../application/context.ts';
import { importAsset, restoreAsset } from '../../application/assets.ts';
import type { AssetUpload } from '../../application/assets.ts';
import { resolveAsset } from '../../assets.ts';
import type { ServerConfig } from '../../config.ts';
import { HTTP_CACHE } from '../../config/http.ts';
import { IdParams } from '../schemas/common.ts';
import { registerUploads } from '../plugins/uploads.ts';

interface AssetParams { Params: { id: string } }
interface UploadRoute extends AssetParams { Body: AssetUpload; Querystring: { name?: string } }

export async function registerMediaRoutes(app: FastifyInstance, context: ApplicationContext, config: ServerConfig): Promise<void> {
  await app.register(async media => {
    const runUpload = registerUploads(media, config.maxUploadBytes);
    media.post<UploadRoute>('/projects/:id/assets', {
      schema: { params: IdParams, querystring: Type.Object({ name: Type.Optional(Type.String()) }) },
    }, async (request, reply) => {
      invariant(request.body?.stream, 'EMPTY_FILE', '不能导入空文件');
      const artifact = await runUpload(request.body, input => importAsset(context.store, {
        ...input, projectId: request.params.id, filename: request.query.name ?? '', maxBytes: config.maxUploadBytes,
      }));
      return reply.code(201).send(artifact);
    });

    media.post<UploadRoute>('/artifacts/:id/restore', { schema: { params: IdParams } }, async request => {
      invariant(request.body?.stream, 'EMPTY_FILE', '不能导入空文件');
      return runUpload(request.body, input => restoreAsset(context.store, { ...input, artifactId: request.params.id, maxBytes: config.maxUploadBytes }));
    });

    media.route<AssetParams>({
      method: ['GET', 'HEAD'], url: '/artifacts/:id/content', schema: { params: IdParams },
      async handler(request, reply) {
        const { artifact, path } = await resolveAsset(context.store, request.params.id);
        reply.header('Cache-Control', HTTP_CACHE.media);
        reply.header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(artifact.name)}`);
        return reply.sendFile(basename(path), dirname(path), {
          cacheControl: false,
          onFile: async (selected, info) => {
            invariant(await realpath(selected) === path, 'FORBIDDEN_PATH', '素材文件不能通过符号链接替换', 403);
            invariant(info.isFile() && info.size === artifact.sizeBytes, 'ASSET_CHANGED', '素材文件大小已改变，请恢复原文件', 409);
          },
        });
      },
    });

    media.get<AssetParams>('/artifacts/:id/thumbnail', { schema: { params: IdParams } }, async (request, reply) => {
      const png = await context.thumbnails.read(request.params.id);
      return reply.type('image/png').header('Cache-Control', HTTP_CACHE.media).send(png);
    });
  });
}
