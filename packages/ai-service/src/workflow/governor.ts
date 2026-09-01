/**
 * governor — the workflow engine's one door to the Capability Fabric.
 * ==================================================================
 * The engine in `engine.ts` knows nothing about capabilities, policy,
 * approval or audit. It knows that some nodes are governed, and it hands
 * those to a `NodeGovernor`. This file is the only implementation, and it
 * does four things and no others:
 *
 *   1. plan  — node type + config → capability id + arguments (`governed.ts`)
 *   2. inject— resolve `{{secret:NAME}}` into the arguments, last moment
 *   3. invoke— `fabric.invoke(...)`, with the run's correlation keys
 *   4. map   — one `InvocationResult` → one `GovernedOutcome`
 *
 * It makes no decision the Fabric could have made. Notice in particular
 * what is NOT here: no risk check, no allow-list, no "is this safe",
 * no retry (the Fabric's bounded recovery already owns that), no audit
 * write. Every one of those would be a second authority.
 *
 * The layering is deliberate: keeping the Fabric behind an interface means
 * the engine can be exercised with a stub governor in tests that must NOT
 * touch a real machine, while the production path has no bypass at all —
 * a governed node with no governor attached refuses to run rather than
 * falling back to a direct effect.
 */

import type { CapabilityFabric, InvocationResult } from '@aura/capability-fabric';
import { BINDINGS, isGoverned } from './governed';
import type { RunCtx } from './nodes';
import type { EvidenceRef } from './run/types';
import type { NodeIO, WfNode } from './types';
import type { SecretStore } from '../secrets';

export interface GovernedOutcome {
  kind: 'succeeded' | 'failed' | 'denied' | 'awaiting-approval' | 'no-effect';
  /** Text to pass downstream. Already redacted. */
  text: string;
  data?: unknown;
  files?: string[];
  /** Short node-face summary. Already redacted. */
  summary: string;
  /** Set on `failed` / `denied`. Already redacted. */
  error?: string;
  /** The audit-trail pointer, when an invocation actually happened. */
  evidence?: EvidenceRef;
  /** Set on `awaiting-approval`. */
  approval?: { requestId: string; capabilityId: string; requestedAt: string; summary: string };
}

export interface NodeGovernor {
  /** Run one governed node through the Fabric. */
  run(node: WfNode, ctx: RunCtx, input: NodeIO, interpolate: (t: string) => string): Promise<GovernedOutcome>;
  /** Scrub known secret values out of anything about to be recorded. */
  redact(text: string): string;
}

export interface GovernorDeps {
  fabric: CapabilityFabric;
  secrets: SecretStore;
  workflowId: string;
  runId: string;
  projectId: string;
  projectPath: string;
  /** Who the audit trail should hold responsible. */
  actor: { kind: 'human' | 'agent' | 'system'; id: string };
  /**
   * Capability ids the human authorized for THIS run, if any.
   *
   * Passed straight to the Fabric's per-invocation grant. It is not a
   * standing permission and it is not consulted here — the Fabric still
   * evaluates policy, still applies every hard floor, and still spends the
   * grant once. A run authorized for `filesystem.write` cannot use that to
   * reach `terminal.execute`.
   */
  approvedCapabilities?: string[];
  /** Per-node wall clock handed to the executor. */
  timeoutMs?: number;
}

/** Text kept from an executor's output. Bounded so a run record cannot bloat. */
const MAX_OUTPUT_TEXT = 60_000;

/** Pull the human-usable text out of an executor payload without guessing. */
function textOf(result: InvocationResult): string {
  const out = result.output;
  if (typeof out === 'string') return out;
  if (out && typeof out === 'object') {
    const o = out as { stdout?: unknown; text?: unknown };
    if (typeof o.stdout === 'string') return o.stdout;
    if (typeof o.text === 'string') return o.text;
  }
  return result.detail;
}

function evidenceOf(result: InvocationResult, nodeId?: string): EvidenceRef {
  return {
    invocationId: result.invocationId,
    capabilityId: result.capabilityId,
    outcome: result.outcome,
    decision: result.policy.decision,
    decisionRule: result.policy.rule,
    risk: result.policy.risk,
    verified: result.verification.passed,
    approvalId: result.approvalId,
    nodeId,
    at: result.endedAt,
    durationMs: result.durationMs,
  };
}

export function createGovernor(deps: GovernorDeps): NodeGovernor {
  // Built once per run: the values are decrypted a single time and live
  // only as long as the run does.
  const redact = deps.secrets.redactor();

  return {
    redact,

    async run(node, ctx, input, interpolate) {
      const planner = BINDINGS[node.type];
      if (!isGoverned(node.type) || !planner) {
        // Reaching here means the engine's classification and this file's
        // bindings disagree. That is a build error, and failing closed is
        // the only safe reading of it — the alternative is performing an
        // ungoverned effect because a table was incomplete.
        return { kind: 'failed', text: '', summary: 'not governed', error: `"${node.type}" is classified as a governed node but has no capability binding, so nothing was run.` };
      }

      let plan;
      try {
        plan = planner(ctx, input, { ...node.config }, interpolate);
      } catch (error) {
        const message = redact((error as Error).message);
        return { kind: 'failed', text: '', summary: 'misconfigured', error: message };
      }
      if (!plan) return { kind: 'no-effect', text: input.text, summary: 'nothing to do' };

      /* Secret injection — the last moment before the Fabric, and the only
         place a value exists in plaintext. `plan.describe` is built from
         the UNRESOLVED text, so the approval prompt and the run log show
         the reference, never the credential. */
      let resolvedInput: Record<string, unknown>;
      try {
        resolvedInput = Object.fromEntries(
          Object.entries(plan.input).map(([k, v]) => {
            if (typeof v === 'string') return [k, deps.secrets.resolve(v).text];
            if (v && typeof v === 'object' && !Array.isArray(v)) {
              return [k, Object.fromEntries(
                Object.entries(v as Record<string, unknown>).map(([hk, hv]) =>
                  [hk, typeof hv === 'string' ? deps.secrets.resolve(hv).text : hv]),
              )];
            }
            return [k, v];
          }),
        );
      } catch (error) {
        return { kind: 'failed', text: '', summary: 'missing secret', error: redact((error as Error).message) };
      }

      const result = await deps.fabric.invoke(plan.capabilityId, resolvedInput, {
        actor: deps.actor,
        projectId: deps.projectId,
        cwd: deps.projectPath,
        workflowId: deps.workflowId,
        runId: deps.runId,
        workflowNodeId: node.id,
        approvedCapabilities: deps.approvedCapabilities,
        timeoutMs: deps.timeoutMs,
      });

      const performedBy = (result.output as { nodeId?: unknown } | undefined)?.nodeId;
      const evidence = evidenceOf(result, typeof performedBy === 'string' ? performedBy : undefined);
      const raw = textOf(result);
      const text = redact(raw.length > MAX_OUTPUT_TEXT ? `${raw.slice(0, MAX_OUTPUT_TEXT)}\n…(truncated)` : raw);

      switch (result.outcome) {
        case 'succeeded': {
          // Shaping runs on already-redacted text, so a shape function can
          // never re-expose a value the redactor removed.
          const shaped = plan.shape ? plan.shape(text) : null;
          return {
            kind: 'succeeded',
            text: shaped?.text ?? text,
            data: shaped && 'data' in shaped ? shaped.data : result.output,
            files: shaped?.files,
            summary: redact(shaped?.summary ?? plan.describe),
            evidence,
          };
        }

        // Ran, but could not be shown to have done what it claimed. Treated
        // as a failure for the same reason the mission path does: an
        // unverified effect the operator believes succeeded is worse than
        // one they know to re-check.
        case 'unverified':
          return { kind: 'failed', text, summary: 'unverified', error: redact(result.detail), evidence };

        case 'denied':
          return { kind: 'denied', text: '', summary: `denied · ${result.policy.rule}`, error: redact(result.detail), evidence };

        case 'awaiting-approval':
          return {
            kind: 'awaiting-approval',
            text: '',
            summary: 'waiting on you',
            evidence,
            approval: result.approvalId
              ? { requestId: result.approvalId, capabilityId: plan.capabilityId, requestedAt: result.startedAt, summary: redact(plan.describe) }
              : undefined,
          };

        case 'unsupported':
          return { kind: 'failed', text: '', summary: 'not supported', error: redact(result.detail), evidence };

        case 'failed':
        default:
          return { kind: 'failed', text, summary: 'failed', error: redact(result.detail), evidence };
      }
    },
  };
}
