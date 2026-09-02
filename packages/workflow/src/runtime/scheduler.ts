/**
 * The run controller — graph scheduling, delivery and persistence.
 * ==================================================================
 * One RunController per live WorkflowRun. It owns:
 *
 *   - node-run state (one WorkflowNodeRun per definition node),
 *   - edge delivery (pending / data / skip / fail marks),
 *   - the drain loop (deterministic, one ready node at a time),
 *   - capture sessions for iteration control nodes (loop / for-each /
 *     retry / timeout / parallel run their subtrees through nested
 *     drains; only retry and timeout capture failures),
 *   - rebuild from a persisted run (restart / resume).
 *
 * The controller never decides policy and never executes anything
 * itself: every governed effect is a Fabric invocation made by the
 * node executors, and every settle is persisted through the run store.
 *
 * Failure semantics (§Phase 5 §9): a node ends in success, failed,
 * skipped, paused or approval-required. A failed node marks all its
 * outgoing edges as failed; a downstream node whose required input
 * carries a failure mark is skipped (it never executes), unless the
 * workflow explicitly defines a failure path (retry.failed,
 * timeout.timed-out, condition/switch ports, approval.rejected) —
 * those are ordinary ports that carry data.
 */

import type { WorkflowDefinition, WorkflowEdge, WorkflowNode, WorkflowNodeRun, WorkflowRun } from '../types';
import type { RuntimeHost } from './types';
import { executeNode, redactRecord, type CaptureSession, type NodeExecutionContext, type NodeExecutionResult } from './executors';
import { buildScope, primaryInput, unwrapFired } from './scope';

/** Per-edge delivery. `data` carries a value; `skip` is a normal branch
 *  exclusion; `fail` means the upstream ended failed. */
export type EdgeState = { kind: 'pending' } | { kind: 'data'; value: unknown } | { kind: 'skip' } | { kind: 'fail' };

export interface ControllerHooks {
  persist(run: WorkflowRun): void;
  emit(event: { type: string; runId: string; nodeId?: string; status?: string; at: string }): void;
  onTerminal(run: WorkflowRun): void;
}

const MAX_TOTAL_EXECUTIONS = 1000;

export type TriggerFire = { nodeId: string | null; payload: unknown };

export class RunController {
  run: WorkflowRun;
  private wf: WorkflowDefinition;
  private host: RuntimeHost;
  private hooks: ControllerHooks;

  private nodeOrder = new Map<string, number>();
  private outEdges = new Map<string, Map<string, WorkflowEdge[]>>();
  private inEdges = new Map<string, WorkflowEdge[]>();
  private nodeRuns = new Map<string, WorkflowNodeRun>();
  private edgeState = new Map<string, EdgeState>();
  private activeCapture: { node: WorkflowNode; subtree: Set<string> } | null = null;
  private cancelled = false;
  private totalExecutions = 0;
  private triggerPayload: unknown;
  private approvedCapabilities: string[] | undefined;

  constructor(run: WorkflowRun, wf: WorkflowDefinition, host: RuntimeHost, hooks: ControllerHooks, opts: { triggerPayload?: unknown; approvedCapabilities?: string[] } = {}) {
    this.run = run;
    this.wf = wf;
    this.host = host;
    this.hooks = hooks;
    this.triggerPayload = opts.triggerPayload;
    this.approvedCapabilities = opts.approvedCapabilities;

    wf.nodes.forEach((n, i) => this.nodeOrder.set(n.id, i));
    for (const e of wf.edges) {
      const fromPorts = this.outEdges.get(e.from) ?? new Map<string, WorkflowEdge[]>();
      const list = fromPorts.get(e.fromPort) ?? [];
      list.push(e);
      fromPorts.set(e.fromPort, list);
      this.outEdges.set(e.from, fromPorts);
      const inList = this.inEdges.get(e.to) ?? [];
      inList.push(e);
      this.inEdges.set(e.to, inList);
      this.edgeState.set(e.id, { kind: 'pending' });
    }
  }

  /* ── node run bookkeeping ─────────────────────────────────────── */

  private freshNodeRun(node: WorkflowNode): WorkflowNodeRun {
    return { nodeId: node.id, status: 'waiting', attempts: 0, logs: [], auditIds: [] };
  }

  ensureNodeRuns(): void {
    if (this.nodeRuns.size) return;
    for (const n of this.wf.nodes) {
      const existing = this.run.nodeRuns.find((nr) => nr.nodeId === n.id);
      this.nodeRuns.set(n.id, existing ?? this.freshNodeRun(n));
    }
  }

  private syncRunRecord(): void {
    this.run.nodeRuns = [...this.nodeRuns.values()];
  }

  private log(nodeId: string, level: 'info' | 'warn' | 'error', text: string): void {
    const nr = this.nodeRuns.get(nodeId);
    if (!nr) return;
    nr.logs.push({ at: new Date().toISOString(), level, text });
    if (nr.logs.length > 200) nr.logs.splice(0, nr.logs.length - 200);
  }

  /* ── rebuild from a persisted run (restart / resume) ───────────── */

  rebuild(): void {
    this.ensureNodeRuns();
    for (const nr of this.nodeRuns.values()) {
      switch (nr.status) {
        case 'success': {
          // settleNode wraps fired values as { value }; unwrap for delivery.
          const fired = nr.firedPort ? unwrapFired(nr.outputs) : undefined;
          this.markNodeEdges(nr.nodeId, nr.firedPort ? 'data' : 'skip', fired);
          break;
        }
        case 'failed':
          this.markNodeEdges(nr.nodeId, 'fail', undefined);
          break;
        case 'skipped':
          this.markNodeEdges(nr.nodeId, 'skip', undefined);
          break;
        default:
          // waiting / running / approval-required / paused: nothing fired.
          if (nr.status === 'running') this.resetNodeRun(nr.nodeId);
          break;
      }
    }
  }

  private resetNodeRun(nodeId: string): void {
    const nr = this.nodeRuns.get(nodeId);
    if (!nr) return;
    nr.status = 'waiting';
    delete nr.firedPort;
    delete nr.inputs;
    delete nr.outputs;
    delete nr.error;
    delete nr.ms;
    delete nr.finishedAt;
    delete nr.policy;
    delete nr.approval;
  }

  private markNodeEdges(nodeId: string, kind: 'data' | 'skip' | 'fail', value: unknown): void {
    const perPort = this.outEdges.get(nodeId);
    if (!perPort) return;
    for (const edges of perPort.values()) {
      for (const e of edges) {
        this.edgeState.set(e.id, kind === 'data' ? { kind, value } : { kind });
      }
    }
  }

  /* ── the drain ─────────────────────────────────────────────────── */

  private readyNodes(subtree?: Set<string>): WorkflowNode[] {
    const out: WorkflowNode[] = [];
    for (const n of this.wf.nodes) {
      if (subtree && !subtree.has(n.id)) continue;
      const nr = this.nodeRuns.get(n.id);
      if (!nr || nr.status !== 'waiting') continue;
      const inEdges = this.inEdges.get(n.id) ?? [];
      if (inEdges.some((e) => this.edgeState.get(e.id)?.kind === 'pending')) continue;
      if (inEdges.some((e) => this.edgeState.get(e.id)?.kind === 'fail')) {
        // A failed upstream never delivers: this node is skipped, and
        // the skip cascades. It never executes.
        this.markSkipped(n.id);
        continue;
      }
      if (inEdges.length && inEdges.every((e) => this.edgeState.get(e.id)?.kind === 'skip')) {
        this.markSkipped(n.id);
        continue;
      }
      out.push(n);
    }
    return out.sort((a, b) => (this.nodeOrder.get(a.id) ?? 0) - (this.nodeOrder.get(b.id) ?? 0));
  }

  private markSkipped(nodeId: string): void {
    const nr = this.nodeRuns.get(nodeId);
    if (!nr || nr.status !== 'waiting') return;
    nr.status = 'skipped';
    this.markNodeEdges(nodeId, 'skip', undefined);
  }

  private deliveredInputs(node: WorkflowNode): Record<string, unknown> {
    const delivered: Record<string, unknown> = {};
    const inEdges = this.inEdges.get(node.id) ?? [];
    for (const e of inEdges) {
      const state = this.edgeState.get(e.id);
      if (state?.kind !== 'data') continue;
      const existing = delivered[e.toPort];
      if (existing === undefined) {
        delivered[e.toPort] = state.value;
      } else if (Array.isArray(existing)) {
        existing.push(state.value);
      } else {
        delivered[e.toPort] = [existing, state.value];
      }
    }
    return delivered;
  }

  private runScopeFor(node: WorkflowNode, delivered: Record<string, unknown>): Record<string, unknown> {
    const scope = buildScope(
      this.wf,
      this.nodeRuns,
      this.triggerPayload,
      redactRecord(this.run.inputs),
      { runId: this.run.runId, status: this.run.status, workflowId: this.run.workflowId, workflowVersion: this.run.workflowVersion, projectId: this.run.projectId, startedAt: this.run.startedAt, triggerId: this.run.triggerId },
    );
    scope.input = primaryInput(delivered);
    void node;
    return scope;
  }

  private settleNode(node: WorkflowNode, nr: WorkflowNodeRun, result: NodeExecutionResult): void {
    const now = new Date().toISOString();
    switch (result.kind) {
      case 'fire': {
        nr.status = 'success';
        nr.firedPort = result.port;
        nr.outputs = redactRecord({ value: result.value });
        nr.finishedAt = now;
        break;
      }
      case 'done':
        nr.status = 'success';
        nr.finishedAt = now;
        break;
      case 'fail':
        nr.status = 'failed';
        nr.error = result.error;
        nr.finishedAt = now;
        this.log(node.id, 'error', result.error);
        break;
      case 'approval-required':
        nr.status = 'approval-required';
        nr.approval = { requestId: result.requestId, state: 'pending' };
        this.log(node.id, 'info', `waiting on human approval (${result.requestId})`);
        break;
      case 'paused':
        nr.status = 'paused';
        this.log(node.id, 'info', result.reason);
        break;
    }
    if (nr.startedAt && nr.finishedAt) nr.ms = Date.parse(nr.finishedAt) - Date.parse(nr.startedAt);
  }

  /** Apply the settled outcome to the node and its outgoing edges. */
  private applyResult(node: WorkflowNode, result: NodeExecutionResult): void {
    const nr = this.nodeRuns.get(node.id)!;
    this.settleNode(node, nr, result);
    if (result.kind === 'fire') {
      this.deliver(node.id, result.port, result.value);
    } else if (result.kind === 'done') {
      this.markNodeEdges(node.id, 'skip', undefined);
    } else if (result.kind === 'fail') {
      this.markNodeEdges(node.id, 'fail', undefined);
    }
    // approval-required / paused: nothing fired, edges stay pending.
  }

  deliver(nodeId: string, port: string, value: unknown): void {
    const perPort = this.outEdges.get(nodeId);
    if (!perPort) return;
    const edges = perPort.get(port) ?? [];
    for (const e of edges) this.edgeState.set(e.id, { kind: 'data', value });
  }

  /** A captured subtree: all nodes reachable through the iteration
   *  ports of a control node. Terminal ports (done/failed/timed-out/
   *  all) are never starting points, so their branches are untouched
   *  by iteration resets. */
  private subtreeOf(node: WorkflowNode, iterationPorts: string[]): Set<string> {
    const subtree = new Set<string>();
    const queue: string[] = [];
    for (const port of iterationPorts) {
      for (const e of this.outEdges.get(node.id)?.get(port) ?? []) queue.push(e.to);
    }
    while (queue.length) {
      const id = queue.shift()!;
      if (subtree.has(id)) continue;
      subtree.add(id);
      const perPort = this.outEdges.get(id);
      if (!perPort) continue;
      for (const edges of perPort.values()) {
        for (const e of edges) queue.push(e.to);
      }
    }
    return subtree;
  }

  private resetSubtree(node: WorkflowNode, iterationPorts: string[], subtree: Set<string>): void {
    for (const id of subtree) this.resetNodeRun(id);
    for (const e of this.wf.edges) {
      if (subtree.has(e.from) || (e.from === node.id && iterationPorts.includes(e.fromPort))) {
        this.edgeState.set(e.id, { kind: 'pending' });
      }
    }
  }

  private captureSession(node: WorkflowNode, iterationPorts: string[]): CaptureSession {
    const subtree = this.subtreeOf(node, iterationPorts);
    return {
      subtree,
      reset: () => this.resetSubtree(node, iterationPorts, subtree),
    };
  }

  private sleep(ms: number): Promise<void> {
    if (this.host.sleep) return this.host.sleep(ms);
    return new Promise((r) => setTimeout(r, ms));
  }

  /* ── the execution loops ───────────────────────────────────────── */

  /**
   * Execute one ready node through the executors. Returns the node
   * outcome, or throws nothing: every failure is an outcome.
   */
  private async executeOne(node: WorkflowNode): Promise<NodeExecutionResult> {
    this.totalExecutions += 1;
    if (this.totalExecutions > MAX_TOTAL_EXECUTIONS) {
      return { kind: 'fail', error: `run exceeded the execution budget (${MAX_TOTAL_EXECUTIONS} node executions)` };
    }
    const nr = this.nodeRuns.get(node.id)!;
    nr.status = 'running';
    nr.startedAt = new Date().toISOString();
    nr.attempts = Math.max(1, nr.attempts);
    this.hooks.persist(this.run);

    const delivered = this.deliveredInputs(node);
    const ctx: NodeExecutionContext = {
      wf: this.wf,
      run: this.run,
      node,
      nodeRun: nr,
      scope: this.runScopeFor(node, delivered),
      delivered,
      host: this.host,
      approvedCapabilities: this.approvedCapabilities,
      isCancelled: () => this.cancelled,
      log: (level, text) => this.log(node.id, level, text),
      sleep: (ms) => this.sleep(ms),
      capture: (n, ports) => {
        const session = this.captureSession(n, ports);
        this.activeCapture = { node: n, subtree: session.subtree };
        return session;
      },
      deliver: (nodeId, port, value) => this.deliver(nodeId, port, value),
      drainCapture: () => this.drainCapture(),
      pendingApprovalForInvocation: (invocationId) => {
        for (const request of this.host.fabric.pendingApprovals()) {
          if (request.items[0]?.invocationId === invocationId) return request.id;
        }
        return undefined;
      },
      notify: (message) => this.host.notify?.({ runId: this.run.runId, nodeId: node.id, message }),
      recordResult: (value) => {
        this.run.outputs[node.id] = value && typeof value === 'object' && !Array.isArray(value)
          ? redactRecord(value as Record<string, unknown>)
          : value;
      },
    };

    try {
      const result = await executeNode(ctx);
      this.activeCapture = null;
      return result;
    } catch (error) {
      this.activeCapture = null;
      return { kind: 'fail', error: (error as Error).message || 'node execution threw' };
    }
  }

  /**
   * Drain ready nodes until quiescent. `capture` limits scheduling to
   * the active iteration subtree and reports failures instead of
   * failing the run — the retry/timeout control nodes own that call.
   */
  private async drainCapture(): Promise<{ ok: true } | { ok: false; failedNodeId: string; error: string; irreversibleEffect?: boolean }> {
    const subtree = this.activeCapture?.subtree;
    for (;;) {
      if (this.cancelled) return { ok: false, failedNodeId: '', error: 'cancelled' };
      const ready = this.readyNodes(subtree);
      if (!ready.length) return { ok: true };
      for (const node of ready) {
        const result = await this.executeOne(node);
        this.applyResult(node, result);
        this.syncRunRecord();
        this.hooks.persist(this.run);
        this.hooks.emit({ type: 'node-settled', runId: this.run.runId, nodeId: node.id, status: this.nodeRuns.get(node.id)?.status, at: new Date().toISOString() });
        if (result.kind === 'fail') {
          return { ok: false, failedNodeId: node.id, error: result.error, irreversibleEffect: result.irreversibleEffect };
        }
        if (result.kind === 'approval-required' || result.kind === 'paused') {
          if (subtree) {
            // A captured subtree can't proceed past a gate.
            this.run.status = 'paused';
            this.syncRunRecord();
            this.hooks.persist(this.run);
            return { ok: true };
          }
          // Main drain: the parked node is no longer 'waiting', so it
          // won't be re-picked. Continue with other independent branches.
        }
        if (this.cancelled) return { ok: false, failedNodeId: '', error: 'cancelled' };
      }
    }
  }

  /** Drive the run to a terminal or paused state. */
  async drain(): Promise<void> {
    if (this.run.status === 'queued' || this.run.status === 'paused') {
      this.run.status = 'running';
      this.hooks.persist(this.run);
    }
    this.ensureNodeRuns();
    this.fireTriggers();
    this.markUnreachableSkipped();
    this.syncRunRecord();
    this.hooks.persist(this.run);

    const out = await this.drainCapture();
    if (this.cancelled) {
      this.markDeadEndsSkipped();
      this.run.status = 'cancelled';
      this.run.finishedAt = new Date().toISOString();
      this.syncRunRecord();
      this.hooks.persist(this.run);
      this.hooks.emit({ type: 'run-settled', runId: this.run.runId, status: 'cancelled', at: this.run.finishedAt });
      this.hooks.onTerminal(this.run);
      return;
    }
    if (!out.ok) {
      this.markDeadEndsSkipped();
      this.run.status = 'failed';
      this.run.error = out.error;
      this.run.finishedAt = new Date().toISOString();
      this.syncRunRecord();
      this.hooks.persist(this.run);
      this.hooks.emit({ type: 'run-settled', runId: this.run.runId, status: 'failed', at: this.run.finishedAt });
      this.hooks.onTerminal(this.run);
      return;
    }
    // An approval denial (or other out-of-band failure) may have set a
    // node to 'failed' without drainCapture seeing a live execution
    // failure. Detect it here so the run settles as failed, not completed.
    const failedNode = [...this.nodeRuns.values()].find((nr) => nr.status === 'failed');
    if (failedNode) {
      this.markDeadEndsSkipped();
      this.run.status = 'failed';
      this.run.error = failedNode.error ?? 'a workflow node failed';
      this.run.finishedAt = new Date().toISOString();
      this.syncRunRecord();
      this.hooks.persist(this.run);
      this.hooks.emit({ type: 'run-settled', runId: this.run.runId, status: 'failed', at: this.run.finishedAt });
      this.hooks.onTerminal(this.run);
      return;
    }
    this.run.status = this.hasActiveGate() ? 'paused' : 'completed';
    this.run.finishedAt = new Date().toISOString();
    // Only terminal runs mark dead ends — a paused run's waiting nodes
    // may still fire after an approval event.
    if (this.run.status !== 'paused') this.markDeadEndsSkipped();
    this.syncRunRecord();
    this.hooks.persist(this.run);
    this.hooks.emit({ type: 'run-settled', runId: this.run.runId, status: this.run.status, at: this.run.finishedAt });
    if (this.run.status !== 'paused') this.hooks.onTerminal(this.run);
  }

  private hasActiveGate(): boolean {
    for (const nr of this.nodeRuns.values()) {
      if (nr.status === 'approval-required' || nr.status === 'paused') return true;
    }
    return false;
  }

  /** Terminal runs: anything still waiting will never fire — record it
   *  as skipped rather than as an abandoned waiting node. Only called
   *  on terminal states (completed/failed/cancelled), never on paused. */
  private markDeadEndsSkipped(): void {
    for (const n of this.wf.nodes) {
      const nr = this.nodeRuns.get(n.id);
      if (!nr || nr.status !== 'waiting') continue;
      const inEdges = this.inEdges.get(n.id) ?? [];
      if (!inEdges.length) continue;
      this.markSkipped(n.id);
    }
  }

  /* ── pre-passes ────────────────────────────────────────────────── */

  private fireTriggers(): void {
    for (const n of this.wf.nodes) {
      if (!this.isTrigger(n)) continue;
      const nr = this.nodeRuns.get(n.id)!;
      if (n.id === this.run.triggerId) {
        nr.status = 'success';
        nr.firedPort = 'out';
        nr.outputs = redactRecord({ value: this.triggerPayload });
        nr.startedAt = this.run.startedAt;
        nr.finishedAt = new Date().toISOString();
        this.deliver(n.id, 'out', this.triggerPayload);
      } else {
        nr.status = 'skipped';
        this.markNodeEdges(n.id, 'skip', undefined);
      }
    }
  }

  private markUnreachableSkipped(): void {
    const reachable = new Set<string>();
    const queue: string[] = [];
    for (const n of this.wf.nodes) {
      if ((this.inEdges.get(n.id) ?? []).length === 0) queue.push(n.id);
    }
    while (queue.length) {
      const id = queue.shift()!;
      if (reachable.has(id)) continue;
      reachable.add(id);
      for (const edges of this.outEdges.get(id)?.values() ?? []) {
        for (const e of edges) queue.push(e.to);
      }
    }
    for (const n of this.wf.nodes) {
      if (reachable.has(n.id)) continue;
      const nr = this.nodeRuns.get(n.id);
      if (nr && nr.status === 'waiting') {
        nr.status = 'skipped';
        this.markNodeEdges(n.id, 'skip', undefined);
      }
    }
  }

  private isTrigger(n: WorkflowNode): boolean {
    return n.type === 'manual' || n.type === 'schedule' || n.type === 'git-event' || n.type === 'file-change'
      || n.type === 'mission-event' || n.type === 'agent-event' || n.type === 'environment-event';
  }

  /* ── external control ──────────────────────────────────────────── */

  /** The approval node's human gate: fires approved/rejected branches. */
  resumeGate(nodeId: string, granted: boolean, decidedBy = 'human', reason?: string): void {
    const node = this.wf.nodes.find((n) => n.id === nodeId);
    const nr = node ? this.nodeRuns.get(nodeId) : undefined;
    if (!node || !nr || nr.status !== 'paused') return;
    const input = primaryInput(this.deliveredInputs(node));
    const now = new Date().toISOString();
    nr.approval = { requestId: nr.approval?.requestId ?? `wr:${this.run.runId}:${nodeId}`, state: granted ? 'granted' : 'denied', decidedAt: now, decidedBy };
    nr.status = 'success';
    nr.finishedAt = now;
    const port = granted ? 'approved' : 'rejected';
    nr.firedPort = port;
    nr.outputs = redactRecord({ value: input });
    this.deliver(nodeId, port, input);
    this.log(nodeId, 'info', `approval ${granted ? 'granted' : 'rejected'} by ${decidedBy}${reason ? `: ${reason}` : ''}`);
    this.syncRunRecord();
    this.hooks.persist(this.run);
  }

  /** A capability parked at the Fabric's approval gate — re-run the
   *  node; the Fabric spends the grant on the re-invocation. */
  resumeAfterApproval(requestId: string): boolean {
    for (const nr of this.nodeRuns.values()) {
      if (nr.status === 'approval-required' && nr.approval?.requestId === requestId) {
        nr.approval = { ...nr.approval, state: 'granted', decidedAt: new Date().toISOString() };
        nr.status = 'waiting';
        this.syncRunRecord();
        this.hooks.persist(this.run);
        return true;
      }
    }
    return false;
  }

  /** The Fabric's approval was denied: the node fails deterministically. */
  failApprovalNode(requestId: string): boolean {
    for (const nr of this.nodeRuns.values()) {
      if (nr.status === 'approval-required' && nr.approval?.requestId === requestId) {
        nr.status = 'failed';
        nr.error = 'approval denied by human';
        nr.finishedAt = new Date().toISOString();
        nr.approval = { ...nr.approval, state: 'denied' };
        this.markNodeEdges(nr.nodeId, 'fail', undefined);
        this.syncRunRecord();
        this.hooks.persist(this.run);
        return true;
      }
    }
    return false;
  }

  cancel(reason = 'cancelled by user'): void {
    this.cancelled = true;
    this.log('', 'info', reason);
  }
}

/** Pick the trigger node a run fires, or null for a manual run with no
 *  manual node. Non-selected triggers are skipped by the controller. */
export function pickTriggerNode(wf: WorkflowDefinition, triggerType: string, triggerId?: string): string | null {
  if (triggerId) return wf.nodes.find((n) => n.id === triggerId) ? triggerId : null;
  const nodes = wf.nodes.filter((n) => {
    if (n.type !== triggerType) return false;
    return n.config.enabled !== false;
  });
  return nodes[0]?.id ?? null;
}