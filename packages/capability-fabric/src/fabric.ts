/**
 * fabric — the one governed path to a side effect.
 * ==================================================================
 * Every call follows the same seven steps, in this order, with no way to
 * skip one:
 *
 *   resolve → policy → approval → execute → verify → recover → audit
 *
 * Nothing in AURA should cause an external effect except through here.
 * That is not yet true of the whole repository (there are pre-existing
 * direct spawn sites — see docs/CAPABILITY_FABRIC.md §Limitations), and
 * saying so plainly is part of the design rather than an omission.
 *
 * The Fabric owns no missions and no schedule. `missionId`/`taskId` on a
 * context are correlation keys into the authoritative `MissionRecord`,
 * used for the audit trail and nothing else.
 */

import { createHash } from 'node:crypto';
import type {
  ApprovalPersistence,
  ApprovalRequest,
  AuditPersistence,
  AuditRecord,
  CapabilityDescriptor,
  Executor,
  FabricEvent,
  FabricEventListener,
  Invocation,
  InvocationContext,
  InvocationResult,
  NodeRef,
  NodeResolution,
  PolicyConfig,
  PolicyEvaluation,
  VerificationReport,
} from './types';
import { describeFabricCapability } from './manifest';
import { DEFAULT_POLICY, evaluatePolicy, grantsFor } from './policy';

/* ── recovery bounds (§16) ──────────────────────────────────────── */

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 400;

/**
 * Only these failures are worth retrying. Anything else escalates
 * immediately — retrying a permission error or a bad argument three
 * times is noise, not resilience.
 */
function isTransient(detail: string): boolean {
  return /\b(timeout|timed out|ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND|socket hang up|429|503|temporarily)\b/i.test(detail);
}

/* ── host wiring ────────────────────────────────────────────────── */

export interface FabricHost {
  /**
   * Permissions the acting node holds for this invocation. The host
   * resolves which node is acting; the Fabric only asks what it may do.
   */
  permissionsFor(capability: CapabilityDescriptor, context: InvocationContext): {
    read: boolean; write: boolean; execute: boolean; autonomous: boolean;
  };
  /**
   * Is the node capability this action needs currently provided?
   * `null` when the capability declares none.
   *
   * Retained for compatibility and still the input to the `no-provider`
   * floor. Hosts implementing `resolveNode` should derive this from it so
   * the two can never disagree.
   */
  nodeAvailable(capability: CapabilityDescriptor): boolean | null;
  /**
   * Which node should perform this, honouring `context.nodeId` when the
   * caller named one.
   *
   * Synchronous by design: it reads the last environment scan rather than
   * probing, so it can run inside the policy step without turning a
   * decision into an I/O wait. Optional — a host that omits it keeps the
   * old boolean-only behaviour.
   */
  resolveNode?(
    capability: CapabilityDescriptor,
    context: InvocationContext,
    /**
     * Whether the registered executor can actually drive a candidate.
     * Supplied by the Fabric so routing stays here while the knowledge of
     * what is drivable stays in the executor.
     */
    canUse?: (node: NodeRef) => boolean,
  ): NodeResolution;
  /**
   * Ask the human. The host owns the UI; the Fabric owns the record.
   * Resolves `true` on grant. A host with no UI should resolve `false`
   * rather than block — an unanswered gate is a denial, never a bypass.
   *
   * Receives the context so a host can honour a per-invocation grant
   * (`context.approvedCapabilities`) instead of holding approval state of
   * its own, which would let one approval leak into a later call.
   */
  requestApproval(request: ApprovalRequest, context: InvocationContext): Promise<boolean>;
}

/**
 * Identity of an exact invocation, for binding an approval to it.
 *
 * Deliberately a plain, deterministic digest and NOT a keyed MAC. There is
 * no secret this package could hold that an attacker able to edit AURA's
 * own files could not also read, so a MAC would buy authenticity it cannot
 * actually deliver. What this does buy is real: the authoritative
 * fingerprint lives on the approval record, which only the Fabric writes,
 * and it is compared against a fingerprint recomputed from whatever
 * arguments are presented at spend time. Tampering with the persisted call
 * changes the recomputed value and the grant stops matching.
 *
 * Included: the capability, every argument, and the two context fields
 * that decide WHERE an effect lands. Excluded: ids that vary between the
 * two legs of a resume by design — a resumed run has a new `runId`, and
 * requiring it to match would make every approval unusable.
 */
export function fingerprintInvocation(
  capabilityId: string,
  input: Record<string, unknown>,
  context: Pick<InvocationContext, 'projectId' | 'cwd' | 'workflowId' | 'workflowNodeId'>,
): string {
  const canonical = JSON.stringify({
    capabilityId,
    // Sorted so an argument object rebuilt in a different key order is the
    // same call, while a changed VALUE is a different one.
    input: Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b))),
    projectId: context.projectId ?? null,
    cwd: context.cwd ?? null,
    workflowId: context.workflowId ?? null,
    workflowNodeId: context.workflowNodeId ?? null,
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

let seq = 0;
function invocationId(): string {
  seq += 1;
  return `inv${Date.now().toString(36)}${seq}`;
}

/** Bounded, redacted input summary for the audit record. */
function summarizeInput(capability: CapabilityDescriptor, input: Record<string, unknown>): string {
  const SECRET = /^(apiKey|token|secret|password)$/i;
  const parts: string[] = [];
  for (const field of capability.input) {
    const raw = input[field.name];
    if (raw === undefined) continue;
    if (SECRET.test(field.name)) {
      parts.push(`${field.name}=<redacted>`);
      continue;
    }
    const text = String(raw);
    parts.push(`${field.name}=${text.length > 60 ? `${text.slice(0, 57)}…` : text}`);
  }
  return parts.join(' ') || '(no arguments)';
}


/** Reject arguments that do not satisfy the declared contract. */
function validate(capability: CapabilityDescriptor, input: Record<string, unknown>): string | null {
  for (const field of capability.input) {
    const value = input[field.name];
    if (value === undefined || value === null || value === '') {
      if (field.required) return `${field.name} is required.`;
      continue;
    }
    const actual = Array.isArray(value) ? 'string[]' : typeof value;
    if (field.type === 'string[]' ? actual !== 'string[]' : actual !== field.type) {
      return `${field.name} should be a ${field.type}, got ${actual}.`;
    }
  }
  return null;
}

const NO_VERIFICATION: VerificationReport = {
  passed: null,
  kind: null,
  detail: 'This action has no mechanical check, so success is reported from the executor alone.',
};

export class CapabilityFabric {
  private executors = new Map<string, Executor>();
  private listeners = new Set<FabricEventListener>();
  private auditLog: AuditRecord[] = [];
  private policy: PolicyConfig = DEFAULT_POLICY;

  /**
   * Live authorization requests, keyed by `approvalKey()`.
   *
   * The Fabric already *built* an `ApprovalRequest` on every gated
   * invocation and then dropped it, which meant nothing could show a user
   * what they were being asked, and every retry of the same task minted a
   * fresh request. Retaining them here fixes both, and introduces no new
   * approval model: this is the same `ApprovalRequest` that already
   * carried `state`, `decidedBy`, `decidedAt` and `consumedAt`.
   */
  private approvals = new Map<string, ApprovalRequest>();

  /**
   * Optional durable backing for `approvals`. Injected by the host, like
   * executors are, so this package stays free of `node:fs`.
   */
  private approvalStore: ApprovalPersistence | null = null;

  /**
   * Optional durable backing for `auditLog`, injected like the approval
   * store. Without it the trail is in-process only and a restart forgets
   * everything the Fabric governed — which is exactly what
   * `docs/WORKSPACE_2_PHASE1_AUDIT.md` records as finding S-2.
   */
  private auditStore: AuditPersistence | null = null;

  constructor(private host: FabricHost) {}

  /**
   * Give the audit trail a life beyond this process.
   *
   * Unlike approvals, **everything** is restored: an audit record is a
   * statement about something that already happened, so dropping it on
   * restart would not be cautious, it would be forgetful. The host bounds
   * how much tail it keeps.
   */
  attachAuditStore(store: AuditPersistence): void {
    this.auditStore = store;
    this.auditLog = [...store.load(), ...this.auditLog];
  }

  /**
   * The ONE place an audit record is written.
   *
   * Both writers (a settled invocation and a human approval decision) go
   * through here so persistence can never be added to one path and
   * forgotten on the other. A failing store must not take down an
   * execution that already happened — the in-memory trail stays correct
   * either way, and a lost write is better than a lost effect.
   */
  private record(entry: AuditRecord): void {
    this.auditLog.push(entry);
    try { this.auditStore?.append(entry); } catch { /* never fail an action on a logging failure */ }
  }

  /**
   * Give pending authorization requests a life beyond this process.
   *
   * **Only `pending` requests are restored.** A grant that was given but
   * never spent is deliberately dropped: reinstating it would mean a
   * restart silently re-authorizing an action whose user is no longer
   * there to see it happen. The task simply asks again, which is the safe
   * direction to fail in. Decided requests are already in the audit trail,
   * so nothing is lost by not reloading them.
   */
  attachApprovalStore(store: ApprovalPersistence): void {
    this.approvalStore = store;
    for (const request of store.load()) {
      if (request.state !== 'pending') continue;
      const item = request.items[0];
      if (!item) continue;
      const key = request.missionId && request.taskId
        ? `${request.missionId}:${request.taskId}:${item.capabilityId}`
        : request.runId && request.workflowNodeId
          ? `${request.runId}:${request.workflowNodeId}:${item.capabilityId}`
          : `inv:${item.invocationId}`;
      this.approvals.set(key, request);
    }
  }

  private persistApprovals(): void {
    this.approvalStore?.save([...this.approvals.values()].filter((r) => r.state === 'pending'));
  }

  /* ── registration ─────────────────────────────────────────────── */

  /**
   * Register a real implementation. A capability without one is reported
   * `unsupported` at call time — the mechanism that keeps a large
   * manifest honest about a small set of real executors.
   */
  register(executor: Executor): void {
    this.executors.set(executor.capabilityId, executor);
  }

  isSupported(capabilityId: string): boolean {
    return this.executors.has(capabilityId);
  }

  /** Capability ids with a real executor behind them, right now. */
  supported(): string[] {
    return [...this.executors.keys()].sort();
  }

  setPolicy(policy: PolicyConfig): void {
    this.policy = policy;
  }

  getPolicy(): PolicyConfig {
    return this.policy;
  }

  /* ── events ───────────────────────────────────────────────────── */

  on(listener: FabricEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: FabricEvent): void {
    for (const listener of this.listeners) {
      // One bad listener must not take down an execution already in flight.
      try { listener(event); } catch { /* listener errors are not the caller's problem */ }
    }
  }

  audit(): readonly AuditRecord[] {
    return this.auditLog;
  }

  /* ── approvals ────────────────────────────────────────────────── */


  /** Requests still waiting on a human. */
  pendingApprovals(): ApprovalRequest[] {
    return [...this.approvals.values()].filter((r) => r.state === 'pending');
  }

  approvalById(id: string): ApprovalRequest | null {
    for (const r of this.approvals.values()) if (r.id === id) return r;
    return null;
  }

  /**
   * Record a human's decision on a pending request and write the audit
   * record for it.
   *
   * Returns null when the request is unknown or no longer pending — which
   * is what makes a double-click, a replayed request or a stale browser tab
   * harmless rather than a second authorization.
   */
  decideApproval(id: string, granted: boolean, decidedBy = 'user', reason?: string): ApprovalRequest | null {
    const request = this.approvalById(id);
    if (!request || request.state !== 'pending') return null;

    request.state = granted ? 'granted' : 'denied';
    request.decidedAt = new Date().toISOString();
    request.decidedBy = decidedBy;

    const item = request.items[0];
    this.record({
      invocationId: item?.invocationId ?? request.id,
      at: request.decidedAt,
      capabilityId: item?.capabilityId ?? 'unknown',
      actor: { kind: 'human', id: decidedBy },
      projectId: request.projectId ?? null,
      missionId: request.missionId,
      taskId: request.taskId,
      risk: item?.risk ?? 'low',
      // The policy decision that opened the gate, kept alongside the human
      // answer so the record shows both why it was asked and what was said.
      decision: request.rule === 'irreversible-floor' ? 'require-approval' : 'ask-user',
      decisionRule: request.rule ?? 'approval',
      approvalId: request.id,
      outcome: granted ? 'awaiting-approval' : 'denied',
      verified: null,
      durationMs: 0,
      inputSummary: reason ? `decision reason: ${reason}` : item?.detail ?? '',
      approvalDecision: granted ? 'granted' : 'denied',
      decidedBy,
    });

    this.emit({
      type: granted ? 'approval.granted' : 'approval.denied',
      at: request.decidedAt,
      requestId: request.id,
    });
    // A decided request leaves the pending set, so a restart never
    // resurrects a question the user has already answered.
    this.persistApprovals();
    return request;
  }

  /**
   * Spend a granted approval. Single-use: the grant is stamped consumed and
   * a second attempt finds nothing, so a refresh or a replayed request
   * cannot re-authorize an action that already ran.
   */
  consumeApproval(id: string): ApprovalRequest | null {
    const request = this.approvalById(id);
    if (!request || request.state !== 'granted' || request.consumedAt) return null;
    request.consumedAt = new Date().toISOString();
    this.persistApprovals();
    return request;
  }

  /**
   * What policy *would* say, without running anything.
   *
   * The mission engine needs this: it must know whether a task will need
   * authorization **before** it starts work, so the task can be parked
   * cleanly rather than half-executed and then blocked. The approval UI
   * needs it too, to explain why a gate opened.
   *
   * Returns `null` for an unknown capability so the caller can tell
   * "no such capability" apart from "denied".
   */
  evaluate(capabilityId: string, context: InvocationContext): PolicyEvaluation | null {
    const capability = describeFabricCapability(capabilityId);
    if (!capability) return null;

    // Resolve the node here too. A pre-flight check that ignored routing
    // would tell the mission engine "this will run" for a node the real
    // invocation is about to refuse — the two must agree.
    const executor = this.executors.get(capabilityId);
    const resolution: NodeResolution = this.host.resolveNode
      ? this.host.resolveNode(
          capability, context,
          executor?.supportsNode ? (node) => executor.supportsNode!(node) : undefined,
        )
      : { ok: true };

    if (!resolution.ok) {
      return { decision: 'deny', rule: resolution.code, risk: capability.risk, reason: resolution.reason };
    }

    return evaluatePolicy({
      capability,
      config: this.policy,
      granted: grantsFor(this.host.permissionsFor(capability, context)),
      nodeAvailable: this.host.resolveNode
        ? (capability.requiresNodeCapability ? !!resolution.node : null)
        : this.host.nodeAvailable(capability),
      subject: this.subjectFor(
        { id: '', capabilityId, input: {}, context, requestedAt: '' },
        resolution.node,
      ),
    });
  }

  /* ── the one path ─────────────────────────────────────────────── */

  async invoke(
    capabilityId: string,
    input: Record<string, unknown>,
    context: InvocationContext,
  ): Promise<InvocationResult> {
    const startedAt = new Date().toISOString();
    const started = Date.now();
    const invocation: Invocation = {
      id: invocationId(),
      capabilityId,
      input,
      context,
      requestedAt: startedAt,
    };

    const capability = describeFabricCapability(capabilityId);
    if (!capability) {
      return this.settle(invocation, capability, 'failed', `No capability is registered under "${capabilityId}".`, NO_VERIFICATION, {
        decision: 'deny', rule: 'unknown-capability', risk: 'low',
        reason: 'The Fabric does not know this capability.',
      }, started, startedAt, 1);
    }

    this.emit({ type: 'invocation.requested', at: startedAt, invocation });

    /* 1. contract */
    const invalid = validate(capability, input);
    if (invalid) {
      return this.settle(invocation, capability, 'failed', `${invalid} Correct the argument and call it again.`, NO_VERIFICATION, {
        decision: 'deny', rule: 'invalid-input', risk: capability.risk,
        reason: invalid,
      }, started, startedAt, 1);
    }

    /* 2. routing — which node, before anything is decided about it.
       Resolution feeds policy rather than bypassing it: naming a node
       changes WHICH node is evaluated, never WHETHER evaluation happens. */
    const routingExecutor = this.executors.get(capabilityId);
    const resolution: NodeResolution = this.host.resolveNode
      ? this.host.resolveNode(
          capability,
          context,
          routingExecutor?.supportsNode
            ? (node) => routingExecutor.supportsNode!(node)
            : undefined,
        )
      : { ok: true };

    if (!resolution.ok) {
      this.emit({ type: 'invocation.denied', at: new Date().toISOString(), invocationId: invocation.id, reason: resolution.reason });
      return this.settle(invocation, capability, 'denied', resolution.reason, NO_VERIFICATION, {
        decision: 'deny', rule: resolution.code, risk: capability.risk, reason: resolution.reason,
      }, started, startedAt, 0);
    }
    // The executor is handed its node; it discovers nothing itself.
    invocation.node = resolution.node;

    /* 3. policy */
    const evaluation = evaluatePolicy({
      capability,
      config: this.policy,
      granted: grantsFor(this.host.permissionsFor(capability, context)),
      // Derived from the same resolution when the host does routing, so
      // the boolean floor and the router can never disagree.
      nodeAvailable: this.host.resolveNode
        ? (capability.requiresNodeCapability ? !!resolution.node : null)
        : this.host.nodeAvailable(capability),
      subject: this.subjectFor(invocation, resolution.node),
    });


    /* 4. decision — only auto-execute runs. Anything else (deny, or any
       value this build does not recognise) is refused here, before any
       effect. Nothing waits for a person. */
    if (evaluation.decision !== 'auto-execute') {
      this.emit({ type: 'invocation.denied', at: new Date().toISOString(), invocationId: invocation.id, reason: evaluation.reason });
      return this.settle(invocation, capability, 'denied', evaluation.reason, NO_VERIFICATION, evaluation, started, startedAt, 0);
    }

    /* 5. execute — with bounded recovery */
    const executor = this.executors.get(capabilityId);
    if (!executor) {
      return this.settle(invocation, capability, 'unsupported',
        `${capability.name} is planned for but has no executor yet, so nothing was run. ${capability.description}`,
        NO_VERIFICATION, evaluation, started, startedAt, 0);
    }

    this.emit({ type: 'invocation.started', at: new Date().toISOString(), invocationId: invocation.id, capabilityId });

    let attempts = 0;
    let last = { ok: false, detail: 'Not attempted.' } as Awaited<ReturnType<Executor['run']>>;

    while (attempts < MAX_ATTEMPTS) {
      attempts += 1;
      try {
        last = await executor.run(invocation);
      } catch (error) {
        last = { ok: false, detail: (error as Error).message || 'The executor threw with no message.' };
      }
      if (last.ok) break;
      if (attempts >= MAX_ATTEMPTS || !isTransient(last.detail)) break;

      this.emit({
        type: 'invocation.retrying',
        at: new Date().toISOString(),
        invocationId: invocation.id,
        attempt: attempts + 1,
        reason: last.detail,
      });
      // Exponential backoff. Bounded by MAX_ATTEMPTS, so this loop always
      // terminates — §16's "do not create infinite loops".
      await new Promise((r) => setTimeout(r, BASE_BACKOFF_MS * 2 ** (attempts - 1)));
    }

    if (!last.ok) {
      // "did not succeed", not "did not complete" — a command that ran and
      // exited non-zero did complete, and saying otherwise misdescribes
      // what the user needs to look at.
      const tried = attempts === 1 ? '' : ` after ${attempts} attempts`;
      // The executor's own output is carried through on failure too. It is
      // what distinguishes "timed out at 124, half-done" from "exited 1",
      // and it names the node that failed — all of which the operator needs
      // precisely when something went wrong.
      return this.settle(invocation, capability, 'failed',
        `${capability.name} did not succeed${tried}. ${last.detail}`,
        NO_VERIFICATION, evaluation, started, startedAt, attempts, undefined, last.output);
    }

    /* 6. verify */
    let verification = NO_VERIFICATION;
    if (capability.verify && executor.verify) {
      try {
        verification = await executor.verify(invocation, last);
      } catch (error) {
        verification = {
          passed: false,
          kind: capability.verify,
          detail: `The check itself could not run: ${(error as Error).message}`,
        };
      }
      this.emit({
        type: verification.passed ? 'verification.passed' : 'verification.failed',
        at: new Date().toISOString(),
        invocationId: invocation.id,
        detail: verification.detail,
      });
    } else if (capability.verify) {
      verification = {
        passed: null,
        kind: capability.verify,
        detail: 'This capability declares a check, but its executor does not implement one yet.',
      };
    }

    const outcome = verification.passed === false ? 'unverified' : 'succeeded';
    const detail = outcome === 'unverified'
      ? `${capability.name} ran, but the check did not confirm it. ${verification.detail}`
      : `${capability.name} completed. ${last.detail}`;

    return this.settle(invocation, capability, outcome, detail, verification, evaluation, started, startedAt, attempts, undefined, last.output);
  }

  /* ── audit + result assembly ──────────────────────────────────── */

  /**
   * Node identity plus correlation keys for the policy engine.
   *
   * Only identity travels — not the whole `NodeRef` — so policy never ends
   * up holding a second copy of catalogue metadata.
   */
  private subjectFor(invocation: Invocation, node?: NodeRef) {
    return {
      node: node ? { id: node.id, name: node.name } : undefined,
      requestedNodeId: invocation.context.nodeId,
      actorKind: invocation.context.actor.kind,
      actorId: invocation.context.actor.id,
      projectId: invocation.context.projectId,
      missionId: invocation.context.missionId,
      taskId: invocation.context.taskId,
    };
  }

  /**
   * The node an executor reported doing the work, if it reported one.
   * Deliberately narrow: only a string `nodeId` on the executor's own
   * output counts, so nothing here can invent attribution.
   */
  private nodeIdOfOutput(output: unknown): string | undefined {
    const id = (output as { nodeId?: unknown } | undefined)?.nodeId;
    return typeof id === 'string' && id ? id : undefined;
  }

  /**
   * The node work actually ran on, or `undefined` when nothing ran.
   *
   * Prefers the executor's own report; falls back to the resolved node
   * only once an executor was genuinely invoked. Never guesses.
   */
  private executedNodeId(
    invocation: Invocation,
    capability: CapabilityDescriptor | undefined,
    attempts: number,
    output: unknown,
  ): string | undefined {
    /**
     * A capability that routes to no node has no acting node, so nothing
     * in its output may claim one.
     *
     * `system.install` is why this guard exists: its result names the node
     * being INSTALLED, which is the object of the work, not the actor
     * performing it. Without this, `output.nodeId` would be read as
     * attribution and the audit would report that a not-yet-installed tool
     * executed its own installation.
     */
    if (!capability?.requiresNodeCapability) return undefined;
    return this.nodeIdOfOutput(output) ?? (attempts > 0 ? invocation.node?.id : undefined);
  }

  private settle(
    invocation: Invocation,
    capability: CapabilityDescriptor | undefined,
    outcome: InvocationResult['outcome'],
    detail: string,
    verification: VerificationReport,
    policy: InvocationResult['policy'],
    started: number,
    startedAt: string,
    attempts: number,
    approvalId?: string,
    output?: unknown,
  ): InvocationResult {
    const endedAt = new Date().toISOString();
    const durationMs = Date.now() - started;

    const result: InvocationResult = {
      invocationId: invocation.id,
      capabilityId: invocation.capabilityId,
      outcome,
      detail,
      output,
      verification,
      policy,
      approvalId,
      startedAt,
      endedAt,
      durationMs,
      attempts,
    };

    this.record({
      invocationId: invocation.id,
      at: endedAt,
      capabilityId: invocation.capabilityId,
      actor: invocation.context.actor,
      projectId: invocation.context.projectId,
      missionId: invocation.context.missionId,
      taskId: invocation.context.taskId,
      workflowId: invocation.context.workflowId,
      runId: invocation.context.runId,
      workflowNodeId: invocation.context.workflowNodeId,
      risk: policy.risk,
      decision: policy.decision,
      decisionRule: policy.rule,
      approvalId,
      outcome,
      verified: verification.passed,
      durationMs,
      inputSummary: capability ? summarizeInput(capability, invocation.input) : '(unknown capability)',
      // Routing is recorded in full: what was asked for, what the Fabric
      // chose, and what actually ran. Collapsing these would hide a
      // substitution — the one thing routing must never do quietly.
      //
      // `executedNodeId` means EXECUTED, not resolved. A call denied by
      // policy resolves a node and then never runs on it, so falling back
      // to `invocation.node` there would have the audit assert execution
      // that did not happen. `attempts > 0` is the honest gate: every
      // non-executing exit settles with zero attempts.
      nodeId: this.executedNodeId(invocation, capability, attempts, output),
      requestedNodeId: invocation.context.nodeId,
      executedNodeId: this.executedNodeId(invocation, capability, attempts, output),
    });

    this.emit({ type: 'invocation.completed', at: endedAt, result });
    return result;
  }
}
