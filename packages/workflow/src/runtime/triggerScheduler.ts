/**
 * TriggerScheduler — the event-driven activation layer (Phase 6).
 * ==================================================================
 * Scans workflow definitions for trigger nodes and activates them:
 *
 *   schedule      → cron parser + setTimeout (pure computation, no I/O)
 *   file-change   → host-registered EventSource (fs.watch lives in host)
 *   git-event     → host-registered EventSource (git polling lives in host)
 *   mission-event → host-registered EventSource (mission events from host)
 *   agent-event   → host-registered EventSource
 *   environment-event → host-registered EventSource
 *   manual        → NOT scheduled here; the UI calls startRun directly.
 *
 * When a trigger fires, the scheduler calls WorkflowRuntime.startRun()
 * with a TriggerInvocation. It never executes anything itself — it is
 * an orchestration component, not an execution authority.
 *
 * Concurrency (§14): when `settings.singleFlight` is true, a trigger
 * that fires while the workflow has an active run (running or paused)
 * is skipped. Default: concurrent runs allowed, each gets its own runId.
 * This is NOT distributed locking — it is a local, in-process guard.
 *
 * Restart (§15): the definitions ARE the source of truth. A restart
 * scans all 'ready' definitions and re-registers. No persisted
 * scheduling state, no duplicate registration — each (workflowId,
 * triggerNodeId) pair is registered exactly once.
 */

import type { WorkflowDefinition, WorkflowNode, TriggerType, TriggerNodeConfig } from '../types';
import type { WorkflowDefinitionStore } from '../definitionStore';
import type { WorkflowRunStore } from '../runStore';
import type { WorkflowRuntime } from './runtime';
import type { TriggerInvocation } from './types';
import { parseCron, nextFire } from './cron';

/** Context handed to an EventSource when it starts watching. */
export interface EventSourceContext {
  workflowId: string;
  triggerNodeId: string;
  projectId: string | null;
  /** Call this when the event fires. The scheduler handles single-flight. */
  fire(payload?: unknown): void;
}

/**
 * A host-supplied event source for non-schedule triggers. The host
 * owns the I/O (fs.watch, git polling, mission event hooks). The
 * scheduler owns the registration and the call to startRun.
 */
export interface TriggerEventSource {
  type: TriggerType;
  /**
   * Start watching. Returns a stop function. The config is the
   * trigger node's config (already typed by the caller).
   */
  start(config: TriggerNodeConfig, context: EventSourceContext): () => void;
}

interface Registration {
  workflowId: string;
  triggerNodeId: string;
  triggerType: TriggerType;
  stop(): void;
}

export interface TriggerSchedulerOptions {
  definitions: WorkflowDefinitionStore;
  runs: WorkflowRunStore;
  runtime: WorkflowRuntime;
  /** Event sources for non-schedule triggers, keyed by trigger type. */
  eventSources?: Partial<Record<TriggerType, TriggerEventSource>>;
  /** Injectable now/timer for tests. */
  now?: () => Date;
  setTimeout?: (fn: () => void, ms: number) => { clear(): void };
}

export class TriggerScheduler {
  private readonly definitions: WorkflowDefinitionStore;
  private readonly runs: WorkflowRunStore;
  private readonly runtime: WorkflowRuntime;
  private readonly eventSources: Partial<Record<TriggerType, TriggerEventSource>>;
  private readonly now: () => Date;
  private readonly timer: (fn: () => void, ms: number) => { clear(): void };
  private registrations = new Map<string, Registration>();
  private running = false;

  constructor(opts: TriggerSchedulerOptions) {
    this.definitions = opts.definitions;
    this.runs = opts.runs;
    this.runtime = opts.runtime;
    this.eventSources = opts.eventSources ?? {};
    this.now = opts.now ?? (() => new Date());
    this.timer = opts.setTimeout ?? ((fn, ms) => {
      const handle = setTimeout(fn, ms);
      return { clear: () => clearTimeout(handle) };
    });
  }

  /** Start scheduling for all 'ready' workflow definitions. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.registerAll();
  }

  /** Stop all triggers and clear all timers. Safe to call multiple times. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    for (const reg of this.registrations.values()) reg.stop();
    this.registrations.clear();
  }

  /** Rescan definitions and re-register. Call after a definition changes. */
  reload(): void {
    if (!this.running) return;
    this.stop();
    this.start();
  }

  /** Reload a single workflow's triggers (add/update/remove). */
  reloadWorkflow(workflowId: string): void {
    for (const [k, reg] of this.registrations) {
      if (reg.workflowId === workflowId) {
        reg.stop();
        this.registrations.delete(k);
      }
    }
    const wf = this.definitions.get(workflowId);
    if (wf && wf.status === 'ready') this.registerTriggers(wf);
  }

  /** How many triggers are currently registered. */
  get activeCount(): number {
    return this.registrations.size;
  }

  /* ── internal ─────────────────────────────────────────────────── */

  private registerAll(): void {
    for (const summary of this.definitions.list()) {
      const wf = this.definitions.get(summary.id);
      if (wf && wf.status === 'ready') this.registerTriggers(wf);
    }
  }

  private registerTriggers(wf: WorkflowDefinition): void {
    for (const node of wf.nodes) {
      if (!isTriggerNode(node)) continue;
      if (node.type === 'manual') continue;
      if (node.config.enabled === false) continue;
      this.registerOne(wf, node);
    }
  }

  private registerOne(wf: WorkflowDefinition, node: WorkflowNode): void {
    const key = `${wf.id}:${node.id}`;
    if (this.registrations.has(key)) return;
    const triggerType = node.type as TriggerType;

    if (triggerType === 'schedule') {
      const stop = this.registerSchedule(wf, node);
      this.registrations.set(key, { workflowId: wf.id, triggerNodeId: node.id, triggerType: 'schedule', stop });
      return;
    }

    const source = this.eventSources[triggerType];
    if (!source) return;
    const stop = source.start(node.config as TriggerNodeConfig, {
      workflowId: wf.id,
      triggerNodeId: node.id,
      projectId: wf.projectId,
      fire: (payload?: unknown) => this.handleFire(wf.id, node.id, triggerType, payload),
    });
    this.registrations.set(key, { workflowId: wf.id, triggerNodeId: node.id, triggerType, stop });
  }

  private registerSchedule(wf: WorkflowDefinition, node: WorkflowNode): () => void {
    const cron = typeof node.config.cron === 'string' ? node.config.cron : '';
    const timezone = typeof node.config.timezone === 'string' && node.config.timezone.trim() ? node.config.timezone.trim() : undefined;
    const parsed = parseCron(cron);
    if (!parsed) return () => {};
    let stopped = false;
    let timer: { clear(): void } | null = null;
    const scheduleNext = () => {
      if (stopped || !this.running) return;
      const next = timezone ? nextFire(parsed, this.now(), timezone) : nextFire(parsed, this.now());
      if (!next) return;
      const delay = Math.max(0, next.getTime() - this.now().getTime());
      timer = this.timer(() => {
        this.handleFire(wf.id, node.id, 'schedule', { cron, next: next.toISOString(), timezone: timezone ?? null });
        scheduleNext();
      }, delay);
    };
    scheduleNext();
    return () => {
      stopped = true;
      timer?.clear();
    };
  }

  private handleFire(workflowId: string, _triggerNodeId: string, triggerType: TriggerType, payload: unknown): void {
    if (!this.running) return;
    const wf = this.definitions.get(workflowId);
    if (!wf || wf.status !== 'ready') return;

    if (wf.settings.singleFlight && this.hasActiveRun(workflowId)) {
      return;
    }

    const invocation: TriggerInvocation = {
      type: triggerType,
      payload,
      at: new Date().toISOString(),
    };

    void this.runtime.startRun(workflowId, {
      trigger: invocation,
      projectId: wf.projectId ?? undefined,
    }).catch(() => {
      // A failed trigger start is an auditable failure — the run record
      // itself (if created) carries the error. Swallowing here prevents
      // an unhandled rejection from crashing the scheduler.
    });
  }

  private hasActiveRun(workflowId: string): boolean {
    const summaries = this.runs.list(workflowId, { limit: 100 });
    return summaries.some((s) => s.status === 'running' || s.status === 'paused' || s.status === 'queued');
  }

  /** True if the scheduler is currently running. */
  get isRunning(): boolean {
    return this.running;
  }
}

/** Is this node a trigger type? */
function isTriggerNode(node: WorkflowNode): boolean {
  return node.type === 'manual' || node.type === 'schedule' || node.type === 'git-event'
    || node.type === 'file-change' || node.type === 'mission-event'
    || node.type === 'agent-event' || node.type === 'environment-event';
}
