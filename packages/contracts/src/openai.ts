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
