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
  /**
   * Tool calls this assistant turn made.
   *
   * Required for a second round trip to be coherent: every provider
   * rejects a `tool` result message whose call it never saw the assistant
   * make. `role: 'tool'` and `toolCallId` were already declared for the
   * reply half; this is the half that asks the question.
   */
  toolCalls?: RuntimeToolCall[];
}

/**
 * One tool invocation a model asked for.
 *
 * `arguments` is the raw JSON text the model emitted, NOT a parsed
 * object, and that is deliberate. Providers stream it in fragments, it is
 * frequently malformed, and the parse can fail — a caller must be able to
 * see exactly what was produced in order to report the failure honestly
 * rather than receive an empty object and act on it.
 */
export interface RuntimeToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface RuntimeToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * Whether the model may, must, or must not call a tool this turn.
 *
 *   auto     — the model decides (the default when tools are offered)
 *   none     — text only, even though tools were described
 *   required — the model must call at least one tool
 */
export type RuntimeToolChoice = 'auto' | 'none' | 'required';

export interface GenerateRequest {
  messages: RuntimeMessage[];
  model?: string;
  system?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  stop?: string[];
  /**
   * Tools the model may ask to use this turn.
   *
   * Offering a tool describes it; it authorizes nothing. Whatever comes
   * back is a *request* that is re-validated against the capability
   * manifest and re-evaluated by the policy engine before anything runs
   * — see `@aura/capability-fabric/toolSchema`.
   *
   * Absent or empty means no tool support is negotiated at all, which is
   * exactly the behaviour every existing caller keeps.
   */
  tools?: RuntimeToolSpec[];
  /** Ignored when `tools` is absent or empty. Defaults to `auto`. */
  toolChoice?: RuntimeToolChoice;
}

export interface GenerateResponse {
  content: string;
  model: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  finishReason: string;
  /**
   * Tool calls the model asked for. Absent when it asked for none.
   *
   * Never empty-when-present: an empty array and "no tool calls" are the
   * same fact, and having two encodings of it invites a caller to check
   * only one of them.
   */
  toolCalls?: RuntimeToolCall[];
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
