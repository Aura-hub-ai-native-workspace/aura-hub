/**
 * governed — the seam where a workflow node becomes a Fabric invocation.
 * ==================================================================
 * This file is the whole workflow→Fabric integration, and it is
 * deliberately small. It answers exactly one question per node:
 *
 *   "Is this node a governed side effect, and if so, which capability
 *    with which arguments?"
 *
 * It decides nothing else. It does not evaluate risk, does not consult
 * policy, does not ask for approval, does not audit and does not execute.
 * Those all belong to `CapabilityFabric.invoke`, and routing through it is
 * the entire point — a second decision made here would be a second policy
 * engine no matter how small it looked.
 *
 * ── Why bindings live in code ──────────────────────────────────────
 * `BINDINGS` is keyed by node TYPE and the capability id is a literal.
 * Nothing a workflow definition contains — no config field, no imported
 * JSON, no AI-generated graph — can change which capability a node
 * invokes. A workflow can therefore never self-grant: the worst a hostile
 * definition can do is supply arguments to a capability its node type
 * already implies, and those arguments still pass through the Fabric's
 * contract validation, policy evaluation and approval gate.
 *
 * ── Why not every node ─────────────────────────────────────────────
 * Forcing a pure computation through an authorization check is not
 * security, it is noise that trains people to approve without reading.
 * The classification below is the judgement about which nodes genuinely
 * reach outside AURA, and it is stated per node type rather than inferred.
 */

import type { RunCtx } from './nodes';
import type { NodeIO, WfNodeType } from './types';

/* ══════════════════════════════════════════════════════════════════
   Classification
   ══════════════════════════════════════════════════════════════════ */

export type NodeClass =
  /** Reads or reshapes data already inside AURA. No effect. */
  | 'pure'
  /** Routes execution. No effect. */
  | 'control'
  /** Calls a frozen engine or a model provider. Effect is a token spend. */
  | 'intelligence'
  /**
   * Writes inside AURA's own home directory (`~/.aura`). A real effect,
   * but confined to AURA's own state, reversible, and with no capability
   * in the manifest today. Recorded on the run record as an effect so a
   * run stays reconstructable — see the limitation note in the report.
   */
  | 'aura-internal'
  /** Reaches outside AURA. Must go through the Capability Fabric. */
  | 'governed';

export const NODE_CLASS: Record<WfNodeType, NodeClass> = {
  // source — project data through the frozen engines
  'current-project': 'pure',
  'selected-files': 'pure',
  'changed-files': 'governed',
  'current-conversation': 'pure',
  'project-memory': 'pure',
  'engineering-memory': 'pure',
  // intelligence
  'coding-engine': 'intelligence',
  'fullstack-engine': 'intelligence',
  'research-engine': 'intelligence',
  'intent-classifier': 'intelligence',
  'prompt-enhancer': 'intelligence',
  // The agent reasons here and acts only through the Fabric, node by node,
  // inside its own loop. It is `intelligence` rather than `governed`
  // because the NODE causes no effect — each tool call it makes is its own
  // governed invocation, evaluated on its own terms.
  agent: 'intelligence',
  // generate
  prompt: 'pure',
  groq: 'intelligence',
  'generate-markdown': 'intelligence',
  'generate-code': 'intelligence',
  'generate-json': 'intelligence',
  // logic
  condition: 'control',
  loop: 'control',
  delay: 'control',
  variables: 'control',
  'user-input': 'control',
  // action
  'save-memory': 'aura-internal',
  'create-note': 'aura-internal',
  'export-file': 'governed',
  'shell-command': 'governed',
  'git-status': 'governed',
  'git-diff': 'governed',
  'git-commit': 'governed',
  'git-branch': 'governed',
  'http-request': 'governed',
  'slack-notify': 'governed',
  // io
  output: 'pure',
};

export const isGoverned = (type: WfNodeType): boolean => NODE_CLASS[type] === 'governed';

/**
 * Does this node type need the network to do its job?
 *
 * Declared per type so an offline-capable workflow can be shown to be
 * offline-capable rather than assumed to be. Intelligence nodes are
 * `false` here because a local provider satisfies them — whether the
 * *configured* provider needs the network is a provider question, not a
 * node question, and answering it here would be a guess.
 */
export const NEEDS_NETWORK: Partial<Record<WfNodeType, boolean>> = {
  'http-request': true,
  'slack-notify': true,
};

/* ══════════════════════════════════════════════════════════════════
   Bindings
   ══════════════════════════════════════════════════════════════════ */

export interface GovernedPlan {
  capabilityId: string;
  input: Record<string, unknown>;
  /**
   * Shape the capability's raw result into what this node emits.
   *
   * Presentation only. It receives text the Fabric already produced and
   * already redacted, and it decides nothing about permission — a node
   * that parses `git status --porcelain` into a file list is formatting,
   * not governing. Without this hook, routing a node through the Fabric
   * would silently change what downstream nodes receive, which would be a
   * behaviour regression dressed up as a security improvement.
   */
  shape?: (text: string) => { text: string; data?: unknown; files?: string[]; summary?: string };
  /**
   * Human phrase for the run log and the approval prompt, e.g.
   * `run "npm test"`. Never contains a resolved secret — the caller
   * interpolates secret REFERENCES, and the Fabric injects values.
   */
  describe: string;
}

/**
 * How a governed node's already-interpolated config becomes a capability
 * call. Returning `null` means "this node instance causes no effect this
 * time" — a Git Commit with nothing staged, for example — and the engine
 * then completes it without an invocation rather than inventing one.
 */
export type BindingPlanner = (
  ctx: RunCtx,
  input: NodeIO,
  config: Record<string, unknown>,
  interpolate: (template: string) => string,
) => GovernedPlan | null;

const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** `Key: Value` lines → an object. Shared with the ungoverned path's parser. */
function parseHeaderLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

export const BINDINGS: Partial<Record<WfNodeType, BindingPlanner>> = {
  'shell-command': (_ctx, _input, config, interpolate) => {
    const command = interpolate(str(config.command)).trim();
    if (!command) throw new Error('no command configured');
    return { capabilityId: 'terminal.execute', input: { command }, describe: `run "${clip(command, 60)}"` };
  },

  'export-file': (_ctx, input, config, interpolate) => {
    const rel = interpolate(str(config.path)).trim();
    if (!rel) throw new Error('no export path configured');
    // Path confinement is NOT re-implemented here. `filesystem.write`'s
    // executor resolves inside the project root and rejects traversal;
    // duplicating that check would create a second answer to "is this path
    // allowed", and two answers is one too many.
    return { capabilityId: 'filesystem.write', input: { path: rel, content: input.text }, describe: `write ${clip(rel, 60)}` };
  },

  'git-status': () => ({
    capabilityId: 'git.status',
    input: {},
    describe: 'read git status',
    shape: (text) => ({ text: text || 'clean', summary: clip(text.split('\n')[0] ?? '', 40) }),
  }),

  'changed-files': () => ({
    capabilityId: 'git.status',
    input: {},
    describe: 'list changed files',
    // Same porcelain parse this node always did — now with an audit record
    // and a named source-control node behind it.
    shape: (text) => {
      const files = text.split('\n').filter(Boolean).map((l) => l.slice(3).trim());
      return {
        text: files.length ? `Changed files:\n${files.map((f) => `- ${f}`).join('\n')}` : 'No uncommitted changes.',
        files,
        data: files,
        summary: `${files.length} changed`,
      };
    },
  }),

  'git-diff': (_ctx, _input, config) => ({
    capabilityId: 'git.diff',
    input: { staged: config.staged === true },
    describe: config.staged === true ? 'read staged git diff' : 'read git diff',
    shape: (text) => {
      const body = text.length > 60_000 ? `${text.slice(0, 60_000)}\n…(truncated)` : text;
      return {
        text: body || 'no changes',
        summary: !text ? 'no changes' : clip(text.split('\n').pop() ?? '', 40),
      };
    },
  }),

  'git-commit': (_ctx, _input, config, interpolate) => {
    const message = interpolate(str(config.message)).split('\n')[0].trim();
    if (!message) throw new Error('no commit message configured');
    return { capabilityId: 'git.commit', input: { message }, describe: `commit "${clip(message, 50)}"` };
  },

  'git-branch': (_ctx, _input, config, interpolate) => {
    const name = interpolate(str(config.name)).trim();
    // The capability covers both reading and switching, and is rated
    // medium for that reason. Passing the name through unchanged keeps the
    // manifest's risk call intact rather than second-guessing it here.
    return {
      capabilityId: 'git.branch',
      input: name ? { name } : {},
      describe: name ? `switch to branch ${clip(name, 40)}` : 'read current branch',
    };
  },

  'http-request': (_ctx, input, config, interpolate) => {
    const url = interpolate(str(config.url)).trim();
    if (!url) throw new Error('no URL configured');
    const method = str(config.method, 'GET').toUpperCase();
    const bodyTemplate = str(config.body);
    const body = method === 'GET' || method === 'DELETE'
      ? undefined
      : (bodyTemplate.trim() ? interpolate(bodyTemplate) : (input.text || undefined));
    return {
      capabilityId: 'http.request',
      input: {
        url,
        method,
        ...(body === undefined ? {} : { body }),
        headers: parseHeaderLines(interpolate(str(config.headers))),
      },
      describe: `${method} ${clip(url, 60)}`,
    };
  },

  'slack-notify': (_ctx, input, config, interpolate) => {
    const url = interpolate(str(config.webhookUrl)).trim();
    if (!url) throw new Error('no Slack webhook URL configured');
    const text = interpolate(str(config.message)) || input.text;
    if (!text.trim()) throw new Error('nothing to send — connect an upstream node or set a message');
    // Slack is an HTTP POST. It is bound to `http.request` rather than
    // given a capability of its own so the network permission a user sees
    // is the same one whichever node asked for it — one vocabulary, per
    // the research's "if two surfaces name the same risk differently, the
    // model has leaked".
    return {
      capabilityId: 'http.request',
      input: { url, method: 'POST', body: JSON.stringify({ text }), headers: { 'content-type': 'application/json' } },
      describe: 'post a message to Slack',
    };
  },
};

/** The capability a node type invokes, without planning a call. */
export function capabilityForNode(type: WfNodeType): string | null {
  switch (type) {
    case 'shell-command': return 'terminal.execute';
    case 'export-file': return 'filesystem.write';
    case 'git-status': return 'git.status';
    case 'changed-files': return 'git.status';
    case 'git-diff': return 'git.diff';
    case 'git-commit': return 'git.commit';
    case 'git-branch': return 'git.branch';
    case 'http-request': return 'http.request';
    case 'slack-notify': return 'http.request';
    default: return null;
  }
}
