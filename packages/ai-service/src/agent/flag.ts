/**
 * agent/flag — one switch, off by default, with a precondition.
 * ==================================================================
 * The agent loop is built and does not ship armed. Phases 1 and 2 —
 * a durable journal, orphan-free process containment, the event spine,
 * local-model fallback — are what make a loop that acts on its own safe
 * to switch on, and none of them is finished. Shipping the loop enabled
 * before them would be shipping the interesting half of a safety system.
 *
 * So this is deliberately ONE switch rather than a scattering of
 * conditionals. There is exactly one place that answers "may a run
 * start", every entry point asks it, and the answer carries its reasons.
 * Scattered checks are how a feature ends up half-enabled: one path
 * guarded, another not, and nobody able to say which.
 *
 * And it is a switch with a PRECONDITION, not just a default. Turning it
 * on is not sufficient:
 *
 *   • the Fabric's audit trail must be durable (`hasDurableAudit()`), and
 *   • the run journal must be durable (`AgentJournal.durable`).
 *
 * Both exist for the same reason. A bounded autonomous loop nobody can
 * reconstruct afterwards is not governed, it is merely bounded — and the
 * moment you most need to know what it did is after the process that ran
 * it is gone. Requesting the flag on a build with an in-memory trail
 * therefore does not enable anything; it produces a refusal that names
 * what is missing.
 */

import type { CapabilityFabric } from '@aura/capability-fabric';
import type { AgentJournal } from './types';

/**
 * The environment variable that requests the loop.
 *
 * A variable rather than a settings field, on purpose: this is a build-
 * and-deployment level decision about whether an unfinished safety story
 * is complete, not a user preference, and it should not be reachable from
 * a settings screen while that is true.
 */
export const AGENT_LOOP_ENV = 'AURA_AGENT_LOOP';

export interface AgentLoopGate {
  /** The only value any caller should branch on. */
  enabled: boolean;
  /** Whether anyone asked for it, separate from whether they may have it. */
  requested: boolean;
  /** Why it is off, or a confirmation of why it is on. Always populated. */
  reason: string;
  /** Every unmet precondition, so a reader is not fixing one at a time. */
  blockers: string[];
}

/** Did the environment ask for the loop at all? Anything but `1` is no. */
export function agentLoopRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[AGENT_LOOP_ENV] === '1';
}

/**
 * The one answer to "may a run start".
 *
 * Takes its inputs rather than reaching for globals so the gate can be
 * exercised honestly — including its negative cases, which are the ones
 * that matter and which are unreachable in a test that can only observe
 * the real process environment.
 */
export function agentLoopGate(input: {
  requested: boolean;
  fabric: Pick<CapabilityFabric, 'hasDurableAudit'>;
  journal: Pick<AgentJournal, 'durable'>;
}): AgentLoopGate {
  const blockers: string[] = [];
  if (!input.fabric.hasDurableAudit()) {
    blockers.push(
      'The Capability Fabric has no durable audit store attached, so nothing this loop did '
      + 'would survive the process. Attach one with fabric.attachAuditStore().',
    );
  }
  if (!input.journal.durable) {
    blockers.push(
      'The agent run journal is in-memory, so a run could not be reconstructed afterwards. '
      + 'Use FileAgentJournal.',
    );
  }

  if (!input.requested) {
    return {
      enabled: false,
      requested: false,
      blockers,
      reason: `The agent loop is off. Set ${AGENT_LOOP_ENV}=1 to request it.`
        + (blockers.length ? ` It would still be refused: ${blockers.length} precondition(s) unmet.` : ''),
    };
  }

  if (blockers.length) {
    return {
      enabled: false,
      requested: true,
      blockers,
      reason: `The agent loop was requested but cannot be armed: ${blockers.join(' ')}`,
    };
  }

  return {
    enabled: true,
    requested: true,
    blockers: [],
    reason: 'The agent loop is armed: the audit trail and the run journal are both durable.',
  };
}
