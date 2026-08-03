/**
 * Automation Engine — shared shapes.
 * ==================================================================
 * The Automation Engine runs REAL engineering workflows from REAL
 * platform moments. A rule declares one trigger (a real event), a set
 * of deterministic conditions over that event's payload, and an ordered
 * chain of actions. When the trigger fires and every condition passes,
 * the engine creates an execution and runs the chain — with per-action
 * retries, a persisted timeline, run history and explicit statuses
 * (queued / running / paused / retrying / completed / failed / cancelled).
 *
 * The engine itself is a pure state machine over persisted state: every
 * side effect (running a diagnosis, governance audits, knowledge update,
 * memory writes) is injected by the host via the `actions` registry, so
 * this package never touches the real filesystem of a project and never
 * fabricates a metric.
 */

/* ── Triggers: real platform moments ───────────────────────────────── */

export type AutomationTriggerType =
  | 'mission-completed'   // a mission execution reached 'completed'
  | 'mission-accepted'    // a mission task proposal was accepted (written to disk)
  | 'diagnosis-completed' // a diagnosis produced a record
  | 'diagnosis-accepted'  // a diagnosis candidate was accepted (patch written)
  | 'file-changed'        // real changed files detected (git porcelain / reindex)
  | 'readme-changed'      // README/CHANGELOG/docs file changed
  | 'dependency-changed'  // package manifest changed (new/removed/updated deps)
  | 'pr-merged';          // a merge commit landed (git log --merges)

/**
 * A real event pushed into the engine by the host at the real moment it
 * happens. `payload` is the raw, real data of that moment — every
 * condition and every action reads from it. Nothing here is invented.
 */
export interface AutomationEvent {
  type: AutomationTriggerType;
  projectId: string;
  projectPath: string;
  at: string;
  payload: Record<string, unknown>;
}

/* ── Conditions: deterministic predicates over the payload ────────── */

export type ConditionOp =
  | 'equals'
  | 'not-equals'
  | 'exists'
  | 'not-exists'
  | 'contains'          // string contains / array includes
  | 'not-contains'
  | 'in'                // payload field is one of the given values
  | 'matches-regex'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte';

export interface Condition {
  /** Dot-path into the event payload, e.g. `mission.category`. */
  field: string;
  op: ConditionOp;
  value?: unknown;
}

export interface ConditionEvaluation {
  index: number;
  field: string;
  op: ConditionOp;
  passed: boolean;
  note?: string;
}

/* ── Actions: real effects, bound by the host ─────────────────────── */

export type AutomationActionType =
  | 'run-diagnosis'        // Engineering Diagnosis Engine → DiagnosisRecord
  | 'run-governance-audit' // Engineering Audit (daily/weekly/release/architecture)
  | 'run-security-review'  // Security Engine
  | 'run-docs-review'      // Documentation Governance
  | 'update-knowledge'     // FullStack Knowledge Engine incremental update
  | 'save-memory';         // Project Memory write

export interface RuleAction {
  id: string;
  action: AutomationActionType;
  label: string;
  config: Record<string, unknown>;
  /** Keep going with the rest of the chain even if this action fails. */
  continueOnError?: boolean;
}

/* ── Retry policy ─────────────────────────────────────────────────── */

export interface RetryPolicy {
  /** Total attempts allowed per action (1 = no retry). */
  maxAttempts: number;
  /** Delay before the first retry, in ms. */
  delayMs: number;
  /** Multiplier applied to the delay after every failed attempt. */
  backoffFactor: number;
}

/* ── Rules ────────────────────────────────────────────────────────── */

export interface AutomationRule {
  id: string;
  name: string;
  description: string;
  category: string;
  enabled: boolean;
  trigger: {
    type: AutomationTriggerType;
    /** Optional coarse event filter — all key/values must match payload. */
    match?: Record<string, unknown>;
  };
  conditions: Condition[];
  /** Ordered action chain executed when the trigger fires. */
  chain: RuleAction[];
  retry: RetryPolicy;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationRuleSummary {
  id: string;
  name: string;
  description: string;
  category: string;
  enabled: boolean;
  trigger: AutomationTriggerType;
  conditionCount: number;
  actionCount: number;
  createdAt: string;
  updatedAt: string;
}

/* ── Executions ───────────────────────────────────────────────────── */

export type RunStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'retrying'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type RunActionStatus = 'pending' | 'running' | 'retrying' | 'completed' | 'failed' | 'skipped';

export interface ActionRunState {
  actionId: string;
  action: AutomationActionType;
  label: string;
  status: RunActionStatus;
  attempts: number;
  startedAt?: string;
  finishedAt?: string;
  ms?: number;
  error?: string;
  summary?: string;
}

export type TimelineType =
  | 'queued'
  | 'started'
  | 'condition-check'
  | 'action-started'
  | 'action-completed'
  | 'action-failed'
  | 'action-retried'
  | 'action-skipped'
  | 'paused'
  | 'resumed'
  | 'cancelled'
  | 'completed'
  | 'failed'
  | 'log';

export interface RunTimelineEntry {
  id: string;
  at: string;
  type: TimelineType;
  message: string;
  level?: 'info' | 'warn' | 'error';
  actionId?: string;
}

export interface AutomationRun {
  id: string;
  ruleId: string;
  event: AutomationEvent;
  status: RunStatus;
  timeline: RunTimelineEntry[];
  actions: ActionRunState[];
  conditions: ConditionEvaluation[];
  startedAt: string;
  finishedAt?: string;
  ms?: number;
  error?: string;
  /** Id of the next run in the rule's queue (for the same trigger moment). */
  nextRunId?: string;
}

export interface AutomationRunSummary {
  id: string;
  ruleId: string;
  trigger: AutomationTriggerType;
  status: RunStatus;
  actionCount: number;
  startedAt: string;
  finishedAt?: string;
  ms?: number;
  error?: string;
}

/* ── Action host contract ─────────────────────────────────────────── */

export interface ActionCtx {
  projectId: string;
  projectPath: string;
  event: AutomationEvent;
  log: (level: 'info' | 'warn' | 'error', text: string) => void;
  signal?: AbortSignal;
}

export interface ActionResult {
  ok: boolean;
  summary?: string;
  error?: string;
  result?: unknown;
}

export type ActionHandler = (ctx: ActionCtx, config: Record<string, unknown>) => Promise<ActionResult>;

/* ── Events emitted while a rule executes ─────────────────────────── */

export type AutomationRunEvent =
  | { type: 'run'; run: AutomationRun }
  | { type: 'log'; runId: string; level: 'info' | 'warn' | 'error'; text: string; at: string }
  | { type: 'done'; runId: string; status: RunStatus; ms: number };

export const genId = (p = 'auto') => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
