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
