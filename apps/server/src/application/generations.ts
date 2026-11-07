import { invariant } from '../../../../packages/contracts/src/errors.ts';
import { record, resourceId, text } from '../../../../packages/domain/src/validation.ts';
import { publicGeneration } from '../generation-repository.ts';
import type { ApplicationContext } from './context.ts';

export async function validateGeneration({ generations }: Pick<ApplicationContext, 'generations'>, id: string, value: unknown) {
  const body = record(value);
  return (await generations.validation(resourceId(id), resourceId(body.providerId), body.plan)).result;
}

export async function requestGeneration({ generations, generationRunner }: Pick<ApplicationContext, 'generations' | 'generationRunner'>, id: string, value: unknown) {
  const generation = await generations.create(resourceId(id), value);
  generationRunner.tick();
  return publicGeneration(generations.get(generation.id));
}

export async function reconcileGeneration({ generationRunner }: Pick<ApplicationContext, 'generationRunner'>, id: string, value: unknown) {
  const body = record(value);
  return publicGeneration(await generationRunner.reconcile(resourceId(id), resourceId(body.remoteTaskId), text(body.note, '远端任务核对说明', 2000)));
}

export function pauseGeneration({ generationRunner }: Pick<ApplicationContext, 'generationRunner'>, id: string, value: unknown) {
  const body = record(value);
  invariant(typeof body.paused === 'boolean', 'INVALID_INPUT', '需要明确是否暂停查询');
  return publicGeneration(generationRunner.pause(resourceId(id), body.paused));
}
