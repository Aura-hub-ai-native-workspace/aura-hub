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

import type {
  ApprovalPersistence,
  ApprovalRequest,
  AuditRecord,
  CapabilityDescriptor,
  Executor,
  ExecutorResult,
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

/**
 * Whether this failure may be retried automatically.
 *
 * Being transient is necessary but not sufficient. A transient error says
 * the *transport* failed; it says nothing about whether the *effect*
 * happened first. For a reversible capability that distinction does not
 * matter — repeating it costs a little time. For an irreversible one it is
 * the whole question: a delegated coding agent that timed out may already
 * have rewritten the repository, and running it again would compound edits
 * the user approved exactly once.
 *
 * So an irreversible capability is retried only when the executor has
 * PROVEN the effect never began. Unknown counts as started. This is
 * decided from `capability.irreversible` — the same metadata the policy
 * engine's irreversible floor uses — so it governs every capability,
 * present and future, with no per-capability special cases.
 */
function mayRetry(capability: CapabilityDescriptor, result: ExecutorResult): boolean {
  if (!isTransient(result.detail)) return false;
  if (!capability.irreversible) return true;
  return result.effectStarted === false;
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

/**
 * The thing an action acts on, for the approval prompt. Picks the first
 * argument that reads like a target so the user sees "src/app.ts" rather
 * than having to infer it from a capability id.
 */
function describeTarget(capability: CapabilityDescriptor, input: Record<string, unknown>): string | undefined {
  for (const key of ['path', 'url', 'command', 'name', 'branch', 'message', 'projectId']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) {
      return value.length > 80 ? `${value.slice(0, 77)}…` : value;
    }
  }
  return capability.surface === 'aura-internal' ? 'AURA Hub' : undefined;
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

  constructor(private host: FabricHost) {}

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

  /**
   * Identity of an authorization request.
   *
   * Keyed by what is being authorized — the mission task and capability —
   * rather than by the invocation, because a user pressing Run three times
   * on a gated task is asking the same question three times, not asking
   * three questions. Without a mission task to anchor to, the invocation
   * is the best available identity and each call stands alone.
   */
  private static approvalKey(capabilityId: string, context: InvocationContext, invocationId: string): string {
    return context.missionId && context.taskId
      ? `${context.missionId}:${context.taskId}:${capabilityId}`
      : `inv:${invocationId}`;
  }

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
    this.auditLog.push({
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
      decision: request.rule === 'irreversible-floor' || request.rule === 'irreversible-retry'
        ? 'require-approval'
        : 'ask-user',
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

    if (evaluation.decision === 'deny') {
      this.emit({ type: 'invocation.denied', at: new Date().toISOString(), invocationId: invocation.id, reason: evaluation.reason });
      return this.settle(invocation, capability, 'denied', evaluation.reason, NO_VERIFICATION, evaluation, started, startedAt, 0);
    }

    /* 4. approval */
    if (evaluation.decision !== 'auto-execute') {
      // Identity of the QUESTION, not of the attempt. Pressing Run three
      // times on a gated task asks one question three times, and must not
      // produce three notifications and three buttons.
      const key = CapabilityFabric.approvalKey(capabilityId, context, invocation.id);
      const open = this.approvals.get(key);

      // Already answered "yes" out of band (the approval UI). Spend it —
      // once — and fall through to execution.
      const preGranted = open?.state === 'granted' && !open.consumedAt && this.consumeApproval(open.id);

      if (!preGranted) {
        // Reuse the open question rather than minting a duplicate.
        const request: ApprovalRequest = open?.state === 'pending' ? open : {
          id: `apr-${invocation.id}`,
          state: 'pending',
          requestedAt: new Date().toISOString(),
          summary: evaluation.reason,
          rule: evaluation.rule,
          projectId: context.projectId ?? undefined,
          missionId: context.missionId,
          taskId: context.taskId,
          target: describeTarget(capability, input),
          // Both consequences are stated, because an approval prompt that
          // only says what happens if you say yes is not a real choice.
          onAccept: `${capability.name} runs now${capability.verify ? ', and the Fabric checks it actually worked' : ''}. ${capability.output}.`,
          onDecline: context.taskId
            ? 'Nothing runs. The task stays where it is with the decline recorded against it, and the rest of the mission is untouched.'
            : 'Nothing runs, and the request is recorded as declined.',
          items: [{
            invocationId: invocation.id,
            capabilityId,
            title: capability.name,
            detail: summarizeInput(capability, input),
            risk: capability.risk,
            irreversible: Boolean(capability.irreversible),
          }],
        };

        if (open?.state !== 'pending') {
          this.approvals.set(key, request);
          this.emit({ type: 'approval.required', at: request.requestedAt, request });
          // Durable the moment it is asked, so a crash between asking and
          // answering does not lose the question.
          this.persistApprovals();
        }

        // The host may still grant inline (a caller that carried an explicit
        // per-invocation authorization). Otherwise the request stays open and
        // the invocation is parked, not failed.
        const granted = await this.host.requestApproval(request, context).catch(() => false);
        if (!granted) {
          return this.settle(invocation, capability, 'awaiting-approval',
            `${capability.name} is ready and waiting on your go-ahead. Nothing has run.`,
            NO_VERIFICATION, evaluation, started, startedAt, 0, request.id, undefined, false);
        }
        if (request.state === 'pending') {
          request.state = 'granted';
          request.decidedAt = new Date().toISOString();
          request.decidedBy = context.actor.id;
          request.consumedAt = request.decidedAt;
          this.emit({ type: 'approval.granted', at: request.decidedAt, requestId: request.id });
          this.persistApprovals();
        }
      }
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
    let last: ExecutorResult = { ok: false, detail: 'Not attempted.' };
    /** Non-null when the loop withheld an automatic retry for governance. */
    let withheld: { rule: string; effectStarted?: boolean; requestId?: string; output?: unknown } | null = null;

    while (attempts < MAX_ATTEMPTS) {
      attempts += 1;
      try {
        last = await executor.run(invocation);
      } catch (error) {
        // An executor that throws mid-flight may already have started its
        // effect. We cannot prove otherwise, and the safe reading of
        // "unknown" is "may have started" — never "proven not started".
        last = {
          ok: false,
          detail: (error as Error).message || 'The executor threw with no message.',
          effectStarted: true,
        };
      }
      if (last.ok) break;
      if (attempts >= MAX_ATTEMPTS || !isTransient(last.detail)) break;

      /* Capability-aware recovery — `mayRetry` is the single decision
         predicate. Being transient is necessary but not sufficient: an
         irreversible capability is retried automatically ONLY while its
         effect is proven not to have started. Any other state — started,
         or unknown — must not be repeated without a fresh human decision,
         so the loop parks the invocation on the Fabric's own approval
         mechanism instead. The decision reads `capability.irreversible`,
         never a capability id, so a future irreversible capability
         inherits it for free. */
      if (!mayRetry(capability, last)) {
        const authorized = await this.authorizeIrreversibleRetry(invocation, capability, input);
        if (!authorized.granted) {
          withheld = {
            rule: 'irreversible-retry',
            effectStarted: last.effectStarted,
            requestId: authorized.requestId,
            output: last.output,
          };
          break;
        }
        // A fresh human grant covers exactly ONE more execution. It is not
        // a licence to keep retrying: the next failure is re-evaluated by
        // this loop.
        continue;
      }

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

    /* An automatic retry was withheld because the action is irreversible
       and its effect may already exist. This is a governance pause, NOT a
       normal failure: the invocation is parked awaiting a human decision
       on the Fabric's own approval request, and is executed again only
       with a fresh grant. */
    if (withheld) {
      const reason =
        `${capability.name} may already have taken effect. The previous attempt failed while its effect was uncertain, `
        + 'so an automatic retry was withheld — retrying could repeat or compound the action. '
        + 'A human grant is therefore required before another execution.';
      return this.settle(
        invocation, capability, 'awaiting-approval',
        `${capability.name} may already have taken effect, and an automatic retry was withheld. `
          + 'It is waiting on a human go-ahead before it can be attempted again. Nothing further has run.',
        NO_VERIFICATION,
        { decision: 'require-approval', rule: withheld.rule, risk: capability.risk, reason },
        started, startedAt, attempts, withheld.requestId, withheld.output,
        withheld.effectStarted,
        { withheld: true, rule: withheld.rule, effectStarted: withheld.effectStarted },
      );
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
        NO_VERIFICATION, evaluation, started, startedAt, attempts, undefined, last.output,
        last.effectStarted);
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

    return this.settle(invocation, capability, outcome, detail, verification, evaluation, started, startedAt, attempts, undefined, last.output, last.effectStarted);
  }

  /**
   * Ask a human whether an irreversible action whose effect may already
   * exist may be attempted again.
   *
   * Uses the SAME approval mechanism as every other gate: an
   * `ApprovalRequest` on the existing map, persisted through the existing
   * `ApprovalPersistence`, decided through the existing `decideApproval`
   * path, with the rule `irreversible-retry`. There is deliberately no
   * second approval store, no second decision mechanism and no capability
   * id special case — this is reached only because the descriptor says
   * `irreversible`.
   *
   * One deliberate asymmetry with the step-4 gate: the context's
   * per-invocation `approvedCapabilities` grant is NOT honoured here.
   * Authorizing the action once is not authorizing a re-run of an action
   * that may already have happened — that is a materially different
   * question, and answering it automatically is exactly the retry the
   * invariant forbids. Only deciding THIS request can grant the retry.
   */
  private async authorizeIrreversibleRetry(
    invocation: Invocation,
    capability: CapabilityDescriptor,
    input: Record<string, unknown>,
  ): Promise<{ granted: boolean; requestId?: string }> {
    const key = CapabilityFabric.approvalKey(invocation.capabilityId, invocation.context, invocation.id);
    const open = this.approvals.get(key);

    // A grant already given out of band and not yet spent covers exactly
    // this retry — once.
    const preGranted = open?.state === 'granted' && !open.consumedAt && this.consumeApproval(open.id);
    if (preGranted) return { granted: true, requestId: open!.id };

    const rule = 'irreversible-retry';
    const reason =
      `${capability.name} may already have taken effect. The previous attempt failed while its effect was uncertain, `
      + 'so an automatic retry was withheld — retrying could repeat or compound the action. '
      + 'A human grant is therefore required before another execution.';
    const request: ApprovalRequest = open?.state === 'pending' ? open : {
      id: `apr-retry-${invocation.id}`,
      state: 'pending',
      requestedAt: new Date().toISOString(),
      summary: reason,
      rule,
      projectId: invocation.context.projectId ?? undefined,
      missionId: invocation.context.missionId,
      taskId: invocation.context.taskId,
      target: describeTarget(capability, input),
      onAccept: `${capability.name} is executed once more with this grant. The prior attempt may already have taken effect, so this can repeat or compound it.`,
      onDecline: 'No further execution happens. The failure is recorded, and nothing more runs.',
      items: [{
        invocationId: invocation.id,
        capabilityId: capability.id,
        title: capability.name,
        detail: summarizeInput(capability, input),
        risk: capability.risk,
        irreversible: true,
      }],
    };

    if (open?.state !== 'pending') {
      this.approvals.set(key, request);
      this.emit({ type: 'approval.required', at: request.requestedAt, request });
      // Durable the moment it is asked, so a crash between asking and
      // answering does not lose the question.
      this.persistApprovals();
    }

    // The retry is a NEW question, not a continuation of the original
    // authorization: strip the per-invocation grant so a host that honors
    // `approvedCapabilities` cannot auto-answer it.
    const contextForDecision = { ...invocation.context, approvedCapabilities: undefined };
    const granted = await this.host.requestApproval(request, contextForDecision).catch(() => false);
    if (!granted) return { granted: false, requestId: request.id };
    if (request.state === 'pending') {
      request.state = 'granted';
      request.decidedAt = new Date().toISOString();
      request.decidedBy = invocation.context.actor.id;
      request.consumedAt = request.decidedAt;
      this.emit({ type: 'approval.granted', at: request.decidedAt, requestId: request.id });
      this.persistApprovals();
    }
    return { granted: true, requestId: request.id };
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
   * Whether the executor reported receiving a canonical AURA context.
   *
   * Read from the executor's own output for the same reason
   * `executedNodeId` is: the Fabric never sees the injected prompt. The
   * host wiring hands the executor a COPY of the invocation carrying it,
   * so only the executor can attest to what it actually received.
   *
   * `undefined` when nothing ran — an invocation parked at approval has no
   * execution to attribute, and reporting `false` there would read as "it
   * ran without context".
   */
  private contextInjectedOf(output: unknown, attempts: number): boolean | undefined {
    if (attempts === 0) return undefined;
    return (output as { contextInjected?: unknown } | undefined)?.contextInjected === true;
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
    effectStarted?: boolean,
    retry?: NonNullable<AuditRecord['retry']>,
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
      startedAt,
      endedAt,
      durationMs,
      attempts,
    };
    if (effectStarted !== undefined) result.effectStarted = effectStarted;
    if (capability?.irreversible === true) result.irreversible = true;

    this.auditLog.push({
      invocationId: invocation.id,
      at: endedAt,
      capabilityId: invocation.capabilityId,
      actor: invocation.context.actor,
      projectId: invocation.context.projectId,
      missionId: invocation.context.missionId,
      taskId: invocation.context.taskId,
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
      contextInjected: this.contextInjectedOf(output, attempts),
      ...(retry ? { retry } : {}),
    });

    this.emit({ type: 'invocation.completed', at: endedAt, result });
    return result;
  }
}
