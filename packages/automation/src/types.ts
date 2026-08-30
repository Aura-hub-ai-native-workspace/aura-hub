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
  | 'pr-merged'           // a merge commit landed (git log --merges)
  /**
   * A wall-clock moment the user asked for, delivered by the scheduler.
   *
   * Modelled as a TRIGGER, not as a new kind of rule, because that is what
   * it is: the scheduler's whole job is to push an `AutomationEvent` at
   * the right minute, and everything downstream — conditions, the action
   * chain, retries, the timeline — is unchanged. A separate "scheduled
   * rule" concept would have been a second execution path wearing a clock.
   */
  | 'schedule';

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
  | 'save-memory'          // Project Memory write
  /**
   * Hand a workflow to the Workflow Engine.
   *
   * This is the bridge that makes trigger → orchestration → governance one
   * system instead of two disconnected ones. It is an ACTION, not a second
   * executor: the handler the host injects calls the existing
   * `WorkflowRunner`, which is the same path the Run button uses. The
   * Automation Engine still knows nothing about graphs, capabilities or
   * policy — it knows how to run an action, and this is one.
   */
  | 'run-workflow';

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
    /**
     * Five-field cron expression. Required when `type === 'schedule'` and
     * ignored otherwise. Validated on save — a rule whose cron does not
     * parse is refused rather than stored as a schedule that never fires.
     */
    cron?: string;
    /**
     * Project this schedule runs against.
     *
     * A time-triggered rule has no event to tell it which project it is
     * about, so it must be told at authoring time. Without this the
     * scheduler would have to guess "whatever is open at 9am", which is
     * exactly the ambient-project bug the workflow trigger path already
     * had to fix.
     */
    projectId?: string;
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

/**
 * A thing an action brought into existence, named rather than described.
 *
 * The first version of this carried `workflowRunId` and `workflowRunState`
 * as loose strings on `ActionRunState`, and it had two defects. It did not
 * carry the WORKFLOW id, so a client holding a run id had to search every
 * workflow's history to find the run — the exact merge-on-the-client
 * problem the run index exists to remove. And it could only ever describe
 * one kind of product, so the next one (a mission, a diagnosis) would have
 * added a second pair of loose fields beside it.
 *
 * A discriminated union fixes both: the `kind` says what to do with the
 * rest, and every reference is complete enough to fetch without a search.
 * Adding a product later is a new member, not a new pair of fields.
 */
export type ProducedRef =
  | {
      kind: 'workflow-run';
      /** Both ids, so `GET /workflows/:workflowId/runs/:runId` resolves directly. */
      workflowId: string;
      runId: string;
      /** The run's own state vocabulary, unflattened. */
      state: string;
    };

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
  /**
   * What this action produced, when it produced something addressable.
   *
   * The causal chain has to be walkable from either end: from a rule, to
   * see what it actually did; and from a workflow run, to see why it ran.
   * Nothing here requires parsing a summary string to discover.
   */
  produced?: ProducedRef;
  /**
   * @deprecated Mirrors `produced` for clients written against the first
   * shape. Kept because the desktop Automation UI is already verified
   * against them and breaking a shipped contract to tidy a field name is
   * not a trade worth making. Written whenever `produced` is written, so
   * the two can never disagree; read `produced` in new code.
   */
  workflowRunId?: string;
  /** @deprecated See `workflowRunId`. */
  workflowRunState?: string;
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
  /**
   * Everything this run produced, flattened from its actions.
   *
   * A rollup, not a second record: it is derived from `actions[].produced`
   * whenever an action reports one, and exists so the run index can filter
   * by workflow without loading and walking every action of every run.
   */
  produced?: ProducedRef[];
}

export interface AutomationRunSummary {
  id: string;
  ruleId: string;
  /** Denormalised so a cross-rule list does not need a rule lookup per row. */
  ruleName?: string;
  trigger: AutomationTriggerType;
  status: RunStatus;
  /** The project the triggering event was about. Needed to filter by project. */
  projectId?: string;
  actionCount: number;
  startedAt: string;
  finishedAt?: string;
  ms?: number;
  error?: string;
  /** What the run produced, so the index can filter by workflow. */
  produced?: ProducedRef[];
}

/* ── Action host contract ─────────────────────────────────────────── */

export interface ActionCtx {
  projectId: string;
  projectPath: string;
  event: AutomationEvent;
  /**
   * Correlation back to the rule and execution that caused this action.
   *
   * Added so an action that delegates to another engine can carry the
   * causal chain with it — a workflow run started by an automation records
   * which rule and which automation run triggered it, and the audit trail
   * can be walked from the event to the governed effect without guessing.
   */
  ruleId: string;
  runId: string;
  log: (level: 'info' | 'warn' | 'error', text: string) => void;
  signal?: AbortSignal;
}

export interface ActionResult {
  ok: boolean;
  summary?: string;
  error?: string;
  result?: unknown;
  /**
   * What the action brought into existence, if anything. Recorded on the
   * run state verbatim — the engine never infers a product from a summary.
   */
  produced?: ProducedRef;
}

export type ActionHandler = (ctx: ActionCtx, config: Record<string, unknown>) => Promise<ActionResult>;

/* ── Events emitted while a rule executes ─────────────────────────── */

export type AutomationRunEvent =
  | { type: 'run'; run: AutomationRun }
  | { type: 'log'; runId: string; level: 'info' | 'warn' | 'error'; text: string; at: string }
  | { type: 'done'; runId: string; status: RunStatus; ms: number };

export const genId = (p = 'auto') => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
