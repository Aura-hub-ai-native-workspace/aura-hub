/**
 * @aura/intelligence — Core Envelope Types
 * ==================================================================
 * The vocabulary every layer of the intelligence pipeline speaks.
 *
 * These types are the *contract surface* between stages. They are
 * deliberately provider-agnostic: nothing here references Groq, Claude,
 * OpenAI, a local runtime, or any SDK. A concrete provider maps its own
 * request/response shape onto `ProviderRequest` / `ProviderResponse` at
 * the adapter seam (see providers/adapter.ts) — and only there.
 *
 * The data flows one direction, each stage enriching an evolving
 * envelope:
 *
 *   IntelligenceRequest
 *     → Intent            (Intent Classifier)
 *     → EnhancedPrompt    (Prompt Enhancer)
 *     → IntelligenceContext (Context Builder)
 *     → RoutingDecision   (Task Router)
 *     → ProviderRequest   (Specialized Engine)
 *     → ProviderResponse  (Provider Adapter — placeholder)
 *     → IntelligenceResponse (Response Pipeline)
 */

/* ── 0. Input ──────────────────────────────────────────────────────── */

/** Coarse classification of what the user is trying to do. Extend freely. */
export type IntentType =
  | 'chat'
  | 'question'
  | 'command'
  | 'generate'
  | 'edit'
  | 'summarize'
  | 'search'
  | 'transform'
  | 'unknown';

export interface ConversationTurn {
  role: 'user' | 'assistant' | 'system';
  content: string;
  at?: number;
}

export interface Attachment {
  id: string;
  kind: 'file' | 'image' | 'url' | 'selection';
  /** An opaque reference (path, uri, id) — the layer resolves it, not this type. */
  ref: string;
  mime?: string;
}

/** The raw unit of work handed to the kernel. */
export interface IntelligenceRequest {
  id: string;
  /** The user's raw text. */
  input: string;
  userId?: string;
  sessionId?: string;
  /** Optional AURA project this request belongs to (scopes context). */
  projectId?: string;
  history?: ConversationTurn[];
  attachments?: Attachment[];
  metadata?: Record<string, unknown>;
  createdAt: number;
}

/* ── 1. Intent ─────────────────────────────────────────────────────── */

export interface Intent {
  type: IntentType;
  /** 0..1 model/heuristic confidence. */
  confidence: number;
  /** Lightly-extracted entities (e.g. { language: 'ts', target: 'file.ts' }). */
  entities?: Record<string, string>;
  /** Human-readable explanation — invaluable for debugging & tracing. */
  rationale?: string;
  /** Ranked alternatives when the top choice is uncertain. */
  alternatives?: { type: IntentType; confidence: number }[];
}

/* ── 2. Enhanced prompt ────────────────────────────────────────────── */

export interface EnhancedPrompt {
  original: string;
  /** Cleaned / expanded / normalized prompt ready for an engine. */
  enhanced: string;
  /** System-level framing hints an engine may fold into a system message. */
  systemHints: string[];
  /** Structured directives extracted from the prompt (format, tone, limits…). */
  directives?: Record<string, unknown>;
}

/* ── 3. Context ────────────────────────────────────────────────────── */

export type ContextKind = 'memory' | 'document' | 'knowledge' | 'code' | 'history' | 'system';

export interface ContextSource {
  id: string;
  kind: ContextKind;
  title: string;
  snippet: string;
  /** Relevance score if a retriever produced it. */
  score?: number;
  /** Opaque origin reference for citations. */
  ref?: string;
}

export interface IntelligenceContext {
  sources: ContextSource[];
  /** Rough token estimate of the assembled context. */
  tokenEstimate: number;
  /** True when sources were dropped to fit a budget. */
  truncated: boolean;
}

/* ── 4. Routing ────────────────────────────────────────────────────── */

export interface RoutingDecision {
  /** Id of the SpecializedEngine selected to handle this request. */
  engineId: string;
  reason: string;
  /** Ordered fallbacks if the primary engine is unavailable. */
  fallbacks: string[];
}

/* ── 5–6. Provider-neutral request / response ──────────────────────── */

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface Message {
  role: Role;
  content: string;
  /** For tool messages / named participants. */
  name?: string;
  toolCallId?: string;
}

/** Minimal JSON-Schema-ish shape for tool parameters (structure only). */
export type JsonSchema = Record<string, unknown>;

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface GenerationParams {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  stop?: string[];
  stream?: boolean;
  /** Free-form knobs a provider may honor; unknown keys are ignored. */
  extra?: Record<string, unknown>;
}

/**
 * Capabilities an engine may *require* and a provider may *offer*.
 * The provider registry matches the two — this is what lets a future
 * provider be plugged in without any upper layer knowing about it.
 */
export type ProviderCapability =
  | 'streaming'
  | 'tools'
  | 'vision'
  | 'json-mode'
  | 'system-prompt'
  | 'long-context';

/** The neutral request an engine produces for the provider seam. */
export interface ProviderRequest {
  messages: Message[];
  params: GenerationParams;
  tools?: ToolSpec[];
  /** Capabilities the producing engine needs from a provider. */
  requires?: ProviderCapability[];
  metadata?: Record<string, unknown>;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export type FinishReason = 'stop' | 'length' | 'tool_call' | 'filtered' | 'error' | 'placeholder';

export interface ToolCall {
  id: string;
  name: string;
  /** JSON-encoded arguments. */
  arguments: string;
}

/** The neutral response a provider returns across the seam. */
export interface ProviderResponse {
  content: string;
  finishReason: FinishReason;
  usage: TokenUsage;
  toolCalls?: ToolCall[];
  model?: string;
  providerId: string;
  /** The provider's untouched payload, for debugging. Never relied on upstream. */
  raw?: unknown;
}

/** A single streamed increment. */
export interface ProviderStreamChunk {
  delta: string;
  done: boolean;
  usage?: TokenUsage;
  toolCall?: ToolCall;
  finishReason?: FinishReason;
}

/* ── 7. Final response ─────────────────────────────────────────────── */

export interface Citation {
  sourceId: string;
  title: string;
  ref?: string;
}

export interface IntelligenceResponse {
  requestId: string;
  text: string;
  intent: Intent;
  engineId: string;
  providerId: string;
  citations: Citation[];
  usage: TokenUsage;
  finishReason: FinishReason;
  /** Full stage-by-stage trace of how this response was produced. */
  trace: PipelineTrace;
  createdAt: number;
}

/* ── Tracing (shared shape; recorder lives in telemetry/) ──────────── */

export interface StageTiming {
  stage: string;
  startedAt: number;
  durationMs: number;
  ok: boolean;
  note?: string;
}

export interface PipelineTrace {
  requestId: string;
  startedAt: number;
  totalMs: number;
  stages: StageTiming[];
}
