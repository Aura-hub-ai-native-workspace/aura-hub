export interface RuntimeConfig {
  baseUrl?: string;
  apiKey?: string;
  defaultModel?: string;
  timeoutMs?: number;
}

export interface RuntimeMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  toolCallId?: string;
}

export interface RuntimeToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface GenerateRequest {
  messages: RuntimeMessage[];
  model?: string;
  system?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  stop?: string[];
  /** Penalises tokens already used; raised on the one retry after a looping stream. */
  frequencyPenalty?: number;
  /**
   * The caller's deadline for this one request, in milliseconds. A runtime
   * must apply it to its transport (not only to a wrapper around it) and may
   * clamp it to MAX_CALL_TIMEOUT_MS. Absent: the runtime's own default.
   */
  timeoutMs?: number;
}

export interface GenerateResponse {
  content: string;
  model: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  finishReason: string;
}

export interface StreamChunk {
  delta: string;
  done: boolean;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  finishReason?: string;
  toolCall?: { id: string; name: string; arguments: string };
}

export interface ModelInfo {
  id: string;
  providerID: string;
  name: string;
  family?: string;
}

export type HealthStatusType = 'connected' | 'auth_failed' | 'offline' | 'error';

export interface HealthStatus {
  ok: boolean;
  status: HealthStatusType;
  latencyMs: number;
  error?: string;
}

export interface Runtime {
  generate(request: GenerateRequest): Promise<GenerateResponse>;
  stream(request: GenerateRequest): AsyncIterable<StreamChunk>;
  cancel(): void;
  listModels(): Promise<ModelInfo[]>;
  health(): Promise<HealthStatus>;
}
