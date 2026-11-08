import type { FastifyInstance } from 'fastify';
import { AppError } from '../../../../../packages/contracts/src/errors.ts';
import { MEDIA_UPLOAD } from '../../config/media.ts';
import type { AssetUpload } from '../../application/assets.ts';

type RunUpload = <T>(upload: AssetUpload, operation: (input: AssetUpload) => Promise<T>) => Promise<T>;

/** Register only inside the media routes scope; never buffer a binary upload. */
export function registerUploads(app: FastifyInstance, maxBytes: number): RunUpload {
  const active = new Map<AbortController, Promise<unknown>>();
  let closing = false;
  app.addHook('preClose', async () => {
    closing = true;
    for (const controller of active.keys()) controller.abort(new AppError('SERVER_STOPPING', '服务正在停止，媒体上传已取消', 503));
  });
  // Child onClose hooks finish before the parent disposes the Store.
  app.addHook('onClose', async () => { await Promise.allSettled(active.values()); });
  app.removeAllContentTypeParsers();
  app.addContentTypeParser(MEDIA_UPLOAD.contentType, (request, stream, done) => {
    const value = request.headers['content-length'];
    const declaredLength = value === undefined ? undefined : Number(value);
    if (declaredLength !== undefined && (!Number.isSafeInteger(declaredLength) || declaredLength < 0)) {
      done(new AppError('INVALID_CONTENT_LENGTH', '媒体文件长度不合法'));
    } else if (declaredLength !== undefined && declaredLength > maxBytes) {
      done(new AppError('BODY_TOO_LARGE', '媒体文件过大', 413));
    } else {
      done(null, { stream, declaredLength } satisfies AssetUpload);
    }
  });
  return async (upload, operation) => {
    if (closing) throw new AppError('SERVER_STOPPING', '服务正在停止，媒体上传已取消', 503);
    const controller = new AbortController();
    // Closing the source wakes a pending read even when the client never sends EOF.
    const abort = () => { upload.stream.destroy(); };
    controller.signal.addEventListener('abort', abort, { once: true });
    const pending = Promise.resolve().then(() => operation({ ...upload, signal: controller.signal }));
    active.set(controller, pending);
    try { return await pending; }
    finally {
      active.delete(controller);
      controller.signal.removeEventListener('abort', abort);
    }
  };
}
