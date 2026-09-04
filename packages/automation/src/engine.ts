/**
 * AutomationEngine — the runtime.
 * ==================================================================
 * Reacts to REAL events pushed by the host (mission completed, diagnosis
 * accepted, file/dependency changes, PR merged). For every enabled rule
 * whose trigger matches the event, it evaluates the deterministic
 * conditions; when all pass, it creates a persisted run and executes the
 * action chain. Actions are injected by the host through the `actions`
 * registry — the engine never performs a side effect itself.
 *
 * Reliability:
 *   - retries  — per-action RetryPolicy with exponential backoff
 *   - queue    — when a rule is already running, further matching events
 *                queue up as runs (processed in FIFO order)
 *   - statuses — queued / running / retrying / paused / completed /
 *                failed / cancelled
 *   - timeline — every transition is appended to the run's timeline and
 *                persisted atomically
 *   - abort    — an optional AbortSignal stops the run at the next
 *                safe point
 */
import type {
  ActionResult,
  ActionRunState,
  AutomationEvent,
  AutomationRule,
  AutomationRun,
  AutomationRunEvent,
  Condition,
  ConditionEvaluation,
  RetryPolicy,
  RunStatus,
  RunTimelineEntry,
  ActionHandler,
  ProducedRef,
} from './types';
import { genId } from './types';
import { AutomationStore } from './store';

export interface AutomationEngineOptions {
  store: AutomationStore;
  actions: Record<string, ActionHandler>;
  emit?: (e: AutomationRunEvent) => void;
  /** Default delay resolution used between retries (overridable for tests). */
  sleep?: (ms: number) => Promise<void>;
}

const sleepDefault = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function getPath(payload: Record<string, unknown>, path: string): unknown {
  if (!path) return payload;
  let cur: unknown = payload;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/**
 * Subset match used by `trigger.match`: every key in `expected` must match
 * the corresponding key in `actual`, recursively for object values. Extra
 * keys on `actual` are ignored — this is a coarse *filter*, not a full
 * equality check (real event payloads carry more fields than any one
 * template cares about, e.g. `{ status: 'completed', text: '...' }` matching
 * `{ status: 'completed' }`).
 */
function partialMatch(actual: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== 'object' || Array.isArray(expected)) {
    return JSON.stringify(actual) === JSON.stringify(expected);
  }
  if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return false;
  for (const [k, v] of Object.entries(expected as Record<string, unknown>)) {
    if (!partialMatch((actual as Record<string, unknown>)[k], v)) return false;
  }
  return true;
}

function coerceNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

export function evaluateCondition(payload: Record<string, unknown>, cond: Condition): boolean {
  const got = getPath(payload, cond.field);
  switch (cond.op) {
    case 'equals': return JSON.stringify(got) === JSON.stringify(cond.value);
    case 'not-equals': return JSON.stringify(got) !== JSON.stringify(cond.value);
    case 'exists': return got !== undefined && got !== null;
    case 'not-exists': return got === undefined || got === null;
    case 'contains':
      if (typeof got === 'string') return got.includes(String(cond.value ?? ''));
      if (Array.isArray(got)) return got.some((x) => JSON.stringify(x) === JSON.stringify(cond.value));
      return false;
    case 'not-contains':
      if (typeof got === 'string') return !got.includes(String(cond.value ?? ''));
      if (Array.isArray(got)) return !got.some((x) => JSON.stringify(x) === JSON.stringify(cond.value));
      return true;
    case 'in':
      return Array.isArray(cond.value) && cond.value.some((x) => JSON.stringify(x) === JSON.stringify(got));
    case 'matches-regex': {
      if (typeof got !== 'string') return false;
      try {
        return new RegExp(String(cond.value ?? '')).test(got);
      } catch {
        return false;
      }
    }
    case 'gt': {
      const a = coerceNumber(got);
      const b = coerceNumber(cond.value);
      return a !== null && b !== null && a > b;
    }
    case 'gte': {
      const a = coerceNumber(got);
      const b = coerceNumber(cond.value);
      return a !== null && b !== null && a >= b;
    }
    case 'lt': {
      const a = coerceNumber(got);
      const b = coerceNumber(cond.value);
      return a !== null && b !== null && a < b;
    }
    case 'lte': {
      const a = coerceNumber(got);
      const b = coerceNumber(cond.value);
      return a !== null && b !== null && a <= b;
    }
    default:
      return false;
  }
}

export function evaluateConditions(payload: Record<string, unknown>, conditions: Condition[]): ConditionEvaluation[] {
  return conditions.map((cond, index) => {
    const passed = evaluateCondition(payload, cond);
    return { index, field: cond.field, op: cond.op, passed, note: passed ? undefined : `condition failed on "${cond.field}"` };
  });
}

/** Identity of a produced thing, for the run-level rollup's de-duplication. */
function samePrduced(a: ProducedRef, b: ProducedRef): boolean {
  return a.kind === b.kind && a.kind === 'workflow-run' && b.kind === 'workflow-run'
    ? a.runId === b.runId
    : false;
}

const retryDelay = (policy: RetryPolicy, attempt: number) =>
  Math.round(policy.delayMs * Math.pow(policy.backoffFactor, Math.max(0, attempt - 1)));

export class AutomationEngine {
  private readonly store: AutomationStore;
  private readonly actions: Record<string, ActionHandler>;
  private readonly emit?: (e: AutomationRunEvent) => void;
  private readonly sleep: (ms: number) => Promise<void>;

  /** rules currently executing, so matching events queue instead of clobbering. */
  private readonly running = new Map<string, boolean>();

  /**
   * Runs currently inside `execute()`, keyed by run id, holding the exact
   * same `AutomationRun` object instance `execute()` is mutating (not a
   * fresh copy re-read from disk) plus its `AbortController`. `pauseRule`/
   * `cancelRun` must mutate *this* object — a separately-loaded copy would
   * be silently overwritten by `execute()`'s next `saveRun()` call.
   */
  private readonly liveRuns = new Map<string, { run: AutomationRun; controller: AbortController }>();

  constructor(opts: AutomationEngineOptions) {
    this.store = opts.store;
    this.actions = opts.actions;
    this.emit = opts.emit;
    this.sleep = opts.sleep ?? sleepDefault;
  }

  /* ── matching ───────────────────────────────────────────────────── */

  /** Deterministic trigger filter: rule's trigger type + coarse match map. */
  private triggerMatches(rule: AutomationRule, event: AutomationEvent): boolean {
    if (rule.trigger.type !== event.type) return false;
    const m = rule.trigger.match;
    if (m) {
      for (const [k, v] of Object.entries(m)) {
        if (!partialMatch(getPath(event.payload, k), v)) return false;
      }
    }
    return true;
  }

  private ruleMatches(rule: AutomationRule, event: AutomationEvent): { matched: boolean; conditions: ConditionEvaluation[] } {
    if (!this.triggerMatches(rule, event)) return { matched: false, conditions: [] };
    if (rule.conditions.length === 0) return { matched: true, conditions: [] };
    const evals = evaluateConditions(event.payload, rule.conditions);
    return { matched: evals.every((c) => c.passed), conditions: evals };
  }

  /* ── public API ─────────────────────────────────────────────────── */

  /** Push a real event into the engine. Returns the created run (or null). */
  handleEvent(event: AutomationEvent): AutomationRun | null {
    const rules = this.store.listRules().map((s) => this.store.getRule(s.id)).filter((r): r is AutomationRule => Boolean(r && r.enabled));
    let created: AutomationRun | null = null;
    for (const rule of rules) {
      const match = this.ruleMatches(rule, event);
      if (!match.matched) continue;
      const run = this.store.createRun(rule, event);
      run.conditions = match.conditions;
      run.timeline.push({
        id: genId('t'),
        at: new Date().toISOString(),
        type: 'condition-check',
        message: `${match.conditions.filter((c) => c.passed).length}/${match.conditions.length} conditions passed`,
        level: 'info',
      });
      run.status = 'queued';
      this.store.saveRun(run);
      this.emit?.({ type: 'run', run });
      if (!created) created = run;
      void this.pump(rule);
    }
    return created;
  }

  /** Run a rule by id against a synthetic event (manual trigger). */
  async runRuleNow(ruleId: string, event: AutomationEvent): Promise<AutomationRun | null> {
    const rule = this.store.getRule(ruleId);
    if (!rule) return null;
    const match = this.ruleMatches(rule, event);
    if (!match.matched) return null;
    const run = this.store.createRun(rule, event);
    run.conditions = match.conditions;
    this.store.saveRun(run);
    this.emit?.({ type: 'run', run });
    await this.execute(run, rule);
    return run;
  }

  /** Number of currently-executing rules (queue guard visibility). */
  activeRules(): number {
    return [...this.running.values()].filter(Boolean).length;
  }

  /* ── execution ──────────────────────────────────────────────────── */

  private async pump(rule: AutomationRule): Promise<void> {
    if (this.running.get(rule.id)) return;
    this.running.set(rule.id, true);
    try {
      // Loop while there are queued runs for this rule.
      let next = this.nextQueuedRun(rule.id);
      while (next) {
        await this.execute(next, rule);
        next = this.nextQueuedRun(rule.id);
      }
    } finally {
      this.running.delete(rule.id);
    }
  }

  private nextQueuedRun(ruleId: string): AutomationRun | null {
    const runs = this.store.listRuns(ruleId).filter((s) => s.status === 'queued').sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    if (!runs.length) return null;
    return this.store.getRun(ruleId, runs[0].id);
  }

  private async execute(run: AutomationRun, rule: AutomationRule): Promise<void> {
    const controller = new AbortController();
    this.liveRuns.set(run.id, { run, controller });
    try {
      const t0 = Date.now();
      run.status = 'running';
      run.startedAt = new Date().toISOString();
      this.appendTimeline(run, 'started', `Executing "${rule.name}"`);
      this.store.saveRun(run);
      this.emit?.({ type: 'run', run });

      for (const action of rule.chain) {
        const status: RunStatus = run.status as RunStatus;
        if (status === 'cancelled') break;
        if (status === 'paused') {
          this.appendTimeline(run, 'paused', `Paused before "${action.label}"`);
          this.store.saveRun(run);
          break;
        }
        const state = run.actions.find((a) => a.actionId === action.id);
        if (!state) continue;
        const ok = await this.runActionWithRetries(run, state, action, rule, controller.signal);
        if (!ok && !action.continueOnError) {
          run.status = 'failed';
          run.error = state.error ?? `action "${action.label}" failed`;
          run.finishedAt = new Date().toISOString();
          run.ms = Date.now() - t0;
          this.appendTimeline(run, 'failed', run.error, 'error');
          this.store.saveRun(run);
          this.emit?.({ type: 'done', runId: run.id, status: 'failed', ms: run.ms });
          return;
        }
      }

      const after: RunStatus = run.status as RunStatus;
      // paused mid-chain (resume() re-pumps) or cancelled — either way, the
      // status was already finalized and persisted where it was set; don't
      // fall through and stamp it 'completed'.
      if (after === 'paused' || after === 'cancelled') return;

      run.status = 'completed';
      run.finishedAt = new Date().toISOString();
      run.ms = Date.now() - t0;
      this.appendTimeline(run, 'completed', `Completed in ${run.ms}ms`);
      this.store.saveRun(run);
      this.emit?.({ type: 'done', runId: run.id, status: 'completed', ms: run.ms });
    } finally {
      this.liveRuns.delete(run.id);
    }
  }

  private async runActionWithRetries(
    run: AutomationRun,
    state: ActionRunState,
    action: AutomationRule['chain'][number],
    rule: AutomationRule,
    signal: AbortSignal,
  ): Promise<boolean> {
    let attempt = 0;
    const policy = rule.retry;
    const label = action.label;
    while (attempt < policy.maxAttempts) {
      attempt += 1;
      state.attempts = attempt;
      state.status = attempt === 1 ? 'running' : 'retrying';
      state.startedAt = new Date().toISOString();
      state.error = undefined;
      run.status = attempt === 1 ? 'running' : 'retrying';
      this.appendTimeline(run, state.status === 'retrying' ? 'action-retried' : 'action-started', `Attempt ${attempt}: ${label}`, 'info', state.actionId);
      this.store.saveRun(run);
      this.emit?.({ type: 'run', run });

      const t = Date.now();
      let result: ActionResult;
      try {
        const handler = this.actions[state.action];
        if (!handler) throw new Error(`no action handler registered for "${state.action}"`);
        result = await handler(
          {
            projectId: run.event.projectId,
            projectPath: run.event.projectPath,
            ruleId: rule.id,
            runId: run.id,
            event: run.event,
            log: (level, text) => this.appendTimeline(run, 'log', text, level, state.actionId),
            signal,
          },
          mergeConfig(run.event.payload, action.config),
        );
      } catch (e) {
        result = { ok: false, error: (e as Error).message };
      }

      state.ms = Date.now() - t;
      // Recorded on BOTH outcomes: a workflow run that failed or parked is
      // exactly the one an operator most needs a link to. The deprecated
      // flat fields are written from the SAME value, in one place, so the
      // structured reference and its compatibility mirror cannot diverge.
      if (result.produced) {
        state.produced = result.produced;
        if (result.produced.kind === 'workflow-run') {
          state.workflowRunId = result.produced.runId;
          state.workflowRunState = result.produced.state;
        }
        run.produced = [...(run.produced ?? []).filter((p) => !samePrduced(p, result.produced!)), result.produced];
      }
      if (result.ok) {
        state.status = 'completed';
        state.summary = result.summary;
        state.finishedAt = new Date().toISOString();
        this.appendTimeline(run, 'action-completed', `${label} ok${result.summary ? ` — ${result.summary}` : ''}`, 'info', state.actionId);
        this.store.saveRun(run);
        this.emit?.({ type: 'run', run });
        return true;
      }

      state.error = result.error ?? 'action failed';
      if (attempt >= policy.maxAttempts) {
        state.status = 'failed';
        state.finishedAt = new Date().toISOString();
        this.appendTimeline(run, 'action-failed', `${label} failed: ${state.error}`, 'error', state.actionId);
        this.store.saveRun(run);
        this.emit?.({ type: 'run', run });
        return false;
      }

      const wait = retryDelay(policy, attempt);
      this.appendTimeline(run, 'action-retried', `${label} failed — retrying in ${wait}ms (${attempt}/${policy.maxAttempts})`, 'warn', state.actionId);
      this.store.saveRun(run);
      this.emit?.({ type: 'run', run });
      await this.sleep(wait);
    }
    return false;
  }

  /* ── control ────────────────────────────────────────────────────── */

  /** The live (currently-executing) copy of a run, if `execute()` holds one. */
  private liveRun(ruleId: string, runId?: string): { run: AutomationRun; controller: AbortController } | null {
    for (const entry of this.liveRuns.values()) {
      if (entry.run.ruleId !== ruleId) continue;
      if (runId && entry.run.id !== runId) continue;
      return entry;
    }
    return null;
  }

  /**
   * Pause a running rule (further queued runs are held).
   *
   * Mutates the exact in-memory `AutomationRun` object `execute()` is
   * running, not a fresh copy — `execute()`'s own next `saveRun()` call
   * would otherwise silently overwrite a change made to a separate copy.
   */
  pauseRule(ruleId: string): AutomationRun | null {
    const live = this.liveRun(ruleId);
    const run = live?.run.status === 'running' || live?.run.status === 'retrying' ? live.run : null;
    if (!run) return null;
    run.status = 'paused';
    this.appendTimeline(run, 'paused', 'Rule paused');
    this.store.saveRun(run);
    this.emit?.({ type: 'run', run });
    return run;
  }

  /** Resume a paused rule's run (queued runs resume naturally). */
  resumeRule(ruleId: string): AutomationRun | null {
    const run = this.store.listRuns(ruleId).map((s) => this.store.getRun(ruleId, s.id)).find((r) => r && r.status === 'paused') ?? null;
    if (!run) return null;
    run.status = 'running';
    this.appendTimeline(run, 'resumed', 'Rule resumed');
    this.store.saveRun(run);
    this.emit?.({ type: 'run', run });
    const rule = this.store.getRule(ruleId);
    if (rule) void this.pump(rule);
    return run;
  }

  /**
   * Cancel a queued or running run. For a live (currently-executing) run,
   * mutates the same object `execute()` holds (see `pauseRule`) and aborts
   * its controller so a cooperating action handler can stop early.
   */
  cancelRun(ruleId: string, runId: string): AutomationRun | null {
    const live = this.liveRun(ruleId, runId);
    const run = live?.run ?? this.store.getRun(ruleId, runId);
    if (!run || run.status === 'completed' || run.status === 'cancelled') return null;
    run.status = 'cancelled';
    run.finishedAt = new Date().toISOString();
    this.appendTimeline(run, 'cancelled', 'Run cancelled');
    this.store.saveRun(run);
    this.emit?.({ type: 'run', run });
    this.emit?.({ type: 'done', runId: run.id, status: 'cancelled', ms: run.ms ?? 0 });
    live?.controller.abort();
    return run;
  }

  /* ── helpers ────────────────────────────────────────────────────── */

  private appendTimeline(run: AutomationRun, type: RunTimelineEntry['type'], message: string, level: 'info' | 'warn' | 'error' = 'info', actionId?: string): void {
    run.timeline.push({ id: genId('t'), at: new Date().toISOString(), type, message, level, actionId });
  }
}

/** Merge the event payload into an action's static config, so actions
 *  can interpolate `{{payload.x}}` placeholders with real event data. */
function mergeConfig(payload: Record<string, unknown>, config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    if (typeof v === 'string') {
      out[k] = v.replace(/\{\{\s*payload\.([\w.]+)\s*\}\}/g, (_, p: string) => String(lookup(payload, p) ?? ''));
    } else {
      out[k] = v;
    }
  }
  return out;
}

function lookup(obj: Record<string, unknown>, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}
