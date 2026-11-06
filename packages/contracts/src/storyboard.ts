export type ShotMode = 'import' | 'generate_image' | 'generate_video';

export interface ShotFields {
  title: string;
  purpose: string;
  description: string;
  action: string;
  durationMs: number;
  caption: string;
  mode: ShotMode;
  referenceArtifactIds: string[];
}

export interface Shot extends ShotFields {
  id: string;
  projectId: string;
  order: number;
  revision: number;
  visualRevision: number;
  captionRevision: number;
  editRevision: number;
  selectedArtifactId: string | null;
  selectedVisualRevision: number | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Candidate {
  id: string;
  projectId: string;
  shotId: string;
  visualRevision: number;
  artifactId: string;
  planId: string | null;
  createdAt: string;
}

export interface DraftOperation {
  id: string;
  kind: 'add' | 'update' | 'delete';
  shotId?: string;
  fields?: ShotFields;
}

export interface StoryboardDraft {
  id: string;
  projectId: string;
  baseRevision: number;
  status: 'pending' | 'applied';
  operations: DraftOperation[];
  acceptedOperationIds: string[];
  source: 'manual' | 'model';
  createdAt: string;
}

/** Shots include archived records; active shots are ordered by their zero-based order. */
export interface BoardSnapshot {
  projectId: string;
  revision: number;
  shots: Shot[];
  candidates: Candidate[];
  drafts: StoryboardDraft[];
}
