export interface OpenAIModels {
  reasoning: string;
  image: string;
  speech: string;
}

export type OpenAICapability = keyof OpenAIModels;

/** One account configuration; protocol-specific profiles remain execution targets. */
export interface OpenAIConnectionInput {
  label: string;
  models: OpenAIModels;
  key?: string;
}

export interface OpenAIConnectionUpdate extends OpenAIConnectionInput {
  expectedRevision: number;
}

export interface OpenAIConnection {
  id: string;
  label: string;
  models: OpenAIModels;
  profileIds: OpenAIModels;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/** Public responses never include the API key or its private vault reference. */
export interface OpenAIConnectionSummary extends OpenAIConnection {
  hasKey: boolean;
  verification: 'unverified';
}

/** Discovery accepts a temporary key or uses a saved connection; it never saves either. */
export interface OpenAIModelDiscoveryInput {
  connectionId?: string;
  key?: string;
}

/** /models supplies metadata, not a guarantee of endpoint support or successful generation. */
export interface OpenAIListedModel {
  id: string;
  created: number;
  ownedBy: string;
  shutdownDate: string | null;
}

export interface OpenAIModelCatalog {
  models: OpenAIListedModel[];
  fetchedAt: string;
}
