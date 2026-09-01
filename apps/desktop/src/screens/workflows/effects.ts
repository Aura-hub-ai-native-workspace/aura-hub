/**
 * effects — what each workflow node does, in plain language.
 * ==================================================================
 * ── What this file is NOT ─────────────────────────────────────────
 * It is not the authority on what a workflow is permitted to do. That is
 * `GET /workflows/:id/envelope`, computed by the service from the graph
 * and its own capability manifest, and rendered by `PermissionEnvelope`.
 * Risk, permission scopes, irreversibility and the capability a node maps
 * to are all read from there — never derived here.
 *
 * ── What it is ────────────────────────────────────────────────────
 * The one-sentence description a person reads in the inspector, plus
 * whether a node needs the network or an open project. `NodeSpecInfo`
 * carries none of that (see docs/BACKEND_CONTRACTS_REQUIRED.md §1), so it
 * is maintained here by reading `packages/ai-service/src/workflow/nodes.ts`.
 *
 * The `capabilityId` field is kept only as a fallback for surfaces that
 * run before the envelope has loaded; anything that matters reads the
 * envelope. `nodeEffect()` prefers values the service serves over this
 * table, so shipping the contract change makes this a fallback rather
 * than requiring a UI change.
 *
 * A node type absent from this table resolves to `UNMAPPED`, which the
 * UI renders as "effect not described" — never as "safe".
 */

import type { NodeSpecInfo, WfNode } from '../../ai/aiClient';

/** How a node's work reaches the outside world. */
export type EffectSurface =
  /** Reads or writes inside AURA itself (memory, notes, conversations). */
  | 'aura'
  /** Reads the open project's files or git state. */
  | 'project-read'
  /** Writes into the open project's working tree. */
  | 'project-write'
  /** Spawns a local process. */
  | 'process'
  /** Calls the configured AI provider. */
  | 'model'
  /** Makes an outbound network request. */
  | 'network'
  /** Pure computation — no effect outside the run. */
  | 'none';

export interface NodeEffect {
  /**
   * The Fabric capability whose descriptor describes this node's work,
   * or `null` when the Fabric has no equivalent. `null` is not "safe" —
   * it means the UI must show the effect sentence and mark the node as
   * having no governed counterpart.
   */
  capabilityId: string | null;
  surface: EffectSurface;
  /** One sentence, present tense, from the user's side of the screen. */
  effect: string;
  /** True when the node cannot run without a network connection. */
  needsNetwork: boolean;
  /** True when the node needs a project to be open. */
  needsProject: boolean;
}

const E = (
  capabilityId: string | null,
  surface: EffectSurface,
  effect: string,
  opts: { needsNetwork?: boolean; needsProject?: boolean } = {},
): NodeEffect => ({
  capabilityId,
  surface,
  effect,
  needsNetwork: opts.needsNetwork ?? false,
  needsProject: opts.needsProject ?? true,
});

/** The honest answer for a node this table does not know about. */
export const UNMAPPED: NodeEffect = {
  capabilityId: null,
  surface: 'none',
  effect: 'This node type is not described here — open it to see what it is configured to do.',
  needsNetwork: false,
  needsProject: true,
};

/**
 * node type → effect. Mirrors `packages/ai-service/src/workflow/nodes.ts`.
 * Keep the two in step until the service serves this itself.
 */
export const NODE_EFFECTS: Record<string, NodeEffect> = {
  /* ── source ─────────────────────────────────────────────────────── */
  'current-project': E(null, 'project-read', 'Reads the open project’s profile — type, language, frameworks, entry points.'),
  'selected-files': E('filesystem.read', 'project-read', 'Reads the named files from inside the project root.'),
  'changed-files': E('git.status', 'project-read', 'Reads which files have uncommitted changes.'),
  'current-conversation': E(null, 'aura', 'Reads the project’s most recent AURA conversation.'),
  'project-memory': E('memory.search', 'aura', 'Recalls entries from this project’s memory.'),
  'engineering-memory': E('memory.search', 'aura', 'Queries this project’s engineering memory — missions, diagnoses, decisions.'),

  /* ── intelligence ───────────────────────────────────────────────── */
  'coding-engine': E(null, 'project-read', 'Retrieves code context from the project’s indexed source.'),
  'fullstack-engine': E(null, 'project-read', 'Retrieves system entities and relationships from the project index.'),
  'research-engine': E(null, 'none', 'Not implemented by the engine yet.'),
  'intent-classifier': E(null, 'model', 'Classifies the incoming text’s intent using the configured AI provider.', { needsNetwork: true }),
  'prompt-enhancer': E(null, 'model', 'Rewrites the incoming text into a stronger prompt using the configured AI provider.', { needsNetwork: true }),

  /* ── generate ───────────────────────────────────────────────────── */
  prompt: E(null, 'none', 'Fills a text template with values from upstream nodes. Nothing leaves AURA.'),
  groq: E(null, 'model', 'Sends the incoming text to the configured AI provider and returns its reply.', { needsNetwork: true }),
  'generate-markdown': E(null, 'model', 'Asks the configured AI provider for a Markdown document.', { needsNetwork: true }),
  'generate-code': E(null, 'model', 'Asks the configured AI provider for code.', { needsNetwork: true }),
  'generate-json': E(null, 'model', 'Asks the configured AI provider for structured JSON.', { needsNetwork: true }),

  /* ── logic ──────────────────────────────────────────────────────── */
  condition: E(null, 'none', 'Routes the run down one of two paths. No effect of its own.', { needsProject: false }),
  loop: E(null, 'none', 'Repeats the nodes below it over a list. No effect of its own.', { needsProject: false }),
  delay: E(null, 'none', 'Waits before continuing. No effect of its own.', { needsProject: false }),
  variables: E(null, 'none', 'Sets named values other nodes can reference. No effect of its own.', { needsProject: false }),
  'user-input': E(null, 'none', 'Collects a value from you before the run starts.', { needsProject: false }),

  /* ── action ─────────────────────────────────────────────────────── */
  'save-memory': E(null, 'aura', 'Writes an entry into this project’s memory inside AURA.'),
  'create-note': E(null, 'aura', 'Writes a Markdown note into AURA’s own storage — never into the repository.'),
  'export-file': E('filesystem.write', 'project-write', 'Creates or replaces a file inside the project root.'),
  'shell-command': E('terminal.execute', 'process', 'Runs an allow-listed command in the project root. No shell, no operators.'),
  'git-status': E('git.status', 'project-read', 'Reads the working tree status.'),
  'git-diff': E('git.diff', 'project-read', 'Reads uncommitted changes as a diff.'),
  'git-commit': E('git.commit', 'project-write', 'Stages every change in the project and commits it.'),
  'git-branch': E('git.branch', 'project-write', 'Reads the current branch, or creates and switches to one.'),
  'http-request': E('http.request', 'network', 'Calls an external HTTP(S) URL.', { needsNetwork: true }),
  'slack-notify': E('http.request', 'network', 'Posts a message to a Slack Incoming Webhook.', { needsNetwork: true }),

  /* ── io ─────────────────────────────────────────────────────────── */
  output: E(null, 'none', 'Presents a result in the run view. No effect outside AURA.', { needsProject: false }),
};

/**
 * The effect for one node.
 *
 * Prefers anything the service itself declares on the spec (forward
 * compatibility with the contract change above), then this table, then
 * `UNMAPPED`. It never guesses.
 */
export function nodeEffect(type: string, spec?: NodeSpecInfo): NodeEffect {
  const served = spec as (NodeSpecInfo & Partial<NodeEffect>) | undefined;
  if (served && typeof served.effect === 'string' && served.effect) {
    return {
      capabilityId: served.capabilityId ?? null,
      surface: served.surface ?? 'none',
      effect: served.effect,
      needsNetwork: served.needsNetwork ?? false,
      needsProject: served.needsProject ?? true,
    };
  }
  return NODE_EFFECTS[type] ?? UNMAPPED;
}

/** Every distinct capability id a graph's nodes correspond to. */
export function capabilityIdsOf(nodes: WfNode[], specs: Map<string, NodeSpecInfo>): string[] {
  const ids = new Set<string>();
  for (const n of nodes) {
    const cap = nodeEffect(n.type, specs.get(n.type)).capabilityId;
    if (cap) ids.add(cap);
  }
  return [...ids].sort();
}

/** True when any node in the graph needs the network to run. */
export function needsNetwork(nodes: WfNode[], specs: Map<string, NodeSpecInfo>): boolean {
  return nodes.some((n) => nodeEffect(n.type, specs.get(n.type)).needsNetwork);
}

/** Human label for a surface, used in the envelope's grouping. */
export const SURFACE_LABEL: Record<EffectSurface, string> = {
  aura: 'Inside AURA',
  'project-read': 'Reads your project',
  'project-write': 'Changes your project',
  process: 'Runs local commands',
  model: 'Calls the AI provider',
  network: 'Reaches the network',
  none: 'No effect outside the run',
};
