/**
 * WorkflowRuntime — the Phase 5 orchestration facade.
 * ==================================================================
 * Loads and validates definitions, creates runs, drives them through
 * the RunController, and answers the events the world sends back:
 *
 *   startRun / resumeRun      — manual trigger + restart/resume
 *   decideApproval            — delegates to the FABRIC's own approval
 *                               store and decision path; the Fabric's
 *                               `approval.granted` / `approval.denied`
 *                               events resume or fail the parked node.
 *                               There is deliberately no second approval
 *                               system.
 *   resumeRunDecision         — the approval NODE's human gate.
 *   cancelRun                 — stops scheduling, bounds in-flight work
 *                               by the existing invocation timeouts.
 *
 * Persistence is the Phase 1+2 stores only: definitions in
 * `workflow-defs/`, runs in `workflow-runs/`. A process restart never
 * corrupts a run: paused runs resume from their persisted node runs,
 * and crashed in-flight nodes restart from the last settled frontier.
 */

import { CapabilityFabric } from '@aura/capability-fabric';
import type { WorkflowDefinition, WorkflowRun, WorkflowRunStatus } from '../types';
import { hasErrors, validateDefinition } from '../validate';
import type { WorkflowDefinitionStore } from '../definitionStore';
import type { WorkflowRunStore } from '../runStore';
import { newRun } from '../runStore';
import type { RunOptions, RuntimeEvent, RuntimeEventListener, RuntimeHost } from './types';
import { pickTriggerNode, RunController } from './scheduler';
import { redactRecord } from './executors';

export interface WorkflowRuntimeOptions {
  definitions: WorkflowDefinitionStore;
  runs: WorkflowRunStore;
  /** Subscribe to the Fabric's approval events; default true. */
  listenToFabric?: boolean;
}

export class WorkflowRuntime {
  private readonly definitions: WorkflowDefinitionStore;
  private readonly runs: WorkflowRunStore;
  private readonly host: RuntimeHost;
  private readonly controllers = new Map<string, RunController>();
  private readonly listeners = new Set<RuntimeEventListener>();
  private offFabric: (() => void) | null = null;
  private shutDown = false;

  constructor(host: RuntimeHost, opts: WorkflowRuntimeOptions) {
    this.host = host;
    this.definitions = opts.definitions;
    this.runs = opts.runs;
    if (opts.listenToFabric !== false) {
      this.offFabric = host.fabric.on((event) => {
        if (event.type === 'approval.granted' || event.type === 'approval.denied') {
          void this.handleApprovalEvent(event.requestId, event.type === 'approval.granted');
        }
      });
    }
  }

  /**
   * Ordered shutdown: reject new runs, stop listening for Fabric approval
   * events, and clear runtime listeners. Live controllers for paused runs
   * are released — their persisted records stay intact and resumable by a
   * fresh runtime. Idempotent.
   */
  shutdown(): void {
    if (this.shutDown) return;
    this.shutDown = true;
    this.offFabric?.();
    this.offFabric = null;
    this.listeners.clear();
    this.controllers.clear();
  }

  on(listener: RuntimeEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: RuntimeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // listener errors are not the runtime's problem
      }
    }
  }

  private persist(run: WorkflowRun): void {
    this.runs.record(run);
  }

  private hooksFor() {
    return {
      persist: (run: WorkflowRun) => this.persist(run),
      emit: (event: { type: string; runId: string; nodeId?: string; status?: string; at: string }) => {
        if (event.type === 'node-settled' && event.nodeId) {
          this.emit({ type: 'node-settled', runId: event.runId, nodeId: event.nodeId, status: (event.status ?? 'waiting') as never, at: event.at });
        } else if (event.type === 'run-settled') {
          this.emit({ type: 'run-settled', runId: event.runId, status: event.status as WorkflowRunStatus, at: event.at });
        }
      },
      onTerminal: (run: WorkflowRun) => {
        this.controllers.delete(run.runId);
      },
    };
  }

  /* ── starting runs ─────────────────────────────────────────────── */

  /**
   * Load a ready definition and run it. Throws on an unknown,
   * unready or invalid definition — the runnable contract is `ready`
   * and clean.
   */
  async startRun(workflowId: string, options: RunOptions = {}): Promise<WorkflowRun> {
    if (this.shutDown) throw new Error('workflow runtime is shut down — no new runs are accepted');
    const wf = this.definitions.get(workflowId);
    if (!wf) throw new Error(`no workflow definition "${workflowId}"`);
    if (wf.status !== 'ready') throw new Error(`workflow "${wf.id}" is not ready to run`);
    const issues = validateDefinition(wf, { knownCapabilities: this.definitions.knownCapabilities });
    if (hasErrors(issues)) throw new Error(`workflow "${wf.id}" is not valid: ${issues.find((i) => i.severity === 'error')?.message}`);
    return this.runDefinition(wf, options);
  }

  /** Run an already-loaded definition (embedding, tests). */
  async runDefinition(wf: WorkflowDefinition, options: RunOptions = {}): Promise<WorkflowRun> {
    const trigger = options.trigger ?? { type: 'manual' };
    const triggerId = pickTriggerNode(wf, trigger.type);
    const projectId = options.projectId !== undefined ? options.projectId : (wf.projectId ?? null);
    const run = newRun({
      workflowId: wf.id,
      workflowVersion: wf.version,
      projectId,
      triggerId,
      inputs: redactRecord(options.inputs ?? {}),
    });
    const controller = new RunController(run, wf, this.host, this.hooksFor(), {
      triggerPayload: trigger.payload ?? options.inputs ?? {},
      approvedCapabilities: options.approvedCapabilities,
    });
    this.controllers.set(run.runId, controller);
    this.persist(run);
    this.emit({ type: 'run-started', runId: run.runId, at: new Date().toISOString() });
    await controller.drain();
    return run;
  }

  /* ── resume / restart ──────────────────────────────────────────── */

  /**
   * Continue a paused or interrupted run. Paused (gate/approval) runs
   * resume exactly; crashed in-flight nodes restart from the last
   * settled frontier. Returns the run as it stands after the drain.
   */
  async resumeRun(runId: string): Promise<WorkflowRun | null> {
    const existing = this.controllers.get(runId);
    if (existing) {
      await existing.drain();
      return existing.run;
    }
    const found = this.findRun(runId);
    if (!found) return null;
    if (found.status === 'completed' || found.status === 'failed' || found.status === 'cancelled') return found;
    const wf = this.definitions.get(found.workflowId);
    if (!wf) return found;
    const controller = new RunController(found, wf, this.host, this.hooksFor(), {
      triggerPayload: found.inputs,
    });
    controller.rebuild();
    this.controllers.set(runId, controller);
    await controller.drain();
    return found;
  }

  private findRun(runId: string): WorkflowRun | null {
    for (const controller of this.controllers.values()) {
      if (controller.run.runId === runId) return controller.run;
    }
    const summaries = this.runs.list(undefined, { limit: 1000 });
    for (const s of summaries) {
      if (s.runId !== runId) continue;
      return this.runs.get(s.workflowId, runId);
    }
    return null;
  }

  /**
   * True when a live controller is driving this run in THIS process.
   * Distinct from `getRun`, which also answers for persisted runs — the
   * crash-recovery path needs to tell a live run from a stale record.
   */
  hasLiveController(runId: string): boolean {
    return this.controllers.has(runId);
  }

  /* ── approval — via the FABRIC's own mechanism ─────────────────── */

  /**
   * Record a human's decision on a Fabric approval request. Delegates
   * to `fabric.decideApproval`; the resulting `approval.granted` /
   * `approval.denied` event resumes or fails the parked node. Returns
   * null when the request is unknown or already decided.
   */
  decideApproval(requestId: string, granted: boolean, decidedBy = 'user', reason?: string): ReturnType<CapabilityFabric['decideApproval']> {
    return this.host.fabric.decideApproval(requestId, granted, decidedBy, reason);
  }

  private async handleApprovalEvent(requestId: string, granted: boolean): Promise<void> {
    const runId = this.runIdForApproval(requestId);
    if (!runId) return;
    const controller = this.controllers.get(runId) ?? await this.controllerForStoredRun(runId);
    if (!controller) return;
    if (granted) {
      if (controller.resumeAfterApproval(requestId)) await controller.drain();
    } else {
      if (controller.failApprovalNode(requestId)) await controller.drain();
    }
  }

  private runIdForApproval(requestId: string): string | null {
    for (const controller of this.controllers.values()) {
      for (const nr of controller.run.nodeRuns) {
        if (nr.status === 'approval-required' && nr.approval?.requestId === requestId) return controller.run.runId;
      }
    }
    // A restarted runtime has no live controllers: the parked request
    // lives in the run store. Bound the scan like the run list.
    for (const summary of this.runs.list(undefined, { limit: 1000 })) {
      const run = this.runs.get(summary.workflowId, summary.runId);
      if (run?.nodeRuns.some((nr) => nr.status === 'approval-required' && nr.approval?.requestId === requestId)) return run.runId;
    }
    return null;
  }

  private async controllerForStoredRun(runId: string): Promise<RunController | null> {
    const found = this.findRun(runId);
    if (!found || (found.status !== 'paused' && found.status !== 'running')) return null;
    const wf = this.definitions.get(found.workflowId);
    if (!wf) return null;
    const controller = new RunController(found, wf, this.host, this.hooksFor(), { triggerPayload: found.inputs });
    controller.rebuild();
    this.controllers.set(runId, controller);
    return controller;
  }

  /* ── the approval node's human gate ────────────────────────────── */

  /** Decide the approval NODE's gate; fires approved/rejected branches. */
  async resumeRunDecision(runId: string, nodeId: string, granted: boolean, decidedBy = 'human', reason?: string): Promise<WorkflowRun | null> {
    const controller = this.controllers.get(runId) ?? await this.controllerForStoredRun(runId);
    if (!controller) return null;
    controller.resumeGate(nodeId, granted, decidedBy, reason);
    await controller.drain();
    return controller.run;
  }

  /* ── cancellation ──────────────────────────────────────────────── */

  /**
   * Stop scheduling new nodes and settle the run as cancelled. An
   * in-flight invocation cannot be aborted by the Fabric (no signal on
   * the invocation context) — it settles within its own bounded
   * timeout, then the run is cancelled. No orphan execution: the
   * invocation is still governed and audited.
   */
  async cancelRun(runId: string): Promise<WorkflowRun | null> {
    const controller = this.controllers.get(runId) ?? await this.controllerForStoredRun(runId);
    if (!controller) return null;
    controller.cancel();
    await controller.drain();
    return controller.run;
  }

  /* ── reads ─────────────────────────────────────────────────────── */

  getRun(runId: string): WorkflowRun | null {
    return this.findRun(runId);
  }

  listRuns(workflowId?: string, opts?: { limit?: number }) {
    return this.runs.list(workflowId, opts);
  }

  getDefinition(workflowId: string): WorkflowDefinition | null {
    return this.definitions.get(workflowId);
  }
}