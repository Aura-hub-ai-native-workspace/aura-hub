import { AGENT_BASE, backendFetch } from '../backend/backendSession';
/**
 * centralAgentClient — the renderer's one client for the AURA Central
 * Agent service.
 * =====================================================================
 *
 * The Central Agent is a SEPARATE Python service from the workflow/AI
 * service that `aiClient` talks to. It owns intent sessions: ask → plan →
 * approval → execution → verification → result. This file is its wire
 * shape, declared here because the renderer compiles separately from the
 * Python backend — the backend remains the authority; these types mirror
 * its Pydantic contracts (`aura/contracts/agent.py`).
 *
 * Rules this client keeps:
 *   • One client per service. No component fetches agent routes itself.
 *   • Every state string below is the BACKEND's vocabulary, verbatim.
 *     Nothing here infers or renames a state — rendering maps it through
 *     `components/states` vocabularies instead.
 *   • Errors are honest: `{ error }` bodies surface as failures, never
 *     as empty successes.
 */

import { FrameDeduper, parseBlock, splitBlocks } from './agentEventStream';

/**
 * Base URL resolution:
 *   • explicit VITE_AGENT_URL always wins;
 *   • under the Vite dev server we use the same-origin proxy ('/agent-api'):
 *     the FINAL Python backend's CORS middleware declares wildcard PORTS as
 *     literal strings ("http://localhost:*"), which Starlette does not glob —
 *     verified 2026-08-26: OPTIONS from http://localhost:1420 → 400
 *     "Disallowed CORS origin". Backend fix required: allow_origin_regex.
 *   • packaged/Tauri builds talk to the loopback service directly, on the
 *     SAME origin the Environment surface uses (`service::PYTHON_PORT`).
 *     There is one Python backend and it serves both.
 */
const BASE = AGENT_BASE;

async function jget<T>(path: string): Promise<T> {
  const res = await backendFetch(`${BASE}${path}`);
  if (!res.ok) {
    let message = `request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch { /* keep the status-line message */ }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

async function jpost<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await backendFetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    signal,
  });
  if (!res.ok) {
    let message = `request failed (${res.status})`;
    try {
      const text = await res.text();
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed.error) message = parsed.error;
    } catch { /* keep the status-line message */ }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

/* ── wire shapes (mirrors of the Python contracts) ─────────────────── */

export type AgentOutcome =
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'cancelled'
  | 'denied'
  | 'timeout'
  /** The agent asked a clarifying question; nothing has run. */
  | 'needs-clarification'
  | 'unsupported';

export type AgentSessionState =
  | 'planning'
  | 'executing'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface AgentEvidenceBundle {
  sessionId: string;
  planId: string;
  auditRecordIds: string[];
  summary: string;
  createdAt: string;
  /** Request legs that contributed (absent on older backends). */
  requestIds?: string[];
  /** Model behind model-backed synthesis; absent means heuristic. */
  modelProvider?: string | null;
  modelName?: string | null;
  /** Paths of artifacts generated during this session (Phase 5 onwards). */
  artifactPaths?: string[];
}

/** One planned task's final state. Mirrors backend TaskStatus. */
export interface AgentTaskStatus {
  taskId: string;
  description: string;
  /** Backend TaskState; "pending" means it never reached a worker. */
  state: string;
  verified: boolean | null;
  /** Worker that ran the task, e.g. "claude-code". Null when none did. */
  worker: string | null;
  dependsOn: string[];
  /** Verification kind the plan declared. Absent on results from older builds. */
  verification?: string | null;
}

/** The backend's terminal report. See docs/AURA_CENTRAL_AGENT_API.md. */
export interface AgentResult {
  status: AgentSessionState;
  outcome: AgentOutcome;
  summary: string;
  performed: string[];
  verified: string[];
  evidence: AgentEvidenceBundle | null;
  failureReason?: string | null;
  /** Engine run leg for parked/resumed work, when one exists. */
  runId?: string | null;
  /** What AURA understood the request to be. Display only. */
  understanding?: string | null;
  /** Mission-level acceptance; null when no criteria were declared. */
  objectiveAccepted?: boolean | null;
  unmetAcceptance?: string[];
  /** Per-task final states in plan order. Display only. */
  tasks?: AgentTaskStatus[];
  /** Chat only: the sources the answer cites (`id` is the [n] in the text). */
  sources?: ChatSource[];
  /** Chat only: what web research did for this answer. */
  research?: ChatResearch | null;
  /** Chat only: next steps the conversation has earned. Offering is not doing. */
  nextActions?: ('create-project' | 'create-plan')[];
  /** Chat only: provider/model that wrote the answer (from routing, not the model). */
  model?: { provider?: string; model?: string; latencyMs?: number } | null;
  /** Chat only: what this turn added to Shared Context. */
  recorded?: { kind: string; title: string }[];
  /** Work only: what was measured about the run (see ExecutionReport). */
  report?: ExecutionReport | null;
}

export interface ChatSource { id: number; title: string; url: string; snippet?: string; retrievedAt?: string }

export interface ChatResearch {
  status: 'ok' | 'empty' | 'unavailable' | 'cancelled' | 'skipped';
  detail: string;
  consulted: number;
  cited: number;
  requested?: number;
  reason?: string;
  kind?: 'not-configured' | 'timeout' | 'refused' | 'failed';
  allSources?: ChatSource[];
}

/** The measured completion report of a Workspace run. */
export interface ExecutionReport {
  outcome: string;
  workCompleted: { taskId: string; sourceId?: string | null; description: string; worker: string | null }[];
  unfinished: { taskId: string; sourceId?: string | null; description: string; state: string; detail: string }[];
  filesChanged: { path: string; op: 'created' | 'modified' | 'deleted'; taskId: string; worker: string | null; verified: boolean }[];
  testsObserved: { taskId?: string; worker?: string; command: string; decision?: string }[];
  toolsInstalled: ToolRecord[];
  toolsReused: ToolRecord[];
  verificationEvidence: { taskId: string; invocations: string[] }[];
  acceptanceStated?: string[];
  errors: { id: string; status: 'open' | 'workaround' | 'resolved'; summary: string; taskId: string | null; path: string }[];
  handoffs: { taskId: string; fromNode: string; toNode: string; reason: string; round: number; verified: boolean }[];
  limitations: string[];
}

export interface ToolRecord {
  nodeId: string; name: string; outcome: string; version?: string; reason?: string; detail?: string;
  exitCode?: number | null; durationMs?: number | null; command?: string | null;
}

export interface ModelStatus {
  laya: {
    configured: boolean; usable: boolean; note: string;
    providers: { id: string; model: string; networkClass: string; enabled: boolean; circuit: string; calls?: number; check?: { state: 'ready' | 'unreachable' | 'model-missing' | 'unchecked' | 'disabled'; detail?: string } }[];
    /** What Settings selected, and whether the Central Agent can call it. */
    settings?: { configured: boolean; providerId?: string; model?: string; callable?: boolean; reason?: string };
  };
  local: { runtime: string; installed: boolean; running: boolean; state: string; configured: boolean; models: { name: string; sizeMB: number; parameters: string; embeddingOnly: boolean }[] };
  recommendation: null | {
    model: string; required: false; note: string; compatible?: boolean; needsConfiguration?: boolean;
    approxDownloadMB?: number; ramGB?: number | null; freeDiskGB?: number | null;
    benefit?: string; limitations?: string; problems?: string[]; command?: string; thenConfigure?: string;
  };
}

export interface AgentMessage {
  role: 'user' | 'agent' | 'system';
  content: string;
  at: string;
}

export interface AgentSession {
  sessionId: string;
  projectId?: string | null;
  state: AgentSessionState;
  createdAt: string;
  updatedAt: string;
  messages: AgentMessage[];
  activePlanId?: string | null;
  lastResult?: AgentResult | null;
  eventCount: number;
  /** Background orchestration: `running` until the run settles. */
  orchestrationState?: 'idle' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | null;
}

export interface PlanReviewStep {
  id: string;
  action: string;
  capability: string | null;
  risk: string;
  reversible: boolean;
  verification: string;
}

/** Human-readable plan review. Contains NO model reasoning by contract. */
export interface PlanReview {
  planId: string;
  steps: PlanReviewStep[];
}

/** One lifecycle event from the live SSE stream. */
export interface AgentEventFrame {
  type: string;
  at: string;
  sessionId: string;
  payload: Record<string, unknown>;
  /** Bus-wide monotonic sequence (SSE `id:`); absent on legacy frames. */
  seq?: number | null;
}

/** What the backend recorded when STOP was pressed. */
export interface CancellationRecord {
  sessionId: string;
  cancelled: boolean;
  requestedAt: string;
  reason: string;
  requestedBy: string;
  /** The task that was in flight, when there was one. */
  taskId: string;
  workerNodeId: string;
  firstRequest?: boolean;
}

/**
 * Per-mode enforcement truth for this host. Deliberately not a boolean:
 * "enabled" and "enforced" are different words, and only the backend
 * knows which one applies. `modes` is keyed by policy mode
 * (`deny` / `allowlist` / `unrestricted`) and carries the backend's own
 * state vocabulary — SUPPORTED_AND_ENFORCED, UNSUPPORTED, and so on —
 * so the UI can name what is actually true rather than paraphrasing it.
 */
export interface NetworkCapability {
  platform: string;
  method: string;
  modes: Record<string, string>;
  detail: string;
  /** Which protocols can pass an allowlist, where one is enforced. */
  protocols?: Record<string, string>;
}

export interface SubmitResponse {
  result: AgentResult;
  sessionId: string | null;
  /** Server-generated leg correlation (see docs/architecture/OBSERVABILITY-CONTRACT.md). */
  requestId?: string | null;
}

/**
 * Ephemeral editor snapshot for code-intelligence entry points (Ctrl+I).
 * Local interaction state the agent cannot observe on its own. The
 * backend bounds, fences (untrusted data, never instructions) and
 * validates every field; projectId/projectPath still resolve through
 * the registry — this carries NO authority.
 */
export interface EditorContext {
  filePath?: string;
  language?: string;
  cursor?: { line: number; column: number };
  selection?: { startLine: number; startColumn: number; endLine: number; endColumn: number };
  selectedCode?: string;
  surrounding?: { before: string; after: string };
  symbol?: string;
  diagnostics?: string[];
  action?: string;
  customInstruction?: string;
}

/* ── Agent Runtime Control Plane types ─────────────────────────────── */

export interface AgentRuntimeConfig {
  baseUrl: string;
  modelId: string;
  authType?: 'keyless' | 'bearer' | 'api_key';
  networkClass?: 'local' | 'private' | 'cloud' | 'unknown';
  apiKeyEnv?: string;
}

export type AgentConfigStatus = 'ok' | 'partial' | 'incompatible' | 'not_installed' | 'error';
export type AgentDriftStatus = 'in_sync' | 'drifted' | 'unknown';

export interface AgentRecord {
  id: string;
  name: string;
  detected: boolean;
  configPath: string | null;
  status: AgentConfigStatus;
  statusNote: string;
  currentConfig: Record<string, unknown>;
  drift: AgentDriftStatus;
  driftFields: string[];
  error: string | null;
}

export interface AgentConfigChange {
  agentId: string;
  status: AgentConfigStatus;
  statusNote: string;
  backupPath: string | null;
  ok: boolean;
  error: string | null;
}

export interface AgentDriftResult {
  agentId: string;
  drift: AgentDriftStatus;
  fields: string[];
}

export interface AgentRuntimeSummary {
  agents: AgentRecord[];
  installedCount: number;
  configuredCount: number;
  driftedCount: number;
}

/** A client-proposed session id (`agt-` + 12 hex). The server accepts it
 *  only when well-shaped and untaken — otherwise it issues its own. */
export function newClientSessionId(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return `agt-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/* ── the client ────────────────────────────────────────────────────── */

/** The read-only routing decision for one message. See /agent/route. */
export interface AskRouteDecision {
  route: 'conversation' | 'clarify' | 'mission';
  reason?: string;
  question?: string;
}

export const centralAgentClient = {
  /** Liveness probe for the honest "Central Agent unavailable" states. */
  health: () => jget<{ ok: boolean; service: string }>('/health'),

  /**
   * Read-only routing decision for one message: conversation, clarify or
   * mission. Creates no session and runs nothing.
   */
  route: (message: string) => jpost<AskRouteDecision>('/agent/route', { message }),

  /**
   * Submit an intent. Creates a session and drives it synchronously to a
   * terminal-or-parked outcome; live progress between those points comes
   * from `events`.
   *
   * Pass `sessionId` (see newClientSessionId) when the caller needs the
   * id BEFORE the run settles — to subscribe to events immediately or to
   * cancel early. Pass `editorContext` for code-intelligence entries.
   */
      submit: (
        message: string,
        opts: {
          projectId?: string;
          projectPath?: string;
          editorContext?: EditorContext;
          sessionId?: string;
          signal?: AbortSignal;
          /**
           * The person's choice for THIS request. Sent explicitly in both
           * directions so the backend never has to infer it, and never
           * inherits it from a previous turn.
           */
          webResearch?: boolean;
        } = {},
      ) =>
        jpost<SubmitResponse>('/agent/sessions', {
          message,
          projectId: opts.projectId,
          projectPath: opts.projectPath,
          editorContext: opts.editorContext,
          sessionId: opts.sessionId,
          webResearch: opts.webResearch === true,
        }, opts.signal),

      /** Continue a conversation — answer a clarification or add follow-up. */
      message: (
        sessionId: string,
        message: string,
        opts: {
          projectPath?: string;
          projectId?: string;
          editorContext?: EditorContext;
          signal?: AbortSignal;
          /** Re-sent per leg: a follow-up carries its own choice. */
          webResearch?: boolean;
        } = {},
      ) =>
        jpost<{ result: AgentResult; requestId?: string | null }>(`/agent/sessions/${encodeURIComponent(sessionId)}/message`, {
          message,
          projectPath: opts.projectPath,
          projectId: opts.projectId,
          editorContext: opts.editorContext,
          webResearch: opts.webResearch === true,
        }, opts.signal),

  getSession: (sessionId: string) => jget<AgentSession>(`/agent/sessions/${encodeURIComponent(sessionId)}`),

  /**
   * Planner → Workspace: run a handed-over plan now, in Workspace. The
   * backend validates the whole plan, refuses a revision already sent (409
   * naming its sessionId) or one Workspace cannot carry out, and otherwise
   * runs it on the same engine as `submit`. Resolves when the run settles;
   * live progress arrives through `events(sessionId)` meanwhile.
   */
  executePlan: async (
    plan: import('./missionClient').WorkspacePlan,
    opts: { sessionId: string; projectId?: string; projectPath: string; signal?: AbortSignal },
  ): Promise<{ result: AgentResult; sessionId: string; requestId?: string | null }> => {
    const res = await backendFetch(`${BASE}/agent/plans/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plan, sessionId: opts.sessionId, projectId: opts.projectId, projectPath: opts.projectPath }),
      signal: opts.signal,
    });
    if (!res.ok) {
      // Keep the refusal's class: a duplicate (this revision already
      // started, under `sessionId`) is not a failure to start.
      const body = await res.json().catch(() => ({})) as { error?: string; code?: string; sessionId?: string };
      throw Object.assign(new Error(body.error || `request failed (${res.status})`), {
        status: res.status, code: body.code, sessionId: body.sessionId,
      });
    }
    return res.json();
  },

  /**
   * Let's Chat: one conversational turn. The backend answers on a
   * chat-mode session that can never plan, invoke a capability, dispatch a
   * worker or write a file — work goes to Workspace (`submit`). Pass the
   * returned `sessionId` back to continue the same conversation.
   */
  chat: (
    message: string,
    opts: { sessionId?: string; projectId?: string; projectPath?: string; surface?: 'general-chat' | 'project-chat'; signal?: AbortSignal } = {},
  ) =>
    jpost<{ result: AgentResult; sessionId: string; requestId?: string | null }>('/agent/chat', {
      message,
      sessionId: opts.sessionId,
      projectId: opts.projectId,
      projectPath: opts.projectPath,
      surface: opts.surface,
    }, opts.signal),

  /** Recent chat conversations: general chats, or one project's. */
  chats: (projectId?: string, limit = 20) =>
    jget<{ chats: { sessionId: string; title: string; updatedAt: string; turns: number; adoptedBy?: string | null }[] }>(
      `/agent/chats?limit=${limit}${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ''}`),

  /** Provider status, local runtime detection and the optional small-model suggestion. */
  modelsStatus: () => jget<ModelStatus>('/agent/models/status'),

  /** Where web research is configured from (never credentials). */
  researchConfig: () => jget<{ configured: boolean; endpoint: string | null; source: 'file' | 'environment' | null }>('/agent/research/config'),

  /** Test a search-gateway address with one bounded query and save it only if it answers like one. */
  saveResearchEndpoint: async (searchEndpoint: string) => {
    const res = await backendFetch(`${BASE}/agent/research/config`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ searchEndpoint }),
    });
    return (await res.json()) as { ok: boolean; saved: boolean; reason: string; results?: number; endpoint?: string };
  },

  /** A bounded Shared Context package (decisions, requirements, research) for a scope. */
  contextPackage: (scope: string, query = '', chars = 12000) =>
    jget<{ text: string; records: number; available: number; budgetChars: number; scope: string; goal: string | null }>(
      `/agent/context/${encodeURIComponent(scope)}?q=${encodeURIComponent(query)}&chars=${chars}`),

  /** Carry a general-chat conversation into a newly created project. */
  adoptConversation: (projectId: string, sessionId: string, idea?: string) =>
    jpost<{ projectId: string; fromSession: string; carried: Record<string, number>; goal: string }>(
      `/agent/projects/${encodeURIComponent(projectId)}/adopt`, { sessionId, idea }),

  resume: (sessionId: string) =>
    jpost<{ result: AgentResult; requestId?: string | null }>(`/agent/sessions/${encodeURIComponent(sessionId)}/resume`),

  /**
   * Ask the backend to stop this run.
   *
   * Resolves when the request is RECORDED, not when the worker is dead —
   * terminating a process takes as long as the process takes, and a UI
   * that waited for it would look hung at the moment the user most wants
   * an answer. The run reaches CANCELLED on its own `run.cancelled`
   * event; nothing here may render that state early.
   */
  cancel: (sessionId: string, reason?: string) =>
    jpost<{ cancelled: boolean; cancellation: CancellationRecord; requestId?: string | null }>(
      `/agent/sessions/${encodeURIComponent(sessionId)}/cancel`,
      { reason },
    ),

  /**
   * Re-attempt a cancelled run. Explicit by design: a run the user
   * stopped never continues on its own, and resuming starts a FRESH
   * attempt rather than reviving the terminated one.
   */
  resumeCancelled: (sessionId: string) =>
    jpost<{ result: AgentResult; requestId?: string | null }>(
      `/agent/sessions/${encodeURIComponent(sessionId)}/resume-cancelled`),

  /** Secret-free model routing observability: which provider/model the
   *  agent reasons with, per-call telemetry, honest unavailability. */
  modelStatus: () => jget<{
    configured: boolean;
    providers: Array<{ id: string; model: string; calls: number; consecutiveFailures: number; lastError: string | null; circuit: string }>;
    lastCall: { provider: string; model: string; latencyMs: number; ok: boolean; error: string | null } | null;
  }>('/agent/model'),

  /** What this host can really enforce for worker network access. */
  networkCapability: () => jget<NetworkCapability>('/governance/network'),

  /* Agent Runtime Control Plane ───────────────────────────────────── */

  /** Discover and return live status for all detected agents. */
  agentRuntimeDiscover: () => jget<AgentRuntimeSummary>('/agent-runtime/discover'),

  /** Cached summary without re-probing the filesystem. */
  agentRuntimeSummary: () => jget<AgentRuntimeSummary>('/agent-runtime/summary'),

  /** Point every detected agent at the supplied runtime. */
  agentRuntimeApplyAll: (runtime: AgentRuntimeConfig) =>
    jpost<{ changes: AgentConfigChange[] }>('/agent-runtime/apply', runtime),

  /** Point one specific agent at the supplied runtime. */
  agentRuntimeApplyOne: (agentId: string, runtime: AgentRuntimeConfig) =>
    jpost<AgentConfigChange>(`/agent-runtime/apply/${encodeURIComponent(agentId)}`, runtime),

  /** Roll one agent back to its most recent backup. */
  agentRuntimeRestore: (agentId: string) =>
    jpost<AgentConfigChange>(`/agent-runtime/restore/${encodeURIComponent(agentId)}`),

  /** Check how far each agent has drifted from the expected runtime. */
  agentRuntimeDrift: (runtime: AgentRuntimeConfig) =>
    jpost<{ drift: AgentDriftResult[] }>('/agent-runtime/drift', runtime),

  /**
   * The EvidenceBundle of the session's last result. The route returns the
   * bundle flat when one exists and `{"evidence": null}` when it does not;
   * both are normalized to `AgentEvidenceBundle | null` here.
   */
  evidence: async (sessionId: string) => {
    const body = await jget<AgentEvidenceBundle | { evidence: AgentEvidenceBundle | null }>(
      `/agent/sessions/${encodeURIComponent(sessionId)}/evidence`,
    );
    if (body && typeof body === 'object' && 'evidence' in body) return body.evidence;
    return body as AgentEvidenceBundle;
  },

  /**
   * Subscribe to the session's live events. Returns a closer. Frames are
   * observability only — durable evidence stays authoritative, so a lost
   * stream never falsifies a result.
   */
  /**
   * Subscribe to the session's live event stream with cursor reconnect.
   *
   * One persistent connection per call: the server replays bounded
   * history after our cursor, then follows live (heartbeats included).
   * Reconnect policy:
   *   • the last seen `id:` sequence is sent as Last-Event-ID, so the
   *     server replays only what we missed — no polling, no full tails;
   *   • frames are deduplicated by sequence (legacy frames without one
   *     fall back to the `type@at` pair), so replay overlap after
   *     reconnect never double-renders — effectively-once delivery;
   *   • `stream.resync` (we lagged past the server buffer) and any
   *     transport error both reconnect from the last seen sequence;
   *   • each reconnect emits an honest `stream.reconnecting` frame;
   *   • malformed frames are skipped, never fatal;
   *   • the durable result always comes from submit/approve response
   *     bodies, so a permanently lost stream can never fabricate or
   *     erase a result.
   */
  events: (
    sessionId: string,
    onEvent: (frame: AgentEventFrame) => void,
  ): (() => void) => {
    const controller = new AbortController();
    const deduper = new FrameDeduper();
    let attempt = 0;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const emitDeduped = (frame: AgentEventFrame, seq: number | null) => {
      const key = `${frame.type}@${frame.at}`;
      if (!deduper.check(seq, key)) return; // replay overlap after reconnect
      onEvent(frame);
    };

    const onFrame = (frame: AgentEventFrame, seq: number | null) => {
      attempt = 0; // a delivered frame proves connectivity — reset backoff
      emitDeduped(frame, seq);
    };

    const connectLoop = async () => {
      while (!stopped && !controller.signal.aborted) {
        try {
          const res = await backendFetch(
            `${BASE}/agent/sessions/${encodeURIComponent(sessionId)}/events`,
            {
              signal: controller.signal,
              headers: deduper.cursor !== null ? { 'Last-Event-ID': String(deduper.cursor) } : {},
            },
          );
          if (!res.ok || !res.body) throw new Error(`stream status ${res.status}`);
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          const handleBlock = (frameText: string) => {
            const { seq, data } = parseBlock(frameText);
            if (data === null || data === '[DONE]') return;
            try {
              const frame = JSON.parse(data) as AgentEventFrame;
              const bodySeq = (frame as { seq?: unknown }).seq;
              const effective = seq ?? (typeof bodySeq === 'number' ? bodySeq : null);
              if (frame.type === 'stream.resync') {
                // Server dropped us from its buffer: reconnect from the
                // last seen sequence rather than skipping history.
                throw new Error('stream lagged behind server buffer');
              }
              onFrame(frame, effective);
            } catch (err) {
              if (err instanceof Error && err.message === 'stream lagged behind server buffer') throw err;
              /* malformed frame skipped, not fatal */
            }
          };
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const { blocks, rest } = splitBlocks(buffer);
            buffer = rest;
            for (const block of blocks) handleBlock(block);
          }
          // Server closed the stream cleanly — treat as disconnect and retry.
        } catch (err) {
          if (stopped || controller.signal.aborted) return;
          const aborted = err instanceof DOMException && err.name === 'AbortError';
          if (aborted) return;
          const msg = err instanceof Error ? err.message : String(err);
          emitDeduped({
            type: 'stream.reconnecting',
            at: new Date().toISOString(),
            sessionId,
            payload: { attempt: attempt + 1, message: msg },
          }, null);
        }
        if (stopped || controller.signal.aborted) return;
        // Capped exponential backoff between attempts.
        const delay = Math.min(250 * 2 ** attempt, 8000);
        attempt += 1;
        await new Promise<void>((resolve) => {
          timer = setTimeout(resolve, delay);
        });
      }
    };

    void connectLoop();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      controller.abort();
    };
  },

  /* ── Documents / Knowledge ──────────────────────────────────────── */

  /** Upload a file for ingestion into the knowledge base. */
  ingestDocument: async (file: File): Promise<{
    ok: boolean; path: string; chunkCount: number; charCount: number;
    status: string; documentStatus: string; engine: string;
    ocrUsed: string | null; pageCount: number; mimeType: string | null;
    note: string | null; warnings: string[]; timingsMs: Record<string, number>;
  }> => {
    const form = new FormData();
    form.append('file', file);
    const res = await backendFetch(`${BASE}/documents/ingest`, { method: 'POST', body: form });
    if (!res.ok) {
      let msg = `request failed (${res.status})`;
      try {
        const b = await res.json() as { error?: string; note?: string };
        if (b.note) msg = b.note; else if (b.error) msg = b.error;
      } catch { /* keep */ }
      throw new Error(msg);
    }
    return res.json();
  },

  /** Search the knowledge base. */
  searchKnowledge: (query: string, topK = 5) =>
    jget<{ results: Array<{ text: string; score: number; source: string | null }> }>(
      `/knowledge/search?q=${encodeURIComponent(query)}&top_k=${topK}`),

  /** List documents in the knowledge base. */
  listDocuments: () =>
    jget<{ documents: Array<{ path: string; chunk_count: number; extraction_status: string; ingested_at: string; engine?: string; documentStatus?: string; ocrUsed?: string | null }> }>(
      '/documents/list'),

  /** Query document-engine health and capabilities. */
  getDocumentEngines: () =>
    jget<{
      ok: boolean;
      health: {
        available: boolean; doclingInstalled: boolean; doclingVersion: string;
        modelsCached: boolean; ocrReady: boolean; ocrEngines: string[];
        offlineReady: boolean; missing: string[]; detail: string;
      };
      capabilities: {
        doclingInstalled: boolean; doclingVersion: string; formats: Record<string, string>;
        ocrEngines: string[]; ocrRequested: string; libreofficeAvailable: boolean;
        tesseractAvailable: boolean; modelsCached: boolean; modelCacheDir: string;
        offlineReady: boolean;
      };
    }>('/documents/engines'),

  /* ── Artifacts ──────────────────────────────────────────────────── */

  /** List artifacts generated during missions. */
  listArtifacts: () =>
    jget<{ artifacts: Array<{ name: string; path: string; size_bytes: number; created_at: string }> }>(
      '/artifacts'),

  /* ── Sovereign Network Monitor ──────────────────────────────────── */

  /** Snapshot of the EgressGateway inference journal. */
  networkJournal: () =>
    jget<{ total: number; blocked: number; entries: Array<{ host: string; decision: string; sovereign_block: boolean; timestamp: string }> }>(
      '/network/journal'),

};
