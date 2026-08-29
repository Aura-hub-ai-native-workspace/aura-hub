/**
 * validation — what is wrong with this graph, before it runs.
 * ==================================================================
 * Structural and configuration checks only. This is not a second
 * executor and not a policy engine:
 *
 *   • It never decides whether an action is permitted — the Capability
 *     Fabric does that, at call time, on the service.
 *   • It never predicts a result. It reports facts about the graph.
 *
 * Everything here is checkable from the definition alone, which is why
 * it can run on every keystroke without touching the service.
 *
 * Three tiers, and the tier decides the consequence:
 *   error   — Run is disabled. The run would certainly fail or hang.
 *   warning — Run proceeds. Something is probably not what you meant.
 *   advice  — Shown only when the strip is expanded.
 */

import type { NodeSpecInfo, Workflow, WfNode } from '../../ai/aiClient';

export type FindingLevel = 'error' | 'warning' | 'advice';

export interface Finding {
  id: string;
  level: FindingLevel;
  /** The node this is about, when it is about one. */
  nodeId?: string;
  /** Short, specific, and written from the user's side of the screen. */
  message: string;
  /** What to do about it. Always actionable. */
  fix?: string;
}

export interface ValidationReport {
  findings: Finding[];
  errors: number;
  warnings: number;
  advice: number;
  /** True when the graph can be run at all. */
  runnable: boolean;
}

const REF = /\{\{\s*([\w.-]+)\s*\}\}/g;

/** Keys the engine always resolves — see `interpolate()` in nodes.ts. */
const BUILTIN_REFS = new Set(['input', 'project']);

/** Every KEY a `variables` node in this graph defines. */
function declaredVars(nodes: WfNode[]): Set<string> {
  const keys = new Set<string>();
  for (const n of nodes) {
    if (n.type !== 'variables') continue;
    const raw = typeof n.config.pairs === 'string' ? n.config.pairs
      : typeof n.config.values === 'string' ? n.config.values
      : Object.values(n.config).filter((v) => typeof v === 'string').join('\n');
    for (const line of String(raw).split(/\r?\n/)) {
      const eq = line.indexOf('=');
      if (eq > 0) keys.add(line.slice(0, eq).trim());
    }
  }
  return keys;
}

/**
 * Cycles that do not pass through a `loop` node. The engine delivers
 * values along edges and runs a node once every inbound edge has
 * delivered, so a cycle never completes — the nodes in it simply stay
 * queued forever. That is a hang, not an error message, which is exactly
 * why it is worth catching here.
 */
function findDeadCycles(wf: Workflow, isLoop: (id: string) => boolean): string[][] {
  const out = new Map<string, string[]>();
  for (const e of wf.edges) (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e.to);

  const cycles: string[][] = [];
  const colour = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];

  const walk = (id: string) => {
    colour.set(id, 1);
    stack.push(id);
    for (const next of out.get(id) ?? []) {
      const c = colour.get(next) ?? 0;
      if (c === 1) {
        const at = stack.indexOf(next);
        const cycle = stack.slice(at);
        if (!cycle.some(isLoop)) cycles.push(cycle);
      } else if (c === 0) {
        walk(next);
      }
    }
    stack.pop();
    colour.set(id, 2);
  };

  for (const n of wf.nodes) if ((colour.get(n.id) ?? 0) === 0) walk(n.id);
  return cycles;
}

/** Nodes never reached from any entry node. */
function findUnreachable(wf: Workflow, entryIds: string[]): Set<string> {
  const out = new Map<string, string[]>();
  for (const e of wf.edges) (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e.to);
  const seen = new Set(entryIds);
  const queue = [...entryIds];
  while (queue.length) {
    for (const next of out.get(queue.shift()!) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return new Set(wf.nodes.filter((n) => !seen.has(n.id)).map((n) => n.id));
}

export function validate(wf: Workflow, specs: Map<string, NodeSpecInfo>): ValidationReport {
  const findings: Finding[] = [];
  const add = (f: Finding) => findings.push(f);
  const label = (n: WfNode) => specs.get(n.type)?.label ?? n.type;

  const inbound = new Map<string, number>();
  const outbound = new Map<string, Set<string>>();
  for (const e of wf.edges) {
    inbound.set(e.to, (inbound.get(e.to) ?? 0) + 1);
    (outbound.get(e.from) ?? outbound.set(e.from, new Set()).get(e.from)!).add(e.fromPort);
  }

  const entries = wf.nodes.filter((n) => specs.get(n.type)?.inputs === 0);
  const vars = declaredVars(wf.nodes);

  /* ── empty graph ─────────────────────────────────────────────────── */
  if (wf.nodes.length === 0) {
    add({ id: 'empty', level: 'error', message: 'This workflow has no nodes.', fix: 'Add a node from the palette to get started.' });
    return summarise(findings);
  }

  /* ── no entry point ──────────────────────────────────────────────── */
  if (!entries.length) {
    add({
      id: 'no-entry',
      level: 'error',
      message: 'Nothing can start this workflow — every node is waiting for an input.',
      fix: 'Add a source node (Current Project, Changed Files, Git Status) — they run without an input.',
    });
  }

  /* ── per node ────────────────────────────────────────────────────── */
  for (const n of wf.nodes) {
    const spec = specs.get(n.type);

    if (!spec) {
      add({ id: `unknown:${n.id}`, level: 'error', nodeId: n.id, message: `“${n.type}” is not a node type this engine knows.`, fix: 'Delete the node, or update AURA if this workflow came from a newer version.' });
      continue;
    }

    if (spec.disabled) {
      add({ id: `disabled:${n.id}`, level: 'warning', nodeId: n.id, message: `${spec.label} is not implemented yet — the run will skip it.`, fix: 'Remove it, or replace it with a node that works today.' });
    }

    // Required configuration. A field with no default and no placeholder-only
    // meaning is required when the node cannot do anything without it.
    for (const f of spec.fields) {
      const v = n.config[f.key];
      const empty = v === undefined || v === null || (typeof v === 'string' && !v.trim());
      const required = REQUIRED_FIELDS[n.type]?.includes(f.key) ?? false;
      if (required && empty) {
        add({ id: `field:${n.id}:${f.key}`, level: 'error', nodeId: n.id, message: `${spec.label} needs a value for “${f.label}”.`, fix: `Select the node and fill in ${f.label}.` });
      }
    }

    // Unresolved {{references}}.
    for (const f of spec.fields) {
      const v = n.config[f.key];
      if (typeof v !== 'string') continue;
      REF.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = REF.exec(v))) {
        const key = m[1];
        if (BUILTIN_REFS.has(key) || vars.has(key)) continue;
        // A warning, not an error: the engine interpolates an unknown key
        // to an empty string, so the run still completes — it just does so
        // with a gap in the text. Blocking Run on this would stop workflows
        // that do work, which is a worse failure than the one it prevents.
        add({
          id: `ref:${n.id}:${f.key}:${key}`,
          level: 'warning',
          nodeId: n.id,
          message: `${spec.label} refers to {{${key}}}, which nothing in this workflow defines — it will be replaced with nothing.`,
          fix: 'Add a Variables node that sets it, or use {{input}} for the value flowing in.',
        });
      }
    }

    // A node that needs an input but has none will run on empty text.
    // This is not a hard error — the engine delivers an empty value for
    // entry nodes, and the seeded fixtures rely on this (e.g. a leading
    // shell-command). Blocking Run here would make those workflows
    // unrunnable via the UI while the service accepts them.
    if (spec.inputs === 1 && !(inbound.get(n.id) ?? 0)) {
      add({ id: `noinput:${n.id}`, level: 'warning', nodeId: n.id, message: `${label(n)} has nothing connected to its input — it will run on empty text.`, fix: 'Connect an upstream node if this step needs prior output.' });
    }
    if (spec.inputs === 'many' && !(inbound.get(n.id) ?? 0) && !entries.includes(n)) {
      add({ id: `noinput-many:${n.id}`, level: 'warning', nodeId: n.id, message: `${label(n)} has no input connected — it will run on empty text.`, fix: 'Connect an upstream node, or configure the node so it does not need one.' });
    }

    // Multi-port logic nodes with a dangling branch.
    if (spec.outputs.length > 1) {
      const wired = outbound.get(n.id) ?? new Set();
      const dangling = spec.outputs.filter((p) => !wired.has(p));
      if (dangling.length && dangling.length < spec.outputs.length) {
        add({ id: `dangling:${n.id}`, level: 'warning', nodeId: n.id, message: `${label(n)} has nothing on its “${dangling.join('” and “')}” branch — that path stops there.`, fix: 'Connect the branch, or remove it if stopping is what you meant.' });
      }
    }
  }

  /* ── graph shape ─────────────────────────────────────────────────── */
  for (const cycle of findDeadCycles(wf, (id) => wf.nodes.find((n) => n.id === id)?.type === 'loop')) {
    add({
      id: `cycle:${cycle.join('>')}`,
      level: 'error',
      nodeId: cycle[0],
      message: `These nodes form a loop the run can never finish: ${cycle.map((id) => label(wf.nodes.find((n) => n.id === id)!)).join(' → ')}.`,
      fix: 'Remove one of the connections, or use a Loop node if you meant to repeat.',
    });
  }

  if (entries.length) {
    for (const id of findUnreachable(wf, entries.map((n) => n.id))) {
      const n = wf.nodes.find((x) => x.id === id)!;
      add({ id: `unreachable:${id}`, level: 'warning', nodeId: id, message: `${label(n)} is never reached — nothing connects to it from a starting node.`, fix: 'Connect it to the graph, or delete it.' });
    }
  }

  if (!wf.nodes.some((n) => n.type === 'output')) {
    add({ id: 'no-output', level: 'advice', message: 'This workflow has no Output node, so the run will not present a result.', fix: 'Add an Output node at the end to see what it produced.' });
  }

  if (wf.nodes.length > 30) {
    add({ id: 'large', level: 'advice', message: `${wf.nodes.length} nodes is large enough to be hard to follow.`, fix: 'Consider splitting part of it into a separate workflow.' });
  }

  return summarise(findings);
}

function summarise(findings: Finding[]): ValidationReport {
  const errors = findings.filter((f) => f.level === 'error').length;
  const warnings = findings.filter((f) => f.level === 'warning').length;
  const advice = findings.filter((f) => f.level === 'advice').length;
  return { findings, errors, warnings, advice, runnable: errors === 0 };
}

/**
 * Fields a node genuinely cannot run without.
 *
 * Derived from the `throw new Error('no … configured')` guards in
 * `packages/ai-service/src/workflow/nodes.ts` — so this list reports the
 * engine's own requirements rather than inventing stricter ones. Keep in
 * step until `FieldSpec` carries `required` from the service.
 * See docs/BACKEND_CONTRACTS_REQUIRED.md §2.
 */
const REQUIRED_FIELDS: Record<string, string[]> = {
  'selected-files': ['paths'],
  'export-file': ['path'],
  'shell-command': ['command'],
  'git-commit': ['message'],
  'http-request': ['url'],
  'slack-notify': ['webhookUrl'],
};

/** Findings that belong to one node, for the inspector and the node face. */
export function findingsFor(report: ValidationReport, nodeId: string): Finding[] {
  return report.findings.filter((f) => f.nodeId === nodeId);
}

/** The worst level present in a set of findings, or null. */
export function worstLevel(findings: Finding[]): FindingLevel | null {
  if (findings.some((f) => f.level === 'error')) return 'error';
  if (findings.some((f) => f.level === 'warning')) return 'warning';
  if (findings.some((f) => f.level === 'advice')) return 'advice';
  return null;
}
