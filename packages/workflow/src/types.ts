/**
 * AURA Workflow — orchestration domain model.
 * ==================================================================
 * AURA Workflow is ORCHESTRATION. It describes WHAT a user wants done
 * (a versioned graph of triggers, AI steps, capability tools, control
 * nodes, mission steps and outputs) and WHAT happened when it ran
 * (a WorkflowRun). It never decides policy, never spawns a process and
 * never touches a provider — those belong to the existing authorities,
 * and the runtime phases route every executable node through them:
 *
 *   validate → resolveNode → policy → approval → execute → verify → audit
 *
 * Reused, never duplicated:
 *   - `CapabilityId`      — @aura/connected-environment (node vocabulary)
 *   - `CAPABILITY_MANIFEST` — @aura/capability-fabric (the real tool
 *     catalogue a `capability` node may reference)
 *   - `PolicyEvaluation`, `RiskLevel`, `InvocationActor`,
 *     `PolicyDecision`   — @aura/capability-fabric, carried on node runs
 *     so a run record says what governance decided without owning one
 *
 * Deliberately absent:
 *   - no policy engine, no execution engine, no process primitive,
 *     no environment scanner, no node catalogue, no approval store,
 *     no provider registry — this package references them by id only.
 *
 * Relationship to `packages/ai-service/src/workflow/` (the legacy AI
 * Workflow Builder): that module is a committed, wired implementation
 * with its own node registry and its own execution path. This package is
 * the successor domain model: orchestration-first, capability-referencing,
 * governance-shaped. The legacy module stays untouched until a runtime
 * phase replaces its execution path; then it is migrated onto these
 * types and removed.
 */

import type { CapabilityId } from '@aura/connected-environment';
import type { InvocationActor, PolicyDecision, PolicyEvaluation, RiskLevel } from '@aura/capability-fabric';

/** Bumped only on a breaking shape change; consumers must migrate. */
export const WORKFLOW_SCHEMA_VERSION = 1 as const;
export type WorkflowSchemaVersion = typeof WORKFLOW_SCHEMA_VERSION;

/* ══════════════════════════════════════════════════════════════════
   Definition lifecycle
   ══════════════════════════════════════════════════════════════════ */

/**
 * The definition's own lifecycle. `ready` is the runnable contract:
 * a definition may only reach `ready` when it validates cleanly.
 * Run statuses live on WorkflowRun, not here — never conflate the two.
 */
export type WorkflowStatus = 'draft' | 'ready';

/* ══════════════════════════════════════════════════════════════════
   Nodes
   ══════════════════════════════════════════════════════════════════ */

/** The six library categories (Product spec §3). */
export type WorkflowNodeCategory = 'trigger' | 'ai' | 'tool' | 'control' | 'mission' | 'output';

/**
 * The orchestration vocabulary. Each entry is a KIND of step with a
 * schema (ports, config fields) in `schemas.ts`. The one deliberately
 * generic type is `capability` (TOOLS): its catalogue is the Fabric
 * manifest, not a hardcoded list here — see `schemas.ts`.
 */
export type WorkflowNodeType =
  /* ── TRIGGERS — what starts a run ─────────────────────────────── */
  | 'manual'                 // the Run button
  | 'schedule'               // cron
  | 'git-event'              // push / commit / branch / merge / tag
  | 'file-change'            // paths under the project
  | 'mission-event'          // created / approved / started / completed / failed
  | 'agent-event'            // delegation started / completed / failed
  | 'environment-event'      // node connected / disconnected / changed
  /* ── AI — intelligence steps through the existing provider seam ── */
  | 'ask-aura'               // free-form AURA answer
  | 'agent'                  // delegate to a coding agent (AGENT_BINARIES)
  | 'analyze'                // structured analysis of the input
  | 'summarize'              // concise text summary
  | 'generate'               // generated text/code/document
  | 'classify'               // { label, confidence }
  | 'decide'                 // { decision, rationale }
  /* ── TOOLS — one node, the Fabric manifest as its catalogue ───── */
  | 'capability'             // any Fabric capability id
  /* ── CONTROL — graph shaping ──────────────────────────────────── */
  | 'condition'              // true / false
  | 'branch'                 // true / false (same, explicit)
  | 'switch'                 // case-N / default
  | 'loop'                   // each / done
  | 'for-each'               // each / done, one item at a time
  | 'parallel'               // branch-N / all
  | 'delay'                  // bounded wait
  | 'retry'                  // out / failed
  | 'timeout'                // out / timed-out
  | 'merge'                  // joins many inputs
  /* ── MISSION — the work track, referenced by id ───────────────── */
  | 'create-mission'         // plan a new MissionRecord
  | 'update-mission'         // amend a mission's state
  | 'run-mission'            // start an approved mission
  | 'wait-mission'           // pause until a mission reaches a state
  | 'mission-approval'       // approve a mission plan (human gate)
  /* ── OUTPUT — visible results ─────────────────────────────────── */
  | 'notification'           // surface a message
  | 'log'                    // write to the run log, pass through
  | 'result'                 // a workflow result (terminal)
  | 'export'                 // write a file inside the project root
  | 'approval'               // human approval gate (approved / rejected);

/* ══════════════════════════════════════════════════════════════════
   Typed data flow (§9 of the spec)
   ══════════════════════════════════════════════════════════════════ */

/** Coarse but honest port types; `any` matches everything. */
export type PortType = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'file' | 'any';

export interface PortSpec {
  id: string;
  label: string;
  type: PortType;
  description?: string;
  /** Port accepts several incoming edges (merge). Default false. */
  multiple?: boolean;
}

/** Config field metadata — drives the inspector UI, not execution. */
export interface ConfigFieldSpec {
  key: string;
  label: string;
  kind: 'text' | 'textarea' | 'number' | 'select' | 'boolean' | 'expression';
  options?: string[];
  placeholder?: string;
  default?: unknown;
  required?: boolean;
  help?: string;
}

/**
 * Static metadata for one node type. The runtime (later phases) maps
 * `capability` nodes onto the Fabric and AI nodes onto the provider
 * seam — this package only declares the shape.
 */
export interface NodeSchema {
  type: WorkflowNodeType;
  category: WorkflowNodeCategory;
  label: string;
  description: string;
  /** Decorative glyph for the library and canvas (non-emoji preferred). */
  icon: string;
  /** Empty = entry node (no incoming edges allowed). */
  inputs: PortSpec[];
  outputs: PortSpec[];
  config: ConfigFieldSpec[];
  /** Static governance hint; the policy engine makes the real decision. */
  defaultRisk?: RiskLevel;
}

/** How one node asks to be governed when it runs. */
export interface NodeGovernance {
  /** Who acts — audit label. Defaults to the workflow's actor. */
  actor?: InvocationActor;
  /** Routing intent: the connected node this step prefers. Only ever narrows. */
  nodeId?: string;
  /** Milliseconds; the executor must abort past this. */
  timeoutMs?: number;
}

export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  /** Optional user override of the schema label. */
  label?: string;
  x: number;
  y: number;
  config: Record<string, unknown>;
  governance?: NodeGovernance;
}

/* ══════════════════════════════════════════════════════════════════
   Triggers — nodes of category 'trigger'
   ══════════════════════════════════════════════════════════════════
   Triggers are ordinary nodes on the canvas (the visual language of the
   product). Each trigger type has a typed config; `enabled` decides
   whether the runtime listens. There is deliberately no separate
   `triggers` array on the definition — one representation only.
 */

export type GitEventName = 'push' | 'commit' | 'branch' | 'merge' | 'tag';
export type MissionEventName = 'created' | 'approved' | 'started' | 'completed' | 'failed';
export type AgentEventName = 'started' | 'completed' | 'failed';
export type EnvironmentEventName = 'connected' | 'disconnected' | 'changed';

export type TriggerNodeConfig = { enabled?: boolean } & (
  | { type: 'manual'; reason?: string }
  | { type: 'schedule'; cron: string; timezone?: string }
  | { type: 'git-event'; events: GitEventName[]; branch?: string }
  | { type: 'file-change'; paths: string[]; match?: string }
  | { type: 'mission-event'; events: MissionEventName[]; missionId?: string }
  | { type: 'agent-event'; events: AgentEventName[]; agentId?: string }
  | { type: 'environment-event'; events: EnvironmentEventName[]; nodeIds: string[] }
);

export type TriggerType = TriggerNodeConfig['type'];

/* ══════════════════════════════════════════════════════════════════
   Edges
   ══════════════════════════════════════════════════════════════════ */

export interface WorkflowEdge {
  id: string;
  from: string;
  /** Must be an output port id on the source node's schema. */
  fromPort: string;
  to: string;
  /** Must be an input port id on the target node's schema. */
  toPort: string;
  label?: string;
}

/* ══════════════════════════════════════════════════════════════════
   Settings
   ══════════════════════════════════════════════════════════════════ */

/** Aligned with `@aura/automation`'s RetryPolicy — same fields, same meaning. */
export interface RetryPolicy {
  /** Total attempts allowed per node; 1 = no retry. */
  maxAttempts: number;
  /** Delay before the first retry, ms. */
  delayMs: number;
  /** Multiplier applied to the delay after every failed attempt. */
  backoffFactor: number;
}

/** Which parts of the shared AURA Context a run may pull in (§7). */
export interface WorkflowContextSettings {
  /** Repository intelligence: project profile, git, architecture. */
  repository: boolean;
  /** Node availability / environment scan. */
  environment: boolean;
  /** The current mission (ids and state). */
  mission: boolean;
  /** Recent activity and audit context. */
  activity: boolean;
}

export interface WorkflowSettings {
  /**
   * Preference only. The runtime carries it into the Fabric policy call
   * exactly as it would for any other actor — policy config is what
   * actually decides, and no workflow preference can lower a floor.
   */
  allowAutonomous?: boolean;
  defaultTimeoutMs?: number;
  retry?: RetryPolicy;
  context?: WorkflowContextSettings;
  /**
   * When true, a second trigger for this workflow while one is already
   * running is rejected instead of starting a concurrent run. Default:
   * false (concurrent runs allowed, each gets its own runId).
   */
  singleFlight?: boolean;
}

/* ══════════════════════════════════════════════════════════════════
   The definition
   ══════════════════════════════════════════════════════════════════ */

export interface WorkflowDefinition {
  schemaVersion: WorkflowSchemaVersion;
  id: string;
  name: string;
  description: string;
  /** Null = runs against whichever project is mounted. */
  projectId: string | null;
  status: WorkflowStatus;
  /** Definition revision; bumped on every save. A run records which it ran. */
  version: number;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  settings: WorkflowSettings;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowDefinitionSummary {
  id: string;
  name: string;
  description: string;
  projectId: string | null;
  status: WorkflowStatus;
  version: number;
  nodeCount: number;
  edgeCount: number;
  triggerCount: number;
  createdAt: string;
  updatedAt: string;
}

/** The writable parts of a definition (id/timestamps/version are derived). */
export type WorkflowDefinitionInput = Partial<Omit<WorkflowDefinition, 'id' | 'createdAt' | 'updatedAt' | 'version'>>;

/* ══════════════════════════════════════════════════════════════════
   Runs (§11 of the spec)
   ══════════════════════════════════════════════════════════════════
   A run is a record of one execution of one definition version. It
   records what each node produced and what governance decided — it does
   not decide anything itself.
 */

export type WorkflowRunStatus = 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';

export type WorkflowNodeRunStatus =
  | 'waiting'
  | 'running'
  | 'success'
  | 'failed'
  | 'skipped'
  | 'approval-required'
  | 'paused';

export interface WorkflowLogEntry {
  at: string;
  level: 'info' | 'warn' | 'error';
  text: string;
}

export interface WorkflowNodeRun {
  nodeId: string;
  status: WorkflowNodeRunStatus;
  startedAt?: string;
  finishedAt?: string;
  ms?: number;
  /** Attempts made, including the first. */
  attempts: number;
  /** The output port this node fired on settle; absent for pause/gate states. */
  firedPort?: string;
  inputs?: unknown;
  outputs?: unknown;
  error?: string;
  logs: WorkflowLogEntry[];
  /** What the Fabric decided for this node's last invocation. */
  policy?: PolicyEvaluation;
  /** Human gate outcome, when this node needed one. */
  approval?: {
    requestId: string;
    state: 'pending' | 'granted' | 'denied' | 'expired';
    decidedAt?: string;
    decidedBy?: string;
  };
  /** Audit record ids written while this node ran. */
  auditIds: string[];
}

export interface WorkflowRun {
  schemaVersion: WorkflowSchemaVersion;
  runId: string;
  workflowId: string;
  /** The definition version this run executed. */
  workflowVersion: number;
  projectId: string | null;
  /** The trigger node id that started this run; null = manual UI run. */
  triggerId: string | null;
  status: WorkflowRunStatus;
  startedAt: string;
  finishedAt?: string;
  currentNodeId?: string;
  nodeRuns: WorkflowNodeRun[];
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  error?: string;
  /** Audit record ids written across the whole run. */
  auditIds: string[];
  createdAt: string;
}

export interface WorkflowRunSummary {
  runId: string;
  workflowId: string;
  workflowVersion: number;
  triggerId: string | null;
  status: WorkflowRunStatus;
  startedAt: string;
  finishedAt?: string;
  ms?: number;
  error?: string;
}

/** §16 — per-workflow history projection, computed from runs. */
export interface WorkflowRunStats {
  runs: number;
  success: number;
  failed: number;
  cancelled: number;
  avgDurationMs: number;
  lastRunAt?: string;
  lastStatus?: WorkflowRunStatus;
}

/* ── ids ──────────────────────────────────────────────────────────── */

export const genId = (p = 'wf'): string => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/* ── re-exports for consumers of this package ─────────────────────── */

export type { CapabilityId, InvocationActor, PolicyDecision, PolicyEvaluation, RiskLevel };