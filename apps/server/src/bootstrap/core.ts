import { Store } from '../../../../packages/storage/src/index.ts';
import { StoryboardStore } from '../../../../packages/storage/src/storyboard.ts';
import type { ApplicationContext } from '../application/context.ts';
import type { ServerConfig } from '../config.ts';
import { acquireLock } from '../instance-lock.ts';
import { Scheduler } from '../scheduler.ts';
import { ProviderRepository } from '../provider-repository.ts';
import { ModelRunner } from '../model-runner.ts';
import { GenerationRepository } from '../generation-repository.ts';
import { GenerationRunner } from '../generation-runner.ts';
import { ThumbnailService } from '../thumbnails.ts';
import { RuntimeRepository } from '../runtime-repository.ts';
import { StudioRepository } from '../studio-repository.ts';
import { StudioRunner } from '../studio-runner.ts';

export interface CoreRuntime {
  context: ApplicationContext;
  start(): void;
  stop(): Promise<void>;
  dispose(): Promise<void>;
}

/** Build resources without scheduling jobs. HTTP and desktop entry points share this owner. */
export async function createCore(config: ServerConfig): Promise<CoreRuntime> {
  const releaseLock = await acquireLock(config.dataDir);
  let store: Store | undefined;
  try {
    store = new Store({ dataDir: config.dataDir, projectsDir: config.projectsDir });
    const board = new StoryboardStore(store);
    const providers = new ProviderRepository(store, board);
    const generations = new GenerationRepository(store, board, providers);
    const runtimes = new RuntimeRepository(store);
    const studio = new StudioRepository(store, board, providers, runtimes);
    const context: ApplicationContext = {
      store,
      board,
      providers,
      generations,
      runtimes,
      studio,
      scheduler: new Scheduler(store),
      models: new ModelRunner(providers),
      generationRunner: new GenerationRunner(generations),
      thumbnails: new ThumbnailService(store),
      studioRunner: new StudioRunner(studio),
    };
    return ownResources(context, releaseLock);
  } catch (error) {
    try { store?.close(); }
    finally { await releaseLock(); }
    throw error;
  }
}

function ownResources(context: ApplicationContext, releaseLock: () => Promise<void>): CoreRuntime {
  const runners = [context.scheduler, context.models, context.generationRunner, context.studioRunner];
  let started = false;
  let stopping: Promise<void> | undefined;
  let disposing: Promise<void> | undefined;

  function start(): void {
    if (started || stopping) return;
    started = true;
    for (const runner of runners) runner.start();
  }

  function stop(): Promise<void> {
    return stopping ??= (async () => {
      const results = await Promise.allSettled([...runners, context.thumbnails].map(resource => resource.stop()));
      const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (failures.length) throw new AggregateError(failures, 'Unable to stop local core resources');
    })();
  }

  function dispose(): Promise<void> {
    return disposing ??= (async () => {
      try { await stop(); }
      finally {
        try { context.store.close(); }
        finally { await releaseLock(); }
      }
    })();
  }

  return { context, start, stop, dispose };
}
