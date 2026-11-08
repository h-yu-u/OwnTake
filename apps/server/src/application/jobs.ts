import { resourceId } from '../../../../packages/domain/src/validation.ts';
import type { ApplicationContext } from './context.ts';

type JobContext = Pick<ApplicationContext, 'store' | 'scheduler' | 'models' | 'generationRunner' | 'studioRunner'>;

export function listProjectJobs({ store }: Pick<ApplicationContext, 'store'>, id: string) {
  const projectId = resourceId(id);
  store.getProject(projectId);
  return store.listJobs(projectId);
}

export function cancelJob(context: JobContext, id: string) {
  const { store, scheduler, models, generationRunner, studioRunner } = context;
  const job = store.getJob(resourceId(id));
  if (job.type === 'generation') {
    generationRunner.cancel(String(job.payload.generationId));
    return store.getJob(job.id);
  }
  if (job.type === 'studio') {
    studioRunner.cancel(String(job.payload.operationId));
    return store.getJob(job.id);
  }
  return job.type === 'reasoning' ? models.cancel(job.id) : scheduler.cancel(job.id);
}
