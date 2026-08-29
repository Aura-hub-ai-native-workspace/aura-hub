/**
 * automationClient — the Automation Engine's surface.
 * ==================================================================
 * Thin fetch wrappers over `/automation`, with no state of its own —
 * the same shape as `fabricClient` and `missionClient`.
 *
 * The shapes below mirror `packages/automation/src/types.ts`. They are
 * declared rather than imported because the renderer is a separate
 * compilation unit from the node service; the service stays the authority
 * and this is its wire shape.
 *
 * Two properties of the engine matter to every screen that reads this:
 *
 *   • A rule's `enabled` flag is enforced by the engine, not by the UI.
 *     `handleEvent` only considers enabled rules, so toggling here is a
 *     real state change and never a local display filter.
 *   • The `run-workflow` action grants nothing. An automation fires with
 *     no human present, so a node whose policy decision is above
 *     auto-execute parks the workflow run at `awaiting-approval` and it
 *     waits to be answered. The UI must show that as a *successful*
 *     automation waiting on a person — not as a failure.
 */

import { aiClient, type DryRunReport } from './aiClient';

const BASE = aiClient.base;

/* ── triggers ──────────────────────────────────────────────────────── */

/**
 * The moments the engine listens for.
 *
 * Seven are real platform events the host pushes when they genuinely
 * happen. `schedule` is a wall-clock moment delivered by the scheduler —
 * modelled as a trigger rather than a second kind of rule, so conditions,
 * the action chain, retries and the timeline are all unchanged.
 */
export type AutomationTriggerType =
  | 'mission-completed'
  | 'mission-accepted'
  | 'diagnosis-completed'
  | 'diagnosis-accepted'
  | 'file-changed'
  | 'readme-changed'
  | 'dependency-changed'
  | 'pr-merged'
  | 'schedule';

export interface AutomationEvent {
  type: AutomationTriggerType;
  projectId: string;
  projectPath: string;
  at: string;
  payload: Record<string, unknown>;
}

/* ── conditions ────────────────────────────────────────────────────── */

export type ConditionOp =
  | 'equals' | 'not-equals' | 'exists' | 'not-exists'
  | 'contains' | 'not-contains' | 'in' | 'matches-regex'
  | 'gt' | 'gte' | 'lt' | 'lte';

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

/* ── actions ───────────────────────────────────────────────────────── */

export type AutomationActionType =
  | 'run-diagnosis'
  | 'run-governance-audit'
  | 'run-security-review'
  | 'run-docs-review'
  | 'update-knowledge'
  | 'save-memory'
  /** Hands a workflow to the Workflow Engine — the bridge between the two. */
  | 'run-workflow';

export interface RuleAction {
  id: string;
  action: AutomationActionType;
  label: string;
  config: Record<string, unknown>;
  continueOnError?: boolean;
}

export interface RetryPolicy {
  maxAttempts: number;
  delayMs: number;
  backoffFactor: number;
}

/* ── rules ─────────────────────────────────────────────────────────── */

export interface AutomationRule {
  id: string;
  name: string;
  description: string;
  category: string;
  enabled: boolean;
  trigger: {
    type: AutomationTriggerType;
    match?: Record<string, unknown>;
    /** Five-field cron. Required when `type === 'schedule'`, ignored otherwise. */
    cron?: string;
    /**
     * The project a schedule runs against. A time trigger carries no event
     * to say which project it is about, so it is named at authoring time
     * rather than guessed from whatever happens to be open.
     */
    projectId?: string;
  };
  conditions: Condition[];
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
  /* Present only on a `schedule` rule — the service folds the scheduler's
     state in at read time rather than copying clock state into the rule
     file, where it would go stale. */
  cron?: string;
  scheduleProjectId?: string;
  schedule?: {
    nextFireAt?: string;
    missedCount: number;
    lastFiredAt?: string;
    error?: string;
    description?: string;
    /** The service evaluates cron against the machine's clock, and says so. */
    timezone: 'local';
  };
}

export interface AutomationTemplateInfo {
  id: string;
  name: string;
  description: string;
  category: string;
}

/* ── schedules ─────────────────────────────────────────────────────── */

/**
 * The scheduler's own record for one rule. `nextFireAt` is computed by the
 * service, so the UI never parses cron to answer "when next" — it reads
 * the answer.
 */
export interface ScheduleState {
  lastFiredAt?: string;
  nextFireAt?: string;
  /** Fires that came due while AURA was not running. Never executed. */
  missedCount: number;
  lastMissedAt?: string;
  /** Set when the cron stopped parsing. */
  error?: string;
}

/** One problem the service found with a rule, from `POST /automation/validate`. */
export interface RuleValidationIssue {
  field: string;
  message: string;
}

/* ── runs ──────────────────────────────────────────────────────────── */

export type AutomationRunStatus =
  | 'queued' | 'running' | 'paused' | 'retrying'
  | 'completed' | 'failed' | 'cancelled';

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
  /** Human summary the handler produced. Display only — never parsed. */
  summary?: string;
  /**
   * What this action produced, when it produced something addressable.
   * Carries both ids, so the workflow run resolves directly.
   */
  produced?: ProducedRef;
}

/**
 * Something an action produced, addressably.
 *
 * A discriminated union so adding a product later is a new member rather
 * than a new pair of loosely-related fields.
 */
export type ProducedRef = {
  kind: 'workflow-run';
  workflowId: string;
  runId: string;
  /** The run's own state vocabulary, unflattened. */
  state: string;
};

export type AutomationTimelineType =
  | 'queued' | 'started' | 'condition-check'
  | 'action-started' | 'action-completed' | 'action-failed'
  | 'action-retried' | 'action-skipped'
  | 'paused' | 'resumed' | 'cancelled'
  | 'completed' | 'failed' | 'log';

export interface RunTimelineEntry {
  id: string;
  at: string;
  type: AutomationTimelineType;
  message: string;
  level?: 'info' | 'warn' | 'error';
  actionId?: string;
}

export interface AutomationRun {
  id: string;
  ruleId: string;
  event: AutomationEvent;
  status: AutomationRunStatus;
  timeline: RunTimelineEntry[];
  actions: ActionRunState[];
  conditions: ConditionEvaluation[];
  startedAt: string;
  finishedAt?: string;
  ms?: number;
  error?: string;
  nextRunId?: string;
  /** Everything this run produced, rolled up from its actions. */
  produced?: ProducedRef[];
}

export interface AutomationRunSummary {
  id: string;
  ruleId: string;
  trigger: AutomationTriggerType;
  status: AutomationRunStatus;
  actionCount: number;
  startedAt: string;
  finishedAt?: string;
  ms?: number;
  error?: string;
  /** What the run produced, so a listing can filter by workflow. */
  produced?: ProducedRef[];
}

/** One row of the cross-rule run index. */
export interface AutomationRunIndexRow {
  id: string;
  ruleId: string;
  /** Denormalised by the service; absent for a rule that has been deleted. */
  ruleName?: string;
  trigger: AutomationTriggerType;
  status: AutomationRunStatus;
  projectId: string;
  actionCount: number;
  startedAt: string;
  finishedAt?: string;
  ms?: number;
  error?: string;
  produced?: ProducedRef[];
}

export interface AutomationRunIndex {
  runs: AutomationRunIndexRow[];
  total: number;
  offset: number;
  limit: number;
}

export interface RunIndexQuery {
  ruleId?: string;
  projectId?: string;
  status?: AutomationRunStatus;
  trigger?: AutomationTriggerType;
  /** Filter to runs that started a run of this workflow. */
  workflowId?: string;
  /** Free text over the rule name. */
  q?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

/** Live events the engine emits while a rule executes. */
export type AutomationStreamEvent =
  | { type: 'subscribed' }
  | { type: 'run'; run: AutomationRun }
  | { type: 'log'; runId: string; level: 'info' | 'warn' | 'error'; text: string; at: string }
  | { type: 'done'; runId: string; status: AutomationRunStatus; ms: number };

/* ── the workflow link ─────────────────────────────────────────────── */

/**
 * The workflow run a `run-workflow` action started.
 *
 * Reads the service's structured `produced` reference. The first version
 * of this client recovered the id from the action's summary sentence with
 * a regular expression; that is gone — the engine now carries both ids on
 * the record, so there is nothing to parse and nothing to get wrong.
 */
export function producedWorkflowRun(action: ActionRunState): { workflowId: string; runId: string; state: string } | null {
  const p = action.produced;
  if (!p || p.kind !== 'workflow-run' || !p.workflowId || !p.runId) return null;
  return { workflowId: p.workflowId, runId: p.runId, state: p.state };
}

/* ── transport ─────────────────────────────────────────────────────── */

const jget = <T>(p: string): Promise<T> => fetch(BASE + p).then((r) => r.json() as Promise<T>);
const jsend = <T>(method: string, p: string, body?: unknown): Promise<T> =>
  fetch(BASE + p, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then((r) => r.json() as Promise<T>);

/* ── rule dry run (POST /automation/rules/:id/dry-run) ────────────
   The service's own answer to "what would this rule do?". It evaluates
   conditions and policy and creates nothing — the report carries its own
   proof of that, which the verification suite checks against the real
   system rather than taking on trust.

   The certainty vocabulary is the service's, not a presentation choice:
   `known` means it was actually determined, `conditional` means it
   depends on something a dry run cannot decide, and `unknown` means it
   could not be reasoned about at all. `value` is null unless `known`, so
   there is no such thing as a guessed answer here. */

export type Certainty = 'known' | 'conditional' | 'unknown';

export interface Determination<T> {
  certainty: Certainty;
  /** Null whenever `certainty` is not `known`. Never a guess. */
  value: T | null;
  reason: string;
  /** What it hinges on, for `conditional`. */
  dependsOn?: string;
}

export interface PlannedRuleAction {

  actionId: string;
  action: string;
  label: string;
  /** Would the chain reach this action at all? */
  reached: Determination<boolean>;
  /** Present for `run-workflow`: the nested workflow's own dry run. */
  workflow?: { workflowId: string; workflowName: string; dryRun: DryRunReport | null; error?: string };
  capabilities: { capabilityId: string; decision: string; rule: string; risk: string; wouldAskHuman: boolean; wouldBeDenied: boolean }[];
  continueOnError: boolean;
}

export interface RuleDryRunReport {
  ruleId: string;
  ruleName: string;
  enabled: boolean;
  at: string;
  /** Structural problems: a rule carrying these can never run correctly. */
  issues: { field: string; message: string }[];
  trigger: {
    type: string;
    accepted: Determination<boolean>;
    schedule?: { cron: string; description: string; nextFireAt: string | null; timezone: 'local' };
  };
  conditions: {
    outcome: Determination<boolean>;
    /** Populated only when a sample event was supplied. */
    evaluations: ConditionEvaluation[];
  };
  actions: PlannedRuleAction[];
  capabilitiesRequested: string[];
  approvalsRequired: { actionId: string; capabilityId: string; reason: string; rule: string }[];
  denials: { actionId: string; capabilityId: string; reason: string; rule: string }[];
  wouldRunUnattended: Determination<boolean>;
  /** Named uncertainties, so the report states its own limits. */
  unknowns: { what: string; why: string }[];
  /** The service's proof that it did nothing. Displayed, never asserted. */
  sideEffects: {
    automationRunsCreated: 0;
    workflowRunsCreated: 0;
    invocations: 0;
    approvalsCreated: 0;
    filesWritten: 0;
    note: string;
  };
}

/** A sample event to reason against. Shapes the known/conditional line. */
export interface SampleEvent {
  type: string;
  projectId: string;
  projectPath: string;
  at: string;
  payload: Record<string, unknown>;
}

export const automationClient = {

  templates: () => jget<{ templates: AutomationTemplateInfo[] }>('/automation/templates'),

  listRules: () => jget<{ rules: AutomationRuleSummary[] }>('/automation/rules'),

  /** Next fire, last fire and missed count per scheduled rule. */
  schedules: () => jget<{ schedules: Record<string, ScheduleState> }>('/automation/schedules'),

  /**
   * The service's own verdict on a draft rule.
   *
   * The builder validates locally for instant feedback, but this is the
   * authority — the same check the create and save routes run, so a rule
   * the service would refuse can be shown as refused before saving.
   */
  validate: (draft: Partial<AutomationRule>) =>
    jsend<{ issues: RuleValidationIssue[] }>('POST', '/automation/validate', draft),
  getRule: (id: string) => jget<AutomationRule | { error: string }>(`/automation/rules/${id}`),
  createRule: (input: Partial<AutomationRule> | { template: string }) =>
    jsend<AutomationRule | { error: string }>('POST', '/automation/rules', input),
  saveRule: (id: string, partial: Partial<AutomationRule>) =>
    jsend<AutomationRule | { error: string }>('PUT', `/automation/rules/${id}`, partial),
  /** Enable/disable is a PATCH of the real flag the engine reads. */
  patchRule: (id: string, partial: Partial<AutomationRule>) =>
    jsend<AutomationRule | { error: string }>('PATCH', `/automation/rules/${id}`, partial),
  removeRule: (id: string) => jsend<{ ok: boolean }>('DELETE', `/automation/rules/${id}`),

  /**
   * Run a rule now against a real project.
   *
   * The engine still evaluates the rule's conditions against the event it
   * builds, so a "run now" that does nothing is a real answer — the
   * service returns `{ error: 'conditions not met', run: null }` and the
   * UI reports exactly that.
   */
  runRule: (id: string, projectId: string, payload?: Record<string, unknown>) =>
    jsend<AutomationRun | { error: string; run: null }>('POST', `/automation/rules/${id}/run`, { projectId, payload }),

  pauseRule: (id: string) => jsend<AutomationRun | { error: string }>('POST', `/automation/rules/${id}/pause`, {}),
  resumeRule: (id: string) => jsend<AutomationRun | { error: string }>('POST', `/automation/rules/${id}/resume`, {}),

  listRuns: (ruleId: string) => jget<{ runs: AutomationRunSummary[] }>(`/automation/rules/${ruleId}/runs`),

  /**
   * What this rule would do, without doing any of it.
   *
   * Supplying `sampleEvent` is exactly what moves the trigger and the
   * conditions from `conditional` to `known`: with a payload the service
   * really evaluates them, and without one it says so rather than
   * assuming they pass.
   */
  dryRunRule: (ruleId: string, body: { sampleEvent?: SampleEvent; projectId?: string } = {}) =>
    jsend<RuleDryRunReport | { error: string }>('POST', `/automation/rules/${ruleId}/dry-run`, body),


  /**
   * Every automation run, across every rule, filtered and paged by the
   * service. Replaces the client-side merge the first version used.
   */
  runIndex: (query: RunIndexQuery = {}) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') p.set(k, String(v));
    const qs = p.toString();
    return jget<AutomationRunIndex>(`/automation/runs${qs ? `?${qs}` : ''}`);
  },
  getRun: (ruleId: string, runId: string) =>
    jget<AutomationRun | { error: string }>(`/automation/rules/${ruleId}/runs/${runId}`),
  cancelRun: (ruleId: string, runId: string) =>
    jsend<AutomationRun | { error: string }>('POST', `/automation/rules/${ruleId}/runs/${runId}/cancel`, {}),

  /**
   * Subscribe to the engine's live event stream.
   *
   * Returns an unsubscribe function. Never throws: a transport failure
   * closes the stream quietly and the caller's polling remains the
   * fallback, because a stream that fails loudly on a machine where the
   * service is simply not running is noise, not information.
   */
  subscribe(onEvent: (e: AutomationStreamEvent) => void): () => void {
    const es = new EventSource(`${BASE}/automation/events/stream`);
    es.onmessage = (m) => {
      try {
        onEvent(JSON.parse(m.data) as AutomationStreamEvent);
      } catch {
        /* a malformed frame is dropped rather than crashing the screen */
      }
    };
    es.onerror = () => es.close();
    return () => es.close();
  },
};
