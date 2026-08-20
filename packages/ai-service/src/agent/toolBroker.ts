/**
 * agent/toolBroker — a tool call is a REQUEST, never a selection.
 * ==================================================================
 * This file is the entire security argument for letting a model act, so
 * it is worth being blunt about what it does and does not do.
 *
 * What a model produces is a NAME and a BLOB OF TEXT. Neither is trusted:
 *
 *   • The name is looked up in the table `toolSchema.ts` builds from
 *     `CAPABILITY_MANIFEST`. There is no string surgery, no normalisation,
 *     no nearest match. A name that is not a row resolves to nothing.
 *   • The arguments are parsed as JSON and handed to `fabric.invoke`,
 *     which re-runs `validate()` against the declared contract — including
 *     the enums — before anything else happens.
 *   • Policy is re-evaluated on every single call. The model's belief
 *     about a risk level, a scope, or an approval has no effect on the
 *     decision, because none of those travel with the call.
 *
 * A model-supplied string therefore cannot select a capability that is not
 * in the manifest, cannot widen a scope, and cannot lower a risk level.
 * The risk and the permission set come from the descriptor; the descriptor
 * comes from the manifest; the manifest is a compiled-in constant.
 *
 * The precedent is `planTaskInvocation`, which refuses to invent a command
 * line from prose because "arguments must never come from a model". That
 * reasoning is extended here, not abandoned: the model may now NAME an
 * action — a lookup key — and every argument it supplies is re-validated
 * against a contract it did not write.
 */

import {
  capabilityForToolName,
  summarizeCapabilityInput,
  summarizeUnknownInput,
  type CapabilityDescriptor,
  type CapabilityFabric,
  type InvocationContext,
  type InvocationResult,
} from '@aura/capability-fabric';
import type { RuntimeToolCall } from '@aura/runtime';
import { READ_ONLY_SCOPES, type StepOutcome } from './types';

/** A tool call that survived resolution, ready to be invoked. */
export interface ResolvedToolCall {
  ok: true;
  capability: CapabilityDescriptor;
  input: Record<string, unknown>;
  /** Redacted summary of the arguments, for the journal. */
  argumentsSummary: string;
}

/** A tool call that did not. `rule` is what the journal records. */
export interface RefusedToolCall {
  ok: false;
  rule: 'unknown-tool' | 'out-of-scope' | 'malformed-arguments' | 'not-an-object';
  reason: string;
  argumentsSummary: string;
}

/**
 * Resolve one model-emitted tool call against the manifest and the run's
 * scope.
 *
 * `scope` is the run's budgeted capability set. A capability that resolves
 * but is outside it is refused HERE and never reaches the Fabric — the
 * Fabric would judge it on policy alone, which is the right answer to a
 * different question. Scope is what this run was budgeted for; policy is
 * what the machine permits at all. Conflating them would let a sub-agent
 * reach past its parent's grant merely because the machine allows it.
 */
export function resolveToolCall(
  call: RuntimeToolCall,
  scope: ReadonlySet<string>,
): ResolvedToolCall | RefusedToolCall {
  const capability = capabilityForToolName(call.name);
  if (!capability) {
    return {
      ok: false,
      rule: 'unknown-tool',
      reason: `There is no capability called "${call.name}". Use one of the tools you were given.`,
      argumentsSummary: summarizeUnknownInput(call.arguments),
    };
  }

  if (!scope.has(capability.id)) {
    return {
      ok: false,
      rule: 'out-of-scope',
      reason: `${capability.name} is not part of what this run may do. Nothing was attempted.`,
      argumentsSummary: summarizeUnknownInput(call.arguments),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(call.arguments || '{}');
  } catch (error) {
    return {
      ok: false,
      rule: 'malformed-arguments',
      reason: `The arguments were not valid JSON (${(error as Error).message}). Send them again as a JSON object.`,
      argumentsSummary: summarizeUnknownInput(call.arguments),
    };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      rule: 'not-an-object',
      reason: 'Arguments must be a JSON object with named fields.',
      argumentsSummary: summarizeUnknownInput(call.arguments),
    };
  }

  const input = parsed as Record<string, unknown>;
  return {
    ok: true,
    capability,
    input,
    // Summarised through the Fabric's own audit summariser, so the journal
    // and the audit record redact the same fields by the same rule.
    argumentsSummary: summarizeCapabilityInput(capability, input),
  };
}

/**
 * Record a refusal the Fabric itself should own.
 *
 * An unknown tool id is a request for a capability, and a request for a
 * capability belongs in the audit trail whether or not it was honoured —
 * an unrecorded refusal is indistinguishable from a request nobody made.
 * So it is passed to `fabric.invoke` under the name the model used, where
 * `describeFabricCapability` returns nothing, the call settles as
 * `unknown-capability`, no executor is consulted, and one audit record is
 * written by the same `settle()` that writes every other one.
 *
 * This is why the loop does not need a refusal log of its own. It is safe
 * because "unknown capability" is the FIRST thing `invoke` checks, before
 * routing, before policy, before any executor exists to be reached.
 */
export async function journalUnknownTool(
  fabric: CapabilityFabric,
  toolName: string,
  context: InvocationContext,
): Promise<string> {
  const result = await fabric.invoke(toolName, {}, context);
  return result.invocationId;
}

/**
 * A capability that cannot change anything, so a failure of it provably
 * had no effect.
 */
function readOnly(capability: CapabilityDescriptor): boolean {
  return capability.permissions.every((p) => READ_ONLY_SCOPES.has(p));
}

/**
 * The Fabric's outcome, read in the loop's six-value vocabulary.
 *
 * The two vocabularies are kept separate on purpose and both are recorded:
 * `InvocationOutcome` answers "what did the execution authority conclude",
 * `StepOutcome` answers "what does the loop now believe about the world".
 * Collapsing them would lose the second question's answer, which is the
 * one the next iteration reasons from.
 *
 * The mapping, and why each line is what it is:
 *
 *   succeeded          → success        it ran; nothing contradicted it
 *   unverified         → partial        it ran and the effect could NOT be
 *                                       confirmed. Not a success — the
 *                                       check that exists said no.
 *   denied             → not-executed   refused before anything happened
 *   unsupported        → not-executed   no executor; nothing was attempted
 *   awaiting-approval  → requires-approval
 *   failed, effect provably not started → failure
 *   failed, read-only capability        → failure (nothing to affect)
 *   failed, anything else               → unknown
 *
 * That last line is the one that matters. A transient error says the
 * transport failed; it never says the effect did not happen, and `mayRetry`
 * in the Fabric already treats undefined as "may have started". Reporting
 * it as `failure` would assert something nobody knows.
 */
export function readOutcome(result: InvocationResult, capability: CapabilityDescriptor): StepOutcome {
  switch (result.outcome) {
    case 'succeeded':
      return 'success';
    case 'unverified':
      return 'partial';
    case 'denied':
    case 'unsupported':
      return 'not-executed';
    case 'awaiting-approval':
      return 'requires-approval';
    case 'failed':
      if (result.effectStarted === false) return 'failure';
      if (readOnly(capability)) return 'failure';
      return 'unknown';
  }
}

/** Outcomes that extend a consecutive-failure streak. */
export function countsAsFailure(outcome: StepOutcome): boolean {
  return outcome === 'failure' || outcome === 'unknown';
}

/**
 * What the model is told about a step.
 *
 * Deliberately states the outcome in the six-value vocabulary and defines
 * `unknown` inline every time it appears. A model that reads "failed" will
 * cheerfully retry; a model that reads "may or may not have taken effect"
 * has been given the information it needs not to.
 *
 * The payload is bounded before it goes back: a 512KB file read must not
 * consume the token budget the run needs to finish.
 */
export function renderObservation(
  result: InvocationResult,
  outcome: StepOutcome,
  maxPayload = 8000,
): string {
  const payload = result.output === undefined
    ? undefined
    : typeof result.output === 'string'
      ? result.output
      : safeStringify(result.output);

  const body: Record<string, unknown> = {
    outcome,
    detail: result.detail,
    verified: result.verification.passed,
  };
  if (payload !== undefined) {
    body.output = payload.length > maxPayload
      ? `${payload.slice(0, maxPayload)}\n…(truncated at ${maxPayload} characters)`
      : payload;
  }
  if (outcome === 'unknown') {
    body.warning = 'This step MAY have taken effect. Do not repeat it as if nothing happened.';
  }
  if (outcome === 'requires-approval') {
    body.warning = 'Nothing ran. A person must authorize this before it can proceed.';
    if (result.approvalId) body.approvalId = result.approvalId;
  }
  return safeStringify(body);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    // Circular or otherwise unserialisable. Saying so beats throwing
    // inside the one place that is supposed to report what happened.
    return '"(output could not be serialised)"';
  }
}
