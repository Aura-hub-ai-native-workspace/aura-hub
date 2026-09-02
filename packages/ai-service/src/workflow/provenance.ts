/**
 * provenance — whose words are these?
 * ==================================================================
 * The Capability Fabric answers *may this happen*. It does not answer
 * *whose words are these*, and for an agent node that second question is
 * the one that matters: an HTTP response saying "ignore your instructions"
 * must not reach a model with the same standing as text the workflow
 * author typed.
 *
 * Full rationale and the threat model in
 * `docs/AGENT_CONTEXT_PROVENANCE.md`. The rules, in short:
 *
 *   • four ordered levels, `authored` > `system` > `tool` > `external`;
 *   • an output is only as trusted as its least trusted input, capped by
 *     what the node type can ever emit;
 *   • only `authored` is treated as instruction.
 *
 * ── This is not a policy engine ────────────────────────────────────
 * Nothing here decides what may run. It attaches a label to a value and
 * the agent runner reads that label to decide how to PRESENT it. If a
 * policy decision ever starts reading provenance, this has stopped being
 * a provenance model — see the invariants in the design document.
 */

import type { RunTrigger } from './run/types';
import type { WfNodeType } from './types';

/** Ordered least-to-most trusted. The order is what makes `weakest` work. */
export type Provenance = 'external' | 'tool' | 'system' | 'authored';

export const TRUST_RANK: Record<Provenance, number> = {
  external: 0,
  tool: 1,
  system: 2,
  authored: 3,
};

/** Only `authored` is instruction. Everything else is evidence. */
export const isInstruction = (p: Provenance): boolean => p === 'authored';

/** True when a value must be fenced before a model sees it. */
export const isUntrusted = (p: Provenance): boolean => TRUST_RANK[p] <= TRUST_RANK.tool;

/** The least trusted of a set. An empty set is `authored` — nothing came in. */
export function weakest(levels: Provenance[]): Provenance {
  let out: Provenance = 'authored';
  for (const level of levels) if (TRUST_RANK[level] < TRUST_RANK[out]) out = level;
  return out;
}

/**
 * The highest level a node type can ever emit, whatever its inputs.
 *
 * A ceiling, not an assignment: the actual provenance is this capped by
 * the weakest input, so a `prompt` interpolating an HTTP response emits
 * `external` despite an `authored` ceiling.
 *
 * Note that every generation node caps at `system`, never `authored`. A
 * model's output is plausible text produced from a prompt; letting it be
 * `authored` would allow a workflow to launder untrusted input through a
 * model and back into instruction.
 */
export const NODE_CEILING: Record<WfNodeType, Provenance> = {
  // pure template and routing — they add no source, so they only propagate
  prompt: 'authored',
  variables: 'authored',
  condition: 'authored',
  loop: 'authored',
  delay: 'authored',
  output: 'authored',

  // AURA's own understanding of the project: real, but not instruction
  'current-project': 'system',
  'selected-files': 'system',
  'current-conversation': 'system',
  'project-memory': 'system',
  'engineering-memory': 'system',
  'coding-engine': 'system',
  'fullstack-engine': 'system',
  'research-engine': 'system',
  'intent-classifier': 'system',
  'prompt-enhancer': 'system',

  // model output — never instruction
  groq: 'system',
  'generate-markdown': 'system',
  'generate-code': 'system',
  'generate-json': 'system',
  agent: 'system',

  // AURA-internal writes echo their input back
  'save-memory': 'system',
  'create-note': 'system',

  // Capability Fabric executor output
  'shell-command': 'tool',
  'git-status': 'tool',
  'git-diff': 'tool',
  'git-commit': 'tool',
  'git-branch': 'tool',
  'changed-files': 'tool',
  'export-file': 'tool',

  // off this machine
  'http-request': 'external',
  'slack-notify': 'external',

  // decided by how the run was triggered — see `userInputProvenance`
  'user-input': 'system',
};

/**
 * What a `user-input` value is worth, decided by how the run started.
 *
 * A person typing into a manual run is `system`. A webhook is `external`,
 * and this is not a hypothetical: `POST /workflows/:id/trigger/:token`
 * puts the request BODY into exactly these inputs, so the same node is
 * trusted or untrusted depending on what started the run.
 */
export function userInputProvenance(trigger: RunTrigger): Provenance {
  switch (trigger.kind) {
    case 'manual': return 'system';
    case 'mission': return 'system';
    // A resumed run inherits the caution of the thing it resumes; without
    // the original trigger to hand, the safe reading is the cautious one.
    case 'resume': return 'external';
    case 'webhook': return 'external';
    case 'automation': return 'external';
    default: return 'external';
  }
}

/** The provenance a node emits, given what reached it. */
export function provenanceOf(type: WfNodeType, inputs: Provenance[], trigger: RunTrigger): Provenance {
  const ceiling = type === 'user-input' ? userInputProvenance(trigger) : (NODE_CEILING[type] ?? 'external');
  // An entry node has nothing to be capped by; everything else takes the
  // weakest of its inputs and its own ceiling.
  return inputs.length ? weakest([...inputs, ceiling]) : ceiling;
}

/** Human label for a trace or an inspector. */
export const PROVENANCE_LABEL: Record<Provenance, string> = {
  authored: 'written in this workflow',
  system: 'from AURA',
  tool: 'from a tool',
  external: 'from outside AURA',
};
