import { createHash } from 'node:crypto';
import { invariant } from '../../../../packages/contracts/src/errors.ts';
import { resourceId } from '../../../../packages/domain/src/validation.ts';
import { inspectLocalRuntime } from '../../../../packages/runtimes/src/local.ts';
import { publicStudio } from '../studio-repository.ts';
import type { ApplicationContext } from './context.ts';

export function requestStudioOperation({ studio, studioRunner }: Pick<ApplicationContext, 'studio' | 'studioRunner'>, id: string, value: unknown) {
  const operation = studio.create(resourceId(id), value);
  studioRunner.tick();
  return publicStudio(studio.get(operation.id));
}

export async function inspectRuntime({ runtimes }: Pick<ApplicationContext, 'runtimes'>, id: string) {
  return inspectLocalRuntime(runtimes.get(resourceId(id)));
}

/** Read only persisted evidence whose bytes still match the recorded digest. */
export function readStudioFrame({ studio, store }: Pick<ApplicationContext, 'studio' | 'store'>, operationId: string, frameId: string): Buffer {
  const id = resourceId(operationId);
  studio.get(id);
  const row = store.db.prepare('SELECT data,metadata_json FROM studio_frames WHERE operation_id=? AND frame_id=?').get(id, resourceId(frameId));
  invariant(row, 'FRAME_NOT_FOUND', '该任务没有此抽样帧', 404);
  const bytes = Buffer.from(row.data as Uint8Array), metadata = JSON.parse(String(row.metadata_json));
  invariant(createHash('sha256').update(bytes).digest('hex') === metadata.sha256, 'FRAME_CHANGED', '抽样证据摘要不一致', 409);
  return bytes;
}
