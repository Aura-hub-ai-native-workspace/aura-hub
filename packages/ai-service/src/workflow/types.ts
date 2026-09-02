/**
 * Workflow types — AI-native engineering automations.
 * ==================================================================
 * A workflow is a directed graph of production nodes executed by the
 * environment against the currently open REAL project, orchestrating the
 * frozen engines (Coding KE, FullStack KE, Memory, Intent, Enhancer,
 * Groq) through their public seams. Nothing here duplicates pipeline
 * logic — nodes call the same engines the AI workspace uses.
 */

export type NodeCategory = 'source' | 'intelligence' | 'generate' | 'logic' | 'action' | 'io';

export type WfNodeType =
  // source — real project data
  | 'current-project'
  | 'selected-files'
  | 'changed-files'
  | 'current-conversation'
  | 'project-memory'
  | 'engineering-memory'
  // intelligence — frozen engines
  | 'coding-engine'
  | 'fullstack-engine'
  | 'research-engine' // disabled until the Research Engine exists
  | 'intent-classifier'
  | 'prompt-enhancer'
  /**
   * Bounded agent, implemented in `workflow/agent/` and dispatched by the
   * engine like any other node.
   *
   * It is the only node whose behaviour is not knowable from its config:
   * every other node is a function, and this one is a contract. What
   * bounds it is stated rather than hoped for — clamped iterations, wall
   * clock and token budget; a tool set narrowed to the workflow's own
   * authority envelope; every tool call a Capability Fabric invocation
   * with policy, approval, verification and audit unchanged; and a
   * nine-beat ledger persisted on the run so what it did can be read
   * afterwards.
   *
   * Three ports, because an agent legitimately ends three ways:
   * `done`, `needs-human` (policy refused — a person must change
   * something) and `failed` (a bound was hit, or something broke).
   */
  | 'agent'
  // generate — Groq through the frozen provider seam
  | 'prompt'
  | 'groq'
  | 'generate-markdown'
  | 'generate-code'
  | 'generate-json'
  // logic
  | 'condition'
  | 'loop'
  | 'delay'
  | 'variables'
  | 'user-input'
  // action — real effects
  | 'save-memory'
  | 'create-note'
  | 'export-file'
  | 'shell-command'
  | 'git-status'
  | 'git-diff'
  | 'git-commit'
  | 'git-branch'
  | 'http-request'
  | 'slack-notify'
  // io
  | 'output';

export interface WfNode {
  id: string;
  type: WfNodeType;
  x: number;
  y: number;
  /** Per-node settings, edited in the inspector. Shape per NodeSpec.fields. */
  config: Record<string, unknown>;
}

export interface WfEdge {
  id: string;
  from: string;
  /** Output port on the source node ('out' | 'true' | 'false' | 'each' | 'done'). */
  fromPort: string;
  to: string;
}

export interface Workflow {
  id: string;
  name: string;
  description: string;
  category: string;
  favorite: boolean;
  createdAt: string;
  updatedAt: string;
  nodes: WfNode[];
  edges: WfEdge[];
  /** Lazily generated on first request (see WorkflowStore.ensureWebhookToken) — lets an external system (e.g. GitHub's own webhook config) start a run without AURA needing an API client for that system. Never included in list responses. */
  webhookToken?: string;
}

export interface WorkflowSummary {
  id: string;
  name: string;
  description: string;
  category: string;
  favorite: boolean;
  createdAt: string;
  updatedAt: string;
  nodeCount: number;
}

/* ── execution ─────────────────────────────────────────────────────── */

/**
 * Per-node status on the LIVE EVENT STREAM.
 *
 * Extended additively — `queued`/`running`/`waiting`/`completed`/`failed`/
 * `skipped` keep their exact meanings so existing consumers are untouched.
 * The four new members carry information that used to be flattened into
 * `failed`, and flattening them was a real loss: a node the policy engine
 * refused, a node a human stopped, and a node that ran out of time need
 * three different responses from an operator.
 *
 * `run/types.ts` `NodeState` is the authoritative, durable vocabulary.
 * This one is its projection for a connected UI.
 */
export type NodeRunState =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'awaiting-approval'
  | 'denied'
  | 'cancelled'
  | 'timed-out';

/** The value flowing along an edge. */
export interface NodeIO {
  text: string;
  data?: unknown;
  files?: string[];
  /**
   * Whose words these are — see `provenance.ts` and
   * `docs/AGENT_CONTEXT_PROVENANCE.md`.
   *
   * Optional so every existing producer stays valid; the engine computes
   * it for every delivery, so a value flowing through a real run always
   * has one. Read only by the agent runner (to decide how to PRESENT a
   * value) and by the run record (so a trace can show it). No policy
   * decision reads it.
   */
  provenance?: import('./provenance').Provenance;
}

export type RunEvent =
  | { type: 'start'; workflowId: string; at: string; runId?: string; versionId?: string }
  | { type: 'node'; nodeId: string; status: NodeRunState; ms?: number; summary?: string; error?: string }
  | { type: 'log'; nodeId: string | null; level: 'info' | 'warn' | 'error'; text: string; at: string }
  | { type: 'output'; nodeId: string; title: string; text: string }
  /**
   * One agent beat, live, as it happens.
   *
   * The payload IS the `AgentBeat` that lands in the persisted `AgentTrace`
   * — the same object, the same `seq`, the same redaction, the same
   * `untrusted` flag. There is deliberately no second trace format: a
   * client reconciles the live stream against the final trace by
   * `(runId, nodeId, beat.seq)`, and that only works because the two are
   * the same thing.
   *
   * **The persisted trace remains authoritative.** These events are a
   * courtesy for an operator watching a long agent; they can be missed
   * entirely (nobody connected), duplicated (a reconnect replays), or
   * arrive after the run record is written. A client must treat the trace
   * on the run record as truth and the stream as an early view of it.
   *
   * An `execution` beat carries `evidence.invocationId`, which resolves in
   * the durable audit trail. That — not the arrival of an event — is what
   * proves something actually ran.
   */
  | { type: 'agent'; nodeId: string; runId?: string; beat: import('./agent/types').AgentBeat }
  /**
   * `status` stays two-valued because every existing consumer switches on
   * exactly those two. `runState` carries the honest, unflattened answer
   * alongside it — a cancelled run and a timed-out run both report
   * `status: 'failed'` for compatibility while saying what they really
   * were. New consumers should read `runState`.
   */
  | { type: 'done'; status: 'completed' | 'failed'; ms: number; error?: string; runState?: string; runId?: string };

/** The run summary returned to the caller (kept from the legacy engine so
 *  the bridge's SSE contract is unchanged). */
export interface RunResult {
  status: 'completed' | 'failed';
  ms: number;
  outputs: { nodeId: string; title: string; text: string }[];
  nodes: Record<string, { status: NodeRunState; ms: number }>;
  error?: string;
}
export interface FieldSpec {
  key: string;
  label: string;
  kind: 'text' | 'textarea' | 'number' | 'select' | 'boolean';
  options?: string[];
  placeholder?: string;
  default?: unknown;
  help?: string;
}

/** UI-facing node spec (the runtime `run` stays server-side). */
export interface NodeSpecInfo {
  type: WfNodeType;
  label: string;
  category: NodeCategory;
  description: string;
  /** Input port count: 0 (entry), 1, or 'many' (merges upstream text). */
  inputs: 0 | 1 | 'many';
  /** Named output ports; [] for terminal nodes. */
  outputs: string[];
  disabled?: boolean;
  fields: FieldSpec[];
}

export const genId = (p = 'wf') => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
