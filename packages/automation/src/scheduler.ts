/**
 * AutomationScheduler — a clock that pushes events. Nothing else.
 * ==================================================================
 * The Automation Engine reacts to events. A schedule is a source of
 * events. So the scheduler owns a timer and a small piece of persisted
 * state, and its entire output is `handleEvent({ type: 'schedule', … })`.
 *
 * It does not execute rules, evaluate conditions, run actions, retry,
 * or know what a workflow is. Everything after the event is the existing
 * path, unchanged.
 *
 * ── The catch-up decision ──────────────────────────────────────────
 * A desktop app is closed most of the time, which makes "what happens to
 * the fires you missed?" the central design question rather than a corner
 * case. Three options and why this one:
 *
 *   • Fire all of them on launch — an hourly rule after a week off would
 *     fire 168 times. Obviously wrong, and dangerous when a rule runs a
 *     workflow with real effects.
 *   • Fire exactly one catch-up — plausible, but it means launching AURA
 *     silently performs work whose scheduled moment has passed, which is
 *     surprising in exactly the situation where surprise is expensive.
 *   • Fire none, and RECORD that fires were missed — chosen.
 *
 * A missed fire is not silently dropped: `missedCount` and `lastMissedAt`
 * are persisted and reported, so the UI can say "3 runs were missed while
 * AURA was closed" instead of the user discovering nothing happened.
 */

import type { AutomationEngine } from './engine';
import type { AutomationStore } from './store';
import type { AutomationEvent, AutomationRule } from './types';
import { nextAfter, parseCron } from './schedule';

/** How often the scheduler wakes. One minute is the resolution of cron. */
const TICK_MS = 30_000;

export interface ScheduleState {
  /** Last moment this rule actually fired. */
  lastFiredAt?: string;
  /** Computed next fire, so the UI can show it without re-parsing. */
  nextFireAt?: string;
  /** Fires that came due while AURA was not running. Never executed. */
  missedCount: number;
  lastMissedAt?: string;
  /** Set when the cron stopped parsing (a rule edited to an invalid one). */
  error?: string;
}

export interface SchedulePersistence {
  load(): Record<string, ScheduleState>;
  save(state: Record<string, ScheduleState>): void;
}

export interface SchedulerDeps {
  engine: AutomationEngine;
  store: AutomationStore;
  persistence: SchedulePersistence;
  /** Resolve a project's path. Throws for an unknown project. */
  projectPath(projectId: string): string;
  /** Injectable for tests; defaults to the real clock. */
  now?: () => Date;
}

export class AutomationScheduler {
  private timer: NodeJS.Timeout | null = null;
  private state: Record<string, ScheduleState>;
  private readonly now: () => Date;

  constructor(private readonly deps: SchedulerDeps) {
    this.now = deps.now ?? (() => new Date());
    this.state = deps.persistence.load();
  }

  /**
   * Begin scheduling.
   *
   * The first thing it does is RECONCILE, not fire: every schedule's next
   * fire is recomputed from now, and anything that came due while the
   * process was gone is counted as missed. Only after that does the timer
   * start, so a launch can never execute a backlog.
   */
  start(): { scheduled: number; missed: number } {
    const summary = this.reconcile();
    this.stop();
    this.timer = setInterval(() => { void this.tick(); }, TICK_MS);
    // Never hold the process open on the scheduler's account.
    this.timer.unref?.();
    return summary;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Current state per rule, for the UI. Read-only. */
  status(): Record<string, ScheduleState> {
    return JSON.parse(JSON.stringify(this.state)) as Record<string, ScheduleState>;
  }

  private scheduledRules(): AutomationRule[] {
    return this.deps.store.listRules()
      .map((s) => this.deps.store.getRule(s.id))
      .filter((r): r is AutomationRule => Boolean(r && r.trigger.type === 'schedule'));
  }

  /**
   * Recompute every schedule against the current clock, counting anything
   * that came due while the process was not running.
   */
  reconcile(): { scheduled: number; missed: number } {
    const now = this.now();
    let scheduled = 0;
    let missed = 0;
    const next: Record<string, ScheduleState> = {};

    for (const rule of this.scheduledRules()) {
      const prior = this.state[rule.id] ?? { missedCount: 0 };
      const parsed = parseCron(rule.trigger.cron ?? '');
      if (!parsed.ok) {
        next[rule.id] = { ...prior, nextFireAt: undefined, error: parsed.error };
        continue;
      }

      // Count the fires between the last one and now. A disabled rule is
      // not "missing" anything — it was switched off on purpose.
      let missedForRule = 0;
      if (rule.enabled && prior.lastFiredAt) {
        let cursor = nextAfter(parsed.cron, new Date(prior.lastFiredAt));
        // Bounded: a rule untouched for years must not spin here.
        while (cursor && cursor <= now && missedForRule < 1000) {
          missedForRule += 1;
          cursor = nextAfter(parsed.cron, cursor);
        }
      }

      const upcoming = nextAfter(parsed.cron, now);
      next[rule.id] = {
        lastFiredAt: prior.lastFiredAt,
        nextFireAt: upcoming ? upcoming.toISOString() : undefined,
        missedCount: (prior.missedCount ?? 0) + missedForRule,
        lastMissedAt: missedForRule ? now.toISOString() : prior.lastMissedAt,
        error: undefined,
      };
      if (missedForRule) missed += missedForRule;
      if (rule.enabled && upcoming) scheduled += 1;
    }

    this.state = next;
    this.deps.persistence.save(this.state);
    return { scheduled, missed };
  }

  /**
   * One wake-up. Fires every schedule that has come due.
   *
   * Exported for tests with an injected clock, so due-ness can be proven
   * without waiting for wall time.
   */
  async tick(): Promise<string[]> {
    const now = this.now();
    const fired: string[] = [];

    for (const rule of this.scheduledRules()) {
      if (!rule.enabled) continue;
      const state = this.state[rule.id];
      if (!state?.nextFireAt || state.error) continue;
      if (new Date(state.nextFireAt) > now) continue;

      const parsed = parseCron(rule.trigger.cron ?? '');
      if (!parsed.ok) { this.state[rule.id] = { ...state, error: parsed.error, nextFireAt: undefined }; continue; }

      // A schedule with no project is a schedule that cannot say what it is
      // about. It is skipped with a stated reason rather than run against
      // whatever happens to be open.
      const projectId = rule.trigger.projectId;
      if (!projectId) {
        this.state[rule.id] = { ...state, error: 'This schedule has no project. Set one on the rule.', nextFireAt: undefined };
        continue;
      }
      let projectPath: string;
      try {
        projectPath = this.deps.projectPath(projectId);
      } catch {
        this.state[rule.id] = { ...state, error: `The project this schedule targets (${projectId}) no longer exists.`, nextFireAt: undefined };
        continue;
      }

      const event: AutomationEvent = {
        type: 'schedule',
        projectId,
        projectPath,
        at: now.toISOString(),
        payload: { cron: rule.trigger.cron, ruleId: rule.id, firedAt: now.toISOString() },
      };
      // The ONE thing this class does.
      this.deps.engine.handleEvent(event);
      fired.push(rule.id);

      const upcoming = nextAfter(parsed.cron, now);
      this.state[rule.id] = {
        lastFiredAt: now.toISOString(),
        nextFireAt: upcoming ? upcoming.toISOString() : undefined,
        missedCount: state.missedCount ?? 0,
        lastMissedAt: state.lastMissedAt,
      };
    }

    if (fired.length) this.deps.persistence.save(this.state);
    return fired;
  }

  /** Recompute one rule after it was created or edited. */
  refresh(ruleId: string): ScheduleState | null {
    const rule = this.deps.store.getRule(ruleId);
    if (!rule || rule.trigger.type !== 'schedule') {
      delete this.state[ruleId];
      this.deps.persistence.save(this.state);
      return null;
    }
    const parsed = parseCron(rule.trigger.cron ?? '');
    const prior = this.state[ruleId] ?? { missedCount: 0 };
    if (!parsed.ok) {
      this.state[ruleId] = { ...prior, nextFireAt: undefined, error: parsed.error };
    } else {
      const upcoming = nextAfter(parsed.cron, this.now());
      this.state[ruleId] = { ...prior, nextFireAt: upcoming ? upcoming.toISOString() : undefined, error: undefined };
    }
    this.deps.persistence.save(this.state);
    return this.state[ruleId];
  }
}
