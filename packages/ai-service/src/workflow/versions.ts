/**
 * Workflow versions — the immutable thing a run executes.
 * ==================================================================
 * A `Workflow` in `store.ts` is a DRAFT: it is edited, saved, renamed and
 * overwritten. A `WorkflowVersion` is a frozen copy of that draft's graph
 * at a moment, and it is what a `WorkflowRun` references.
 *
 * Why this separation is not optional: without it, editing a workflow
 * while a run is in flight changes what that run is executing, and a
 * finished run's record points at a graph that no longer exists. Both make
 * run history meaningless — "v5 succeeded 40 times; v6 has failed 3 of 4"
 * is the sentence the Runs view has to be able to produce, and it needs
 * versions to produce it.
 *
 * **Version on run, not on save.** Auto-versioning every keystroke
 * produces two hundred meaningless versions; versioning on run produces a
 * history in which every version was actually executed, which is the
 * history people want. `ensureVersionForRun()` is the whole mechanism: it
 * publishes the current draft only when the graph genuinely differs from
 * the latest version, so pressing Run twice without editing reuses one
 * version rather than minting two identical ones. A manual `publish()`
 * with a note is the escape hatch.
 *
 * Versions are append-only. "Restore v3" creates v8 whose graph equals
 * v3's — history is never rewound, matching how the Fabric's audit trail
 * already behaves.
 *
 *   ~/.aura/workflow-versions/<workflowId>/<versionId>.json
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { homePath, readJsonFile, writeJsonFile } from '../persist';
import { genId, type WfEdge, type WfNode, type Workflow } from './types';

const versionsDir = (workflowId: string) => {
  const d = homePath('workflow-versions', workflowId);
  mkdirSync(d, { recursive: true });
  return d;
};
const versionFile = (workflowId: string, versionId: string) =>
  path.join(versionsDir(workflowId), `${versionId}.json`);

export interface WorkflowVersion {
  id: string;
  workflowId: string;
  /** Monotonic within a workflow, starting at 1. What the UI shows as "v7". */
  number: number;
  /** Name at publish time — a rename must not retitle finished runs. */
  name: string;
  description: string;
  createdAt: string;
  /** Who published it: `user`, `run:<id>`, `ai-generate`, `import`. */
  createdBy: string;
  /** Optional free-text note, for manual versions. */
  note?: string;
  /**
   * Stable hash of the executable graph — nodes, their types and configs,
   * and edges. Names and positions are excluded on purpose: moving a node
   * on the canvas is not a new version of the behaviour, and treating it
   * as one would reintroduce exactly the version sprawl this design avoids.
   */
  graphHash: string;
  nodes: WfNode[];
  edges: WfEdge[];
  /** Version this was restored from, when it was created by a restore. */
  restoredFrom?: string;
}

export interface WorkflowVersionSummary {
  id: string;
  workflowId: string;
  number: number;
  name: string;
  createdAt: string;
  createdBy: string;
  note?: string;
  graphHash: string;
  nodeCount: number;
  restoredFrom?: string;
}

/**
 * The identity of a graph's BEHAVIOUR.
 *
 * Config keys are sorted so an inspector that rewrites a config object in
 * a different key order does not mint a version; node ids and edge
 * endpoints are included because rewiring is a behaviour change. `x`/`y`
 * are excluded — see `graphHash` above.
 */
export function hashGraph(nodes: WfNode[], edges: WfEdge[]): string {
  const canonicalNodes = [...nodes]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((n) => ({
      id: n.id,
      type: n.type,
      config: Object.fromEntries(Object.entries(n.config ?? {}).sort(([a], [b]) => a.localeCompare(b))),
    }));
  const canonicalEdges = [...edges]
    .map((e) => ({ from: e.from, fromPort: e.fromPort, to: e.to }))
    .sort((a, b) => `${a.from}${a.fromPort}${a.to}`.localeCompare(`${b.from}${b.fromPort}${b.to}`));
  return createHash('sha256')
    .update(JSON.stringify({ nodes: canonicalNodes, edges: canonicalEdges }))
    .digest('hex')
    .slice(0, 32);
}

export class WorkflowVersionStore {
  list(workflowId: string): WorkflowVersionSummary[] {
    const out: WorkflowVersionSummary[] = [];
    for (const f of readdirSync(versionsDir(workflowId))) {
      if (!f.endsWith('.json')) continue;
      const v = readJsonFile<WorkflowVersion | null>(path.join(versionsDir(workflowId), f), null);
      if (!v?.id) continue;
      out.push({
        id: v.id, workflowId: v.workflowId, number: v.number, name: v.name,
        createdAt: v.createdAt, createdBy: v.createdBy, note: v.note,
        graphHash: v.graphHash, nodeCount: v.nodes.length, restoredFrom: v.restoredFrom,
      });
    }
    return out.sort((a, b) => b.number - a.number);
  }

  get(workflowId: string, versionId: string): WorkflowVersion | null {
    return readJsonFile<WorkflowVersion | null>(versionFile(workflowId, versionId), null);
  }

  latest(workflowId: string): WorkflowVersion | null {
    const [newest] = this.list(workflowId);
    return newest ? this.get(workflowId, newest.id) : null;
  }

  /**
   * Freeze the draft as a new version. Always creates one — callers that
   * only want a version when the graph changed use `ensureVersionForRun`.
   */
  publish(wf: Workflow, createdBy: string, note?: string, restoredFrom?: string): WorkflowVersion {
    const existing = this.list(wf.id);
    const number = existing.length ? Math.max(...existing.map((v) => v.number)) + 1 : 1;
    const version: WorkflowVersion = {
      id: genId('wfv'),
      workflowId: wf.id,
      number,
      name: wf.name,
      description: wf.description,
      createdAt: new Date().toISOString(),
      createdBy,
      note,
      graphHash: hashGraph(wf.nodes, wf.edges),
      // Deep-copied so a later edit of the draft object in memory can never
      // reach through and mutate a published version.
      nodes: JSON.parse(JSON.stringify(wf.nodes)) as WfNode[],
      edges: JSON.parse(JSON.stringify(wf.edges)) as WfEdge[],
      restoredFrom,
    };
    writeJsonFile(versionFile(wf.id, version.id), version);
    return version;
  }

  /**
   * The version a run should execute.
   *
   * Reuses the latest version when the draft's graph is behaviourally
   * identical to it, and publishes a new one otherwise. This is what makes
   * "version on run" produce a useful history instead of a noisy one.
   */
  ensureVersionForRun(wf: Workflow, by: string): WorkflowVersion {
    const latest = this.latest(wf.id);
    const hash = hashGraph(wf.nodes, wf.edges);
    if (latest && latest.graphHash === hash) return latest;
    return this.publish(wf, by);
  }

  /**
   * Restore an old version by publishing its graph as a NEW version.
   *
   * Never rewinds. A history you can rewrite cannot be used to explain why
   * a run behaved the way it did, which is the only reason to keep one.
   */
  restore(wf: Workflow, versionId: string, by = 'user'): WorkflowVersion | null {
    const source = this.get(wf.id, versionId);
    if (!source) return null;
    return this.publish(
      { ...wf, nodes: source.nodes, edges: source.edges },
      by,
      `Restored from v${source.number}`,
      source.id,
    );
  }

  /** Drop every version of a workflow. Called only when the workflow is deleted. */
  removeAll(workflowId: string): void {
    try { rmSync(homePath('workflow-versions', workflowId), { recursive: true, force: true }); } catch { /* nothing to remove */ }
  }
}
