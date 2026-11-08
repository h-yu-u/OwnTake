import type { StoryRepository } from '../../../../packages/storage/src/story-repository.ts';
import type { Store } from '../../../../packages/storage/src/index.ts';
import type { StoryboardStore } from '../../../../packages/storage/src/storyboard.ts';
import type { Scheduler } from '../scheduler.ts';
import type { ProviderRepository } from '../provider-repository.ts';
import type { ModelRunner } from '../model-runner.ts';
import type { GenerationRepository } from '../generation-repository.ts';
import type { GenerationRunner } from '../generation-runner.ts';
import type { ThumbnailService } from '../thumbnails.ts';
import type { RuntimeRepository } from '../runtime-repository.ts';
import type { StudioRepository } from '../studio-repository.ts';
import type { StudioRunner } from '../studio-runner.ts';

/** Resources owned by one local core. Individual use cases take only what they need. */
export interface ApplicationContext {
  stories: StoryRepository;
  store: Store;
  scheduler: Scheduler;
  board: StoryboardStore;
  providers: ProviderRepository;
  models: ModelRunner;
  generations: GenerationRepository;
  generationRunner: GenerationRunner;
  thumbnails: ThumbnailService;
  runtimes: RuntimeRepository;
  studio: StudioRepository;
  studioRunner: StudioRunner;
}
