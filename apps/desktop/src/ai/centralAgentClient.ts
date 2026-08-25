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

const ENV = import.meta.env as unknown as Record<string, string | undefined>;
/**
 * Base URL resolution:
 *   • explicit VITE_AGENT_URL always wins;
 *   • under the Vite dev server we use the same-origin proxy ('/agent-api')
 *     because the agent API cannot answer CORS preflights yet (Agent 2);
 *   • packaged/Tauri builds talk to the loopback service directly and
 *     REQUIRE that preflight support to land.
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

async function jpost<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
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
  /** Present while the agent is waiting on a clarifying answer. */
  pendingQuestion?: string | null;
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
}

export interface SubmitResponse {
  result: AgentResult;
  sessionId: string | null;
}

/* ── the client ────────────────────────────────────────────────────── */

export const centralAgentClient = {
  /** Liveness probe for the honest "Central Agent unavailable" states. */
  health: () => jget<{ ok: boolean; service: string }>('/health'),

  /**
   * Submit an intent. Creates a session and drives it synchronously to a
   * terminal-or-parked outcome; live progress between those points comes
   * from `events`.
   */
  submit: (message: string, opts: { projectId?: string; projectPath?: string } = {}) =>
    jpost<SubmitResponse>('/agent/sessions', {
      message,
      projectId: opts.projectId,
      projectPath: opts.projectPath,
    }),

  /** Continue a conversation — answer a clarification or add follow-up. */
  message: (sessionId: string, message: string, projectPath?: string) =>
    jpost<{ result: AgentResult }>(`/agent/sessions/${encodeURIComponent(sessionId)}/message`, {
      message,
      projectPath,
    }),

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
    jpost<{ approval: ApprovalDecision; result: AgentResult }>(
      `/agent/sessions/${encodeURIComponent(sessionId)}/approve`,
      { approvalId, granted, reason },
    ),

  resume: (sessionId: string) =>
    jpost<{ result: AgentResult }>(`/agent/sessions/${encodeURIComponent(sessionId)}/resume`),

  cancel: (sessionId: string) =>
    jpost<{ cancelled: boolean }>(`/agent/sessions/${encodeURIComponent(sessionId)}/cancel`),

  /** Reasoning-free plan review: steps, capabilities, risks, approvals. */
  planReview: (sessionId: string) => jget<PlanReview>(`/agent/sessions/${encodeURIComponent(sessionId)}/plan`),

  evidence: (sessionId: string) => jget<AgentEvidenceBundle>(`/agent/sessions/${encodeURIComponent(sessionId)}/evidence`),

  /**
   * Subscribe to the session's live events. Returns a closer. Frames are
   * observability only — durable evidence stays authoritative, so a lost
   * stream never falsifies a result.
   */
  /**
   * Subscribe to the session's live event stream with automatic reconnection.
   *
   * Reconnect policy (all client-side; the backend keeps no cursor):
   *   • exponential backoff 250ms → 8s cap, reset on a successful frame;
   *   • every received frame is deduplicated by its `at` timestamp + type
   *     pair so a replayed tail after reconnect never double-renders;
   *   • each reconnect emits an honest `stream.reconnecting` frame — the UI
   *     must be able to say "live updates paused" rather than silently
   *     stalling;
   *   • the durable result always comes from submit/approve response bodies,
   *     so a permanently lost stream can never fabricate or erase a result.
   */
  events: (
    sessionId: string,
    onEvent: (frame: AgentEventFrame) => void,
  ): (() => void) => {
    const controller = new AbortController();
    const seen = new Set<string>();
    let attempt = 0;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const emitDeduped = (frame: AgentEventFrame) => {
      const key = `${frame.type}@${frame.at}`;
      if (seen.has(key)) return; // dedupe replayed tails after reconnect
      seen.add(key);
      onEvent(frame);
    };

    const onFrame = (frame: AgentEventFrame) => {
      attempt = 0; // a delivered frame proves connectivity — reset backoff
      emitDeduped(frame);
    };

    const connectLoop = async () => {
      while (!stopped && !controller.signal.aborted) {
        try {
          const res = await fetch(
            `${BASE}/agent/sessions/${encodeURIComponent(sessionId)}/events`,
            { signal: controller.signal },
          );
          if (!res.ok || !res.body) throw new Error(`stream status ${res.status}`);
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let idx: number;
            while ((idx = buffer.indexOf('\n\n')) !== -1) {
              const frameText = buffer.slice(0, idx);
              buffer = buffer.slice(idx + 2);
              for (const line of frameText.split('\n')) {
                if (!line.startsWith('data:')) continue;
                try {
                  onFrame(JSON.parse(line.slice(5).trim()) as AgentEventFrame);
                } catch { /* malformed frame skipped, not fatal */ }
              }
            }
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
          });
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
