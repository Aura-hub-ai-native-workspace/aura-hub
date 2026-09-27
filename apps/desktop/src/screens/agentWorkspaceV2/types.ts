/**
 * Agent Workspace v2 — domain types.
 * =====================================================================
 * These types describe ONE thing: the observable execution of a request
 * through the AURA Central Agent, rendered as a timeline the user can
 * verify. Every field in a `V2Card` is derived later (in `timelineModel`
 * — a pure function over real `AgentEventFrame`s and the terminal
 * `AgentResult`); the model itself never invents a card, a status, or a
 * piece of evidence.
 *
 * The vocabulary is deliberately distinct from the neon workspace's
 * `StepStatus` because the v2 spec fixes an 11-state set:
 *   PLANNING · QUEUED · ANALYZING · CODING · RESEARCHING · EXECUTING ·
 *   WAITING FOR APPROVAL · VERIFYING · COMPLETED · FAILED · CANCELLED
 */

/** Who a card belongs to. The UI never shows a second user composer;
 *  every actor here is AURA itself, a worker it delegated to, or a
 *  governed action executed inside a worker's runtime. */
export type V2ActorKind = 'aura' | 'worker' | 'tool';

/** The fixed 11-state timeline vocabulary (spec §5). */
export type V2Status =
  | 'planning'
  | 'queued'
  | 'analyzing'
  | 'coding'
  | 'researching'
  | 'executing'
  | 'waiting-for-approval'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** A single timeline card. All fields optional unless they anchor the
 *  card (id, actor, action, status). Everything else is evidence that
 *  must exist in the run's own record to appear. */
export interface V2Card {
  id: string;
  actor: V2ActorKind;
  /** Identity: "AURA Central Agent" or the worker's backend name. */
  name: string;
  /** One line: what this card is about, in the run's own terms. */
  action: string;
  /** The state we have evidence for. Never inferred from timing. */
  status: V2Status;
  /** The backend `at` for the frame that anchored this card, if any. */
  at?: string | null;
  /** Short, human-readable reason (e.g. a failed card shows the
   *  backend's own failure summary here). */
  detail?: string | null;
  /**
   * The agent-to-agent exchange this card represents (spec §6).
   * Both sides must name roles that actually appear in the record:
   *   { from: 'AURA Central Agent', to: '<worker>', text: '...' ,
   *     reply?: { text: '...' , state: V2Status } }
   * Absent when there is no recorded exchange to quote.
   */
  exchange?: {
    from: string;
    to: string;
    text: string;
    reply?: { text: string; state: V2Status };
  } | null;
  /** Tool executions observed for this card (governed actions). */
  tools: Array<{
    key: string;
    tool: string;
    actionType: string;
    target: string;
    decision: string;
    reason: string;
  }>;
  /** Artifacts / file changes the backend attributed to this card. */
  artifacts: string[];
  /** Verification evidence, when the backend recorded any. */
  verification?: {
    state: 'passed' | 'failed' | 'pending';
    detail: string | null;
  } | null;
  /** Extra facts shown when the card is expanded: task id, role, deps,
   *  lifecycle words — all verbatim from the record. */
  facts: string[];
}

/** The whole timeline for one run, in execution order. */
export interface V2Timeline {
  /** Session id, when one exists. */
  sessionId: string | null;
  /** The user's objective, verbatim from plan.created when present. */
  objective: string;
  /** Cards in order. Empty array = nothing was recorded (honest idle). */
  cards: V2Card[];
  /** True only when the terminal result says the run is still moving
   *  (busy) AND at least one card is not settled. */
  inFlight: boolean;
}

/* ── Attachments (left composer) ─────────────────────────────────────── */

/** Lifecycle of one attachment against the EXISTING document-ingestion
 *  system (`POST /documents/ingest`). Not a new storage path. */
export type AttachmentStatus =
  | 'pending'   // in the picker, not yet posted
  | 'ingesting' // upload in flight
  | 'ready'     // backend accepted; `kbPath` is the backend's own path
  | 'failed';   // backend refused or unreachable — message keeps it visible

export interface V2Attachment {
  id: string;
  file: File;
  /** Local object URL for image previews, when the type supports one. */
  previewUrl: string | null;
  /** Is this an image (i.e. can we preview pixels)? */
  isImage: boolean;
  status: AttachmentStatus;
  /** Backend-confirmed knowledge-base path, once ingestion succeeds. */
  kbPath: string | null;
  /** Backend's own note (format unsupported, engine missing, …). */
  error: string | null;
}

/* ── Private Search Gateway (typed interface, honest availability) ───── */

/**
 * The AURA Private Search Gateway is a privacy-controlled intermediary
 * between the Central Agent and any public web research (spec §7).
 *
 * This is its TYPED CONTRACT. In the current phase the backend endpoint
 * does not exist yet (verified against the backend routes — only local
 * knowledge-base search and environment software resolution are
 * implemented, and both default to `allow_external=false`). The contract
 * exists so the UI can bind to it, and its availability probe reports
 * `GATEWAY_NOT_IMPLEMENTED` instead of pretending the redaction and
 * minimal-query guarantees are already enforced server-side.
 *
 * Contract rules the future backend must satisfy to be accepted:
 *   1.  The outgoing public query is minimal and free of private
 *       documents, source code, credentials, and conversation history.
 *   2.  Retrieved web content is treated as untrusted data (never an
 *       instruction stream).
 *   3.  Results carry source URLs and citations back to AURA.
 *   4.  Public-web egress is on a path separate from the private
 *       Tailscale link to the models — this UI never mixes them.
 */
export type GatewayProbe =
  | { state: 'ready'; endpoint: string }
  | { state: 'unavailable'; reason: 'GATEWAY_NOT_IMPLEMENTED' }
  | { state: 'error'; message: string };

export interface PrivateSearchGateway {
  /** Probe the backend for a functioning gateway; NEVER fabricates
   *  'ready'. The renderer cannot see the backend's route table, so
   *  this hits the (not-yet-implemented) route and reports honestly. */
  probe(): Promise<GatewayProbe>;
  /** Execute a minimized public query. In this phase: typed, returns
   *  GATEWAY_NOT_IMPLEMENTED; never performs a fetch. */
  search(query: string): Promise<
    | { ok: true; findings: Array<{ title: string; url: string; snippet: string }> }
    | { ok: false; reason: string }
  >;
}
