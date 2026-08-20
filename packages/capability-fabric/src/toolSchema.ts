/**
 * toolSchema — the manifest, expressed as tool definitions.
 * ==================================================================
 * One generator. `CAPABILITY_MANIFEST` stays the single source of truth
 * for what AURA can do; this file only re-expresses it in the shape a
 * model provider expects. Nothing here is hand-written per capability,
 * and there is deliberately no second vocabulary: a tool IS a capability,
 * named by the same id, constrained by the same `CapabilityField`s, and
 * validated at call time by the same `validate()` inside `fabric.ts`.
 *
 * That last point is the whole security argument, so it is worth stating
 * flatly:
 *
 *   **A tool call is a REQUEST, not a selection.**
 *
 * The name a model emits is looked up in `TOOL_NAMES` — a table built
 * from the manifest at module load — and a name that is not in that table
 * resolves to nothing. There is no string manipulation that turns an
 * arbitrary name into a capability id, no prefix stripping, no fuzzy
 * match, no "close enough". The model cannot widen a scope, lower a risk
 * level, or reach a capability that is not in the manifest, because the
 * only thing it can influence is which EXISTING row is looked up.
 *
 * The precedent is `planTaskInvocation` (`missionCapabilities.ts`), which
 * refuses to synthesise a command line from prose. This extends the same
 * reasoning rather than abandoning it: a model may now NAME an action,
 * but naming is a lookup key, and every argument it supplies is
 * re-validated against the declared contract before anything runs.
 */

import type { CapabilityDescriptor, CapabilityField, CapabilityOutputShape } from './types';
import { CAPABILITY_MANIFEST, describeFabricCapability } from './manifest';

/**
 * A tool definition in the provider-neutral shape.
 *
 * Structurally identical to `@aura/runtime`'s `RuntimeToolSpec`, and
 * assignable to it, but declared here rather than imported: this package
 * has no dependency on the runtime contract and adding one to describe
 * three fields would invert a dependency for no gain.
 */
export interface FabricToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/* ══════════════════════════════════════════════════════════════════
   Names
   ══════════════════════════════════════════════════════════════════ */

/**
 * Capability ids are dotted (`filesystem.read`). Every mainstream tool
 * API constrains function names to `[A-Za-z0-9_-]`, so the dot cannot
 * survive the wire.
 *
 * The substitution is trivial; the important part is that it is never
 * *inverted* by string surgery. Decoding happens only through the table
 * below, so a model emitting `filesystem__read__admin` — or anything else
 * that would decode plausibly — finds no row and is refused.
 */
function toolNameOf(capabilityId: string): string {
  return capabilityId.replace(/\./g, '__');
}

/** tool name → the capability descriptor it names. Built once, frozen. */
const TOOL_NAMES: ReadonlyMap<string, CapabilityDescriptor> = new Map(
  CAPABILITY_MANIFEST.map((c) => [toolNameOf(c.id), c] as const),
);

/** The tool name for a capability id, or null when the id is unknown. */
export function toolNameForCapability(capabilityId: string): string | null {
  return describeFabricCapability(capabilityId) ? toolNameOf(capabilityId) : null;
}

/**
 * The capability a tool name refers to, or `null`.
 *
 * `null` is the *only* other answer. This function never guesses, never
 * normalises case, and never falls back — it is the choke point that
 * makes a hallucinated tool id a refusal rather than a surprise.
 */
export function capabilityForToolName(name: string): CapabilityDescriptor | null {
  return TOOL_NAMES.get(name) ?? null;
}

/* ══════════════════════════════════════════════════════════════════
   Schemas
   ══════════════════════════════════════════════════════════════════ */

const JSON_TYPE: Record<CapabilityField['type'], Record<string, unknown>> = {
  string: { type: 'string' },
  number: { type: 'number' },
  boolean: { type: 'boolean' },
  'string[]': { type: 'array', items: { type: 'string' } },
};

/**
 * One `CapabilityField` as a JSON Schema property.
 *
 * The four declared types map 1:1 onto JSON Schema scalars, which is why
 * this is a table rather than a translator — there is no case where the
 * mapping is a judgement call, and if a fifth type is ever added this
 * object stops compiling rather than silently emitting `{}`.
 */
function propertyFor(field: CapabilityField): Record<string, unknown> {
  return {
    ...JSON_TYPE[field.type],
    description: field.description,
    ...(field.enum ? { enum: [...field.enum] } : {}),
  };
}

/**
 * The JSON Schema for a capability's arguments.
 *
 * `additionalProperties: false` is deliberate and load-bearing: an
 * argument the manifest does not declare is not merely ignored, it is
 * refused by the provider before the call is even made. The Fabric would
 * ignore it anyway — `validate()` iterates the declared fields — but
 * silently dropping an argument a caller believed it was sending is how a
 * caller ends up convinced it did something it did not.
 */
export function capabilityInputSchema(capability: CapabilityDescriptor): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const field of capability.input) properties[field.name] = propertyFor(field);
  return {
    type: 'object',
    properties,
    required: capability.input.filter((f) => f.required).map((f) => f.name),
    additionalProperties: false,
  };
}

/** A `CapabilityOutputShape` as the JSON Schema of the `output` payload. */
function outputSchema(shape: CapabilityOutputShape | undefined): Record<string, unknown> {
  if (!shape) {
    // A capability with no declared shape. Honest rather than invented:
    // the payload exists and its structure is not described here.
    return { description: 'Undeclared shape — treat as opaque.' };
  }
  switch (shape.kind) {
    case 'text':
      return { type: 'string', description: shape.description };
    case 'list':
      return { type: 'array', items: { type: 'string', description: shape.itemDescription }, description: shape.description };
    case 'record': {
      const properties: Record<string, unknown> = {};
      for (const field of shape.fields) properties[field.name] = propertyFor(field);
      return {
        type: 'object',
        description: shape.description,
        properties,
        required: shape.fields.filter((f) => f.required).map((f) => f.name),
      };
    }
    case 'opaque':
      return { type: 'object', description: `${shape.typeName} — ${shape.description}` };
  }
}

/**
 * The shape of what comes BACK from a tool call.
 *
 * Not sent to the provider as part of the tool definition — no provider
 * accepts one — but it is the contract the loop serialises results
 * against, and it is stated in the tool description so the model knows
 * what it is reading. Declaring it here rather than in the loop keeps the
 * manifest the source of truth for both halves of the exchange.
 *
 * The envelope is invariant across every capability. Only `output`
 * changes shape, and it changes exactly as `result` declares.
 */
export function capabilityResultSchema(capability: CapabilityDescriptor): Record<string, unknown> {
  return {
    type: 'object',
    description: `Result envelope for ${capability.id}.`,
    properties: {
      outcome: {
        type: 'string',
        enum: ['success', 'failure', 'partial', 'unknown', 'not-executed', 'requires-approval'],
        description:
          'What actually happened. `not-executed` means policy refused or nothing could run — '
          + 'nothing was touched. `requires-approval` means it is parked on a human and has NOT run. '
          + '`unknown` means it may or may not have taken effect; it is never a success.',
      },
      detail: { type: 'string', description: 'Plain-language explanation, always with a next step.' },
      verified: {
        type: ['boolean', 'null'],
        description: capability.verify
          ? `Whether the ${capability.verify} check confirmed the effect. Null means the check did not run.`
          : 'Always null — this capability has no mechanical check, so success is the executor’s word alone.',
      },
      output: outputSchema(capability.result),
    },
    required: ['outcome', 'detail', 'verified'],
  };
}

/* ══════════════════════════════════════════════════════════════════
   Tool definitions
   ══════════════════════════════════════════════════════════════════ */

/**
 * What a model needs to know about a capability BEYOND what it does.
 *
 * Risk and irreversibility are in the description because a planner that
 * cannot see them plans badly — it will reach for `git.push` where
 * `git.commit` would do. They are emphatically NOT there as an
 * authorization hint: policy is re-evaluated on every call and the model's
 * belief about a risk level has no bearing on the decision. Telling it the
 * truth costs nothing and improves the plan.
 */
function governanceNote(capability: CapabilityDescriptor): string {
  const parts = [`Risk: ${capability.risk}.`];
  if (capability.irreversible) {
    parts.push('IRREVERSIBLE — AURA cannot undo this, so it always requires explicit human authorization.');
  }
  if (capability.requiresNodeCapability) {
    parts.push(`Needs a connected node providing "${capability.requiresNodeCapability}"; refused when none is present.`);
  }
  parts.push(`Returns: ${capability.output}.`);
  return parts.join(' ');
}

/** One capability as a tool definition. */
export function toolSpecFor(capability: CapabilityDescriptor): FabricToolSpec {
  return {
    name: toolNameOf(capability.id),
    description: `${capability.description} ${governanceNote(capability)}`,
    parameters: capabilityInputSchema(capability),
  };
}

/**
 * Tool definitions for a set of capability ids.
 *
 * Unknown ids are dropped rather than throwing: the caller is usually a
 * policy-derived allowlist, and an allowlist naming a capability that no
 * longer exists should narrow what is offered, never crash the request.
 * The dropped ids are returned so a caller that cares can say so.
 */
export function toolSpecsFor(capabilityIds: readonly string[]): {
  tools: FabricToolSpec[];
  unknown: string[];
} {
  const tools: FabricToolSpec[] = [];
  const unknown: string[] = [];
  for (const id of capabilityIds) {
    const capability = describeFabricCapability(id);
    if (capability) tools.push(toolSpecFor(capability));
    else unknown.push(id);
  }
  return { tools, unknown };
}

/**
 * Every capability in the manifest, as tool definitions.
 *
 * Rarely what you want directly — a loop should offer what policy and the
 * registered executors permit, not the whole catalogue — but it is what
 * `scripts/tool-schema-verify.mjs` exercises, and it is the honest answer
 * to "what could this become".
 */
export function allToolSpecs(): FabricToolSpec[] {
  return CAPABILITY_MANIFEST.map(toolSpecFor);
}
