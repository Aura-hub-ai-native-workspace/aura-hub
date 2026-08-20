/**
 * agent/checkpoint — record prior state before the agent writes.
 * ==================================================================
 * So that reverting an agent's work never depends on git. A project need
 * not be a repository, a repository need not be clean, and "just check out
 * the previous commit" destroys whatever the person was doing at the time.
 *
 * The prior state is read through the Fabric, using ordinary capabilities,
 * and that is the design rather than an implementation detail: the loop
 * has no direct filesystem access, so a checkpoint cannot be the one place
 * it quietly acquires some. A capture is a governed, audited invocation
 * exactly like the write it precedes.
 *
 * The consequence is that AURA can only checkpoint what it can read back
 * through a capability that exists. That set is small today, and this file
 * says so plainly rather than implying broader coverage:
 *
 *   filesystem.write   prior contents via `filesystem.read`; restored by
 *                      writing them back. A file that did not exist is a
 *                      real capture too — "it was absent" is prior state.
 *   git.branch         the branch HEAD was on, via `git.branch` with no
 *                      argument; restored by switching back.
 *
 * Everything else mutating is NOT capturable, and each says why. That is
 * not a gap to be papered over with a plausible-looking snapshot: an
 * unrestorable checkpoint is worse than none, because it is relied upon.
 *
 * What the controller does with an uncapturable mutation is the important
 * half — see `loop.ts`. It is refused when it would otherwise run
 * unattended. A mutation a human is already gating may proceed, because
 * the human is the recovery plan.
 */

import type { CapabilityFabric, CapabilityDescriptor, InvocationContext } from '@aura/capability-fabric';
import { describeFabricCapability } from '@aura/capability-fabric';
import { MUTATING_SCOPES, type AgentJournalEntry } from './types';

/**
 * The largest prior state a checkpoint will record.
 *
 * A bound is necessary because the prior state is written into the run
 * journal — that is what makes a revert possible without git — and an
 * unbounded one would let a single write of a large file turn a run's
 * record into something nobody can open. Past the bound the checkpoint
 * reports `captured: false` with the reason, which is the honest answer:
 * AURA could not record what it was about to change, so it will not
 * change it unattended.
 */
const MAX_CHECKPOINT_BYTES = 256 * 1024;

/** Does this capability change something the loop should be able to undo? */
export function isMutating(capability: CapabilityDescriptor): boolean {
  return capability.permissions.some((p) => MUTATING_SCOPES.has(p));
}

/**
 * How to capture, and later restore, the prior state of one capability.
 *
 * Both halves are expressed as Fabric invocations. `restore` produces the
 * invocation that would undo the change; it is deliberately NOT executed
 * here — reverting is an action with its own policy consequences, and a
 * checkpoint that could silently re-enter the execution path would be a
 * second way to cause an effect.
 */
interface CheckpointStrategy {
  /** The read capability that captures prior state. */
  via: string;
  /** Arguments for the capture, derived from the mutation's own arguments. */
  captureInput(input: Record<string, unknown>): Record<string, unknown>;
  /** The invocation that would put things back. */
  restore(input: Record<string, unknown>, priorOutput: unknown): { capabilityId: string; input: Record<string, unknown> } | null;
}

const STRATEGIES: Record<string, CheckpointStrategy> = {
  'filesystem.write': {
    via: 'filesystem.read',
    captureInput: (input) => ({ path: String(input.path ?? '') }),
    restore: (input, prior) => (typeof prior === 'string'
      ? { capabilityId: 'filesystem.write', input: { path: String(input.path ?? ''), content: prior } }
      // The file did not exist before. Restoring means deleting it, and
      // there is no delete capability in the manifest — so this says so
      // rather than offering a restore that would not restore.
      : null),
  },
  'git.branch': {
    via: 'git.branch',
    // No `name` means "report the current branch" — the capability's own
    // documented behaviour, reused rather than a second way to ask.
    captureInput: () => ({}),
    restore: (_input, prior) => (typeof prior === 'string' && prior
      ? { capabilityId: 'git.branch', input: { name: prior } }
      : null),
  },
};

/**
 * Why a mutation cannot be checkpointed. Stated per capability, because
 * "unsupported" tells a user nothing and invites them to assume it is a
 * bug rather than a boundary.
 */
const NOT_CAPTURABLE: Record<string, string> = {
  'terminal.execute': 'A command can change anything, so there is no prior state to read back.',
  'agent.delegate': 'A coding agent decides its own edit set, so nothing here knows what to record beforehand.',
  'git.commit': 'Undoing a commit needs a git reset, and AURA has no capability that performs one.',
  'git.push': 'A push is visible to other people the moment it lands; nothing local can take it back.',
  'system.install': 'Undoing an install needs a package removal, and AURA has no capability that performs one.',
  'project.create': 'Undoing this means deleting a directory, and AURA has no capability that destroys one.',
  'project.open': 'Nothing reports which project was active before, so the previous state cannot be read.',
  'provider.connect': 'Credentials are write-only by design; the previous key cannot be read back.',
  'mission.approve': 'A passed checkpoint is part of the mission record and is not reversible from here.',
  'mission.start': 'Execution that has begun cannot be un-begun; stopping it is a different action.',
  'mission.create': 'Undoing this means deleting a mission, and AURA has no capability that destroys one.',
  'workflow.run': 'A workflow’s effects are whatever its nodes did, each governed and audited on its own.',
  'diagnosis.run': 'Diagnosis writes its findings to the project record; there is no prior findings state to restore.',
  'github.create_repository': 'The repository would exist on a remote service AURA cannot delete from.',
  'github.create_pr': 'The pull request would exist on a remote service AURA cannot delete from.',
};

/** What a capture attempt produced. */
export type Checkpoint =
  | {
      captured: true;
      capabilityId: string;
      /** The read capability used. Always a real Fabric capability. */
      via: string;
      /** Audit id of the capture itself — it was a governed invocation. */
      invocationId: string;
      /** Prior state, exactly as the read capability returned it. */
      prior: unknown;
      /** The invocation that would undo the change, when one exists. */
      restore: { capabilityId: string; input: Record<string, unknown> } | null;
    }
  | {
      captured: false;
      capabilityId: string;
      /** Always populated. A refusal with no reason is not a refusal. */
      why: string;
      /** Set when a capture was attempted through the Fabric and failed. */
      invocationId?: string;
    };

/**
 * Capture prior state before a mutating capability runs.
 *
 * The context is reused rather than rebuilt so the capture lands in the
 * same project, the same mission and the same task as the write it
 * guards — a checkpoint filed against a different correlation than the
 * action it protects is a checkpoint nobody will find.
 *
 * The actor is narrowed to a read: the capture is AURA's own bookkeeping,
 * not part of what the model asked for, and it must never be able to
 * consume an approval the model's action is waiting on.
 */
export async function captureCheckpoint(
  fabric: CapabilityFabric,
  capabilityId: string,
  input: Record<string, unknown>,
  context: InvocationContext,
): Promise<Checkpoint> {
  const capability = describeFabricCapability(capabilityId);
  if (!capability) {
    return { captured: false, capabilityId, why: 'Unknown capability — nothing to checkpoint.' };
  }
  if (!isMutating(capability)) {
    return { captured: false, capabilityId, why: 'Reads nothing back because it changes nothing.' };
  }

  const strategy = STRATEGIES[capabilityId];
  if (!strategy) {
    return {
      captured: false,
      capabilityId,
      why: NOT_CAPTURABLE[capabilityId]
        ?? 'No read-back capability exists for this, so prior state cannot be recorded.',
    };
  }

  const result = await fabric.invoke(strategy.via, strategy.captureInput(input), {
    ...context,
    // A capture must never inherit an approval granted for the write. It
    // is a read; if reading needs authorization, that is its own question.
    approvedCapabilities: undefined,
    resumeApprovalId: undefined,
  });

  if (result.outcome !== 'succeeded') {
    // `filesystem.read` failing because the file is absent is not a
    // failure to checkpoint — "it was not there" is exactly the prior
    // state, and restoring it means removing what gets written. There is
    // no capability that removes a file, so this is reported honestly as
    // captured-but-unrestorable rather than as a capture that worked.
    return {
      captured: false,
      capabilityId,
      invocationId: result.invocationId,
      why: `Prior state could not be read (${result.detail})`,
    };
  }

  const restore = strategy.restore(input, result.output);
  if (restore) {
    const size = Buffer.byteLength(JSON.stringify(restore.input));
    if (size > MAX_CHECKPOINT_BYTES) {
      return {
        captured: false,
        capabilityId,
        invocationId: result.invocationId,
        why: `Prior state is ${Math.round(size / 1024)}KB, over the ${MAX_CHECKPOINT_BYTES / 1024}KB a checkpoint will record, so a revert could not be guaranteed.`,
      };
    }
  }

  return {
    captured: true,
    capabilityId,
    via: strategy.via,
    invocationId: result.invocationId,
    prior: result.output,
    restore,
  };
}

/**
 * The invocations that would undo a run, newest change first.
 *
 * Read from the journal, so it works on a run this process never saw —
 * which is the whole point. Reverting is itself an action: these are
 * returned rather than executed, and putting them through `fabric.invoke`
 * subjects each one to the same policy, approval and audit as any other
 * write. A revert that bypassed governance would be a second execution
 * path, and there is only ever one.
 *
 * Later checkpoints come first because restoring in the order the changes
 * were made would replay them.
 */
export function restorePlan(entries: readonly AgentJournalEntry[]): { capabilityId: string; input: Record<string, unknown> }[] {
  return [...entries]
    .sort((a, b) => b.seq - a.seq)
    .flatMap((entry) => (entry.type === 'checkpoint' && entry.captured && entry.restore ? [entry.restore] : []));
}

/**
 * Whether a mutation may proceed unattended given what was captured.
 *
 * The rule: nothing changes state without a way back, unless a human is
 * already standing in for the way back. `gated` is true when policy has
 * decided this action needs a person — in that case the person IS the
 * recovery plan, and refusing on top of that would block work the user
 * has explicitly authorized while protecting nothing.
 */
export function mayProceedWithout(checkpoint: Checkpoint, gated: boolean): { ok: boolean; reason: string } {
  if (checkpoint.captured) {
    return checkpoint.restore
      ? { ok: true, reason: `Prior state recorded via ${checkpoint.via}; this can be put back.` }
      : { ok: true, reason: `Prior state recorded via ${checkpoint.via}, though no capability exists to restore it automatically.` };
  }
  if (gated) {
    return { ok: true, reason: `${checkpoint.why} Proceeding because a person is authorizing this action.` };
  }
  return {
    ok: false,
    reason: `${checkpoint.why} AURA will not change state unattended when it cannot record what it is changing.`,
  };
}
