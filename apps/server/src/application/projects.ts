import { integer, projectInput, record, resourceId } from '../../../../packages/domain/src/validation.ts';
import type { ApplicationContext } from './context.ts';

type ProjectContext = Pick<ApplicationContext, 'store'>;

export function createProject({ store }: ProjectContext, value: unknown) {
  return store.createProject(projectInput(value));
}

export function updateProject({ store }: ProjectContext, id: string, value: unknown) {
  const body = record(value);
  return store.updateProject(resourceId(id), projectInput(body), integer(body.expectedRevision, '项目版本', 1, Number.MAX_SAFE_INTEGER));
}
