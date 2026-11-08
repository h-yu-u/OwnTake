import { resourceId } from '../../../../packages/domain/src/validation.ts';
import { publicCall } from '../provider-repository.ts';
import type { ApplicationContext } from './context.ts';

export function requestReasoning({ providers, models }: Pick<ApplicationContext, 'providers' | 'models'>, id: string, value: unknown) {
  const call = providers.createReasoning(resourceId(id), value);
  models.tick();
  return publicCall(providers.getCall(call.id));
}
