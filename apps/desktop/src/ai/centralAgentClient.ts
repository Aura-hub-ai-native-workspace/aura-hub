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

const ENV = import.meta.env as unknown as Record<string, string | undefined>;
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
const BASE =
  ENV.VITE_AGENT_URL?.replace(/\/$/, '') ??
  (import.meta.env.DEV ? '/agent-api' : 'http://127.0.0.1:4320');

async function jget<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
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
  const res = await fetch(`${BASE}${path}`, {
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
  | 'awaiting-approval'
  | 'cancelled'
  | 'denied'
  | 'timeout'
  /** The agent asked a clarifying question; nothing has run. */
  | 'needs-clarification'
  | 'unsupported';

export type AgentSessionState =
  | 'planning'
  | 'awaiting-approval'
  | 'executing'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface AgentEvidenceBundle {
  sessionId: string;
  planId: string;
  auditRecordIds: string[];
  approvalIds: string[];
  summary: string;
  createdAt: string;
  /** Request legs that contributed (absent on older backends). */
  requestIds?: string[];
  /** Model behind model-backed synthesis; absent means heuristic. */
  modelProvider?: string | null;
  modelName?: string | null;
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
  estimatedApprovals: number;
}

export interface ApprovalDecision {
  id: string;
  state: 'pending' | 'granted' | 'denied' | 'expired';
  decidedAt?: string | null;
  decidedBy?: string | null;
  summary?: string;
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

/** A client-proposed session id (`agt-` + 12 hex). The server accepts it
 *  only when well-shaped and untaken — otherwise it issues its own. */
export function newClientSessionId(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return `agt-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/* ── the client ────────────────────────────────────────────────────── */

export const centralAgentClient = {
  /** Liveness probe for the honest "Central Agent unavailable" states. */
  health: () => jget<{ ok: boolean; service: string }>('/health'),

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
    opts: { projectId?: string; projectPath?: string; editorContext?: EditorContext; sessionId?: string; signal?: AbortSignal } = {},
  ) =>
    jpost<SubmitResponse>('/agent/sessions', {
      message,
      projectId: opts.projectId,
      projectPath: opts.projectPath,
      editorContext: opts.editorContext,
      sessionId: opts.sessionId,
    }, opts.signal),

  /** Continue a conversation — answer a clarification or add follow-up. */
  message: (
    sessionId: string,
    message: string,
    opts: { projectPath?: string; projectId?: string; editorContext?: EditorContext; signal?: AbortSignal } = {},
  ) =>
    jpost<{ result: AgentResult; requestId?: string | null }>(`/agent/sessions/${encodeURIComponent(sessionId)}/message`, {
      message,
      projectPath: opts.projectPath,
      projectId: opts.projectId,
      editorContext: opts.editorContext,
    }, opts.signal),

  getSession: (sessionId: string) => jget<AgentSession>(`/agent/sessions/${encodeURIComponent(sessionId)}`),

  /**
   * Pending approvals from the AGENT's own ledger. NOTE: during the
   * migration there are TWO ledgers — this one (:4320) parks agent
   * requests; `aiClient`/useFabric read the workflow service's (:4319).
   * An agent-parked id must be resolved HERE, never through useFabric.
   */
  pendingApprovals: () => jget<{ approvals: Array<{ id: string; state: string; summary: string; items: Array<{ capabilityId: string; title: string; detail: string; risk: string; irreversible: boolean }> }> }>('/fabric/approvals'),

  /**
   * Record THIS human decision through the same single-use ledger the
   * Fabric spends, then resume the session in one call. Replays are
   * refused by the backend with 409 — surfaced here as a thrown Error.
   */
  approve: (sessionId: string, approvalId: string, granted: boolean, reason?: string) =>
    jpost<{ approval: ApprovalDecision; result: AgentResult; requestId?: string | null }>(
      `/agent/sessions/${encodeURIComponent(sessionId)}/approve`,
      { approvalId, granted, reason },
    ),

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

  /** Reasoning-free plan review: steps, capabilities, risks, approvals. */
  planReview: (sessionId: string) => jget<PlanReview>(`/agent/sessions/${encodeURIComponent(sessionId)}/plan`),

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
          const res = await fetch(
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

};
