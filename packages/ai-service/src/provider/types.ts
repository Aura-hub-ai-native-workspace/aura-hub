import type { Runtime } from '@aura/runtime';

export interface ModelCapabilities {
  contextWindow?: number;
  maxOutput?: number;
  vision?: boolean;
  reasoning?: boolean;
  streaming?: boolean;
  toolCalling?: boolean;
  jsonMode?: boolean;
  functionCalling?: boolean;
  embeddings?: boolean;
  inputCostPer1k?: number;
  outputCostPer1k?: number;
}

export interface DiscoveredModel {
  id: string;
  name: string;
  capabilities: ModelCapabilities;
}

export interface ProviderMetadata {
  id: string;
  name: string;
  description: string;
  docsUrl?: string;
  /** The model `createRuntime()` falls back to when none is supplied — the single source both runtime construction and model validation (see provider/modelValidation.ts) read from, instead of a literal only `createRuntime()` could see. */
  defaultModel: string;
}

export interface ProviderHealth {
  ok: boolean;
  latencyMs: number;
  error?: string;
  lastChecked: string;
}

export interface ProviderAdapter {
  readonly metadata: ProviderMetadata;
  detect(apiKey: string): boolean;
  validate(apiKey: string): Promise<{ ok: boolean; error?: string }>;
  discoverModels(apiKey: string): Promise<DiscoveredModel[]>;
  createRuntime(apiKey: string, model?: string): Runtime;
  checkHealth(apiKey: string): Promise<ProviderHealth>;
}

export interface ProviderStore {
  providerId: string;
  encryptedKey: string;
  iv: string;
  tag: string;
  fingerprint: string;
  models: DiscoveredModel[];
  health: ProviderHealth | null;
  createdAt: string;
  lastValidated: string | null;
}

/** The active provider. BYOAK-only — there is no built-in default. */
export interface ActiveRuntime {
  type: 'byoak';
  providerId: string;
  runtime: Runtime;
  model: string;
}

export interface ProviderState {
  id: string;
  name: string;
  fingerprint: string;
  models: DiscoveredModel[];
  health: ProviderHealth | null;
  active: boolean;
}
