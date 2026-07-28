/**
 * @aura/runtime — the provider-neutral runtime contract.
 * ==================================================================
 * A Runtime is a pure inference adapter: it turns messages into tokens.
 * Every model provider (the built-in AURA Runtime and any bring-your-own
 * key provider) implements this one interface. It carries no repository,
 * project, memory or conversation logic — those belong to AURA.
 */
export type {
  Runtime,
  RuntimeConfig,
  RuntimeMessage,
  RuntimeToolSpec,
  GenerateRequest,
  GenerateResponse,
  StreamChunk,
  ModelInfo,
  HealthStatus,
} from './types';
