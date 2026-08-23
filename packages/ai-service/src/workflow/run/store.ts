/**
 * WorkflowRunStore — durable runs, checkpointed per node.
 * ==================================================================
 * One JSON file per run under
 * `~/.aura/workflow-runs/<workflowId>/<runId>.json`, written atomically
 * through the same `persist.ts` helpers `WorkflowStore`, `MissionStore`
 * and `AutomationStore` already use. No new persistence system, no
 * database, no event store — the research is explicit that a desktop
 * product wants lightweight JSON checkpointing rather than event sourcing,
 * and this is that.
 *
 * The checkpoint IS the run record. There is no separate checkpoint file
 * to fall out of sync with it: `checkpoint()` writes the run after every
 * node resolves, so the newest file on disk always describes the furthest
 * point the run reached. A process that dies between two nodes leaves a
 * record whose state is `running` and whose nodes are all terminal up to
 * that point — which is precisely what `reconcileInterrupted()` needs to
 * recognise an orphan on the next start.
 *
 * Retention is bounded per workflow. A single-user desktop app does not
 * need unbounded run history, and a directory that grows forever is a
 * reliability problem, not a feature.
 */

import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { homePath, readJsonFile, writeJsonFile } from '../../persist';
import { genId } from '../types';
import {
  MAX_RUN_LOG,
  MAX_TRANSITIONS,
  isTerminalRunState,
  summarizeRun,
  type EvidenceRef,
  type NodeRunRecord,
  type NodeState,
  type RunState,
  type RunTrigger,
  type WorkflowRun,
  type WorkflowRunSummary,
} from './types';

/** Runs kept per workflow. Oldest terminal runs are pruned past this. */
const MAX_RUNS_PER_WORKFLOW = 200;
/** Entries the cross-workflow index holds. Bounded like everything else. */
const MAX_INDEX_ENTRIES = 5000;

/**
 * The cross-workflow index.
 *
 * `list()` used to walk every workflow directory and parse every run file
 * to answer "show me all runs" — O(runs) file reads for a screen that
 * renders 50 rows. This is one file holding one summary per run, written
 * whenever a run is saved.
 *
 * It is a CACHE, never an authority. Every entry is derived from a run
 * file, the run files remain the truth, and `rebuildIndex()` reconstructs
 * it from disk whenever it is missing, unparseable, or found to disagree.
 * An index that could drift into being believed over the records it
 * summarises would be a second source of truth for run history.
 */
const INDEX_FILE = () => homePath('workflow-runs', 'index.json');

interface RunIndex {
  version: 1;
  runs: WorkflowRunSummary[];
}

const runsRoot = () => {
  const d = homePath('workflow-runs');
  mkdirSync(d, { recursive: true });
  return d;
};
const runsDir = (workflowId: string) => {
  const d = homePath('workflow-runs', workflowId);
  mkdirSync(d, { recursive: true });
  return d;
};
const runFile = (workflowId: string, runId: string) => path.join(runsDir(workflowId), `${runId}.json`);

export interface CreateRunInput {
  workflowId: string;
  versionId: string;
  workflowName: string;
  projectId: string;
  projectPath: string;
  trigger: RunTrigger;
  inputs?: Record<string, string>;
}

export class WorkflowRunStore {
  create(input: CreateRunInput): WorkflowRun {
    const run: WorkflowRun = {
      id: genId('run'),
      workflowId: input.workflowId,
      versionId: input.versionId,
      workflowName: input.workflowName,
      projectId: input.projectId,
      projectPath: input.projectPath,
      state: 'queued',
      trigger: input.trigger,
      createdAt: new Date().toISOString(),
      ms: 0,
      nodes: {},
      vars: {},
      inputs: input.inputs ?? {},
      outputs: [],
      evidence: [],
      resumable: false,
      log: [],
    };
    this.save(run);
    this.prune(input.workflowId);
    return run;
  }

  get(workflowId: string, runId: string): WorkflowRun | null {
    return readJsonFile<WorkflowRun | null>(runFile(workflowId, runId), null);
  }

  /** Find a run without knowing its workflow — the id is globally unique. */
  find(runId: string): WorkflowRun | null {
    for (const wfId of this.workflowIds()) {
      const run = this.get(wfId, runId);
      if (run) return run;
    }
    return null;
  }

  save(run: WorkflowRun): void {
    // The log is trimmed at the point of persistence rather than at the
    // point of append, so a burst of logging inside one node cannot grow
    // the file even transiently.
    if (run.log.length > MAX_RUN_LOG) run.log = run.log.slice(-MAX_RUN_LOG);
    writeJsonFile(runFile(run.workflowId, run.id), run);
    this.indexUpsert(summarizeRun(run));
  }

  /* ── index ───────────────────────────────────────────────────────── */

  private readIndex(): RunIndex | null {
    const raw = readJsonFile<RunIndex | null>(INDEX_FILE(), null);
    if (!raw || raw.version !== 1 || !Array.isArray(raw.runs)) return null;
    return raw;
  }

  private indexUpsert(summary: WorkflowRunSummary): void {
    const index = this.readIndex() ?? { version: 1 as const, runs: [] };
    const at = index.runs.findIndex((r) => r.id === summary.id);
    if (at >= 0) index.runs[at] = summary;
    else index.runs.push(summary);
    if (index.runs.length > MAX_INDEX_ENTRIES) {
      index.runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      index.runs.length = MAX_INDEX_ENTRIES;
    }
    writeJsonFile(INDEX_FILE(), index);
  }

  private indexRemove(runId: string): void {
    const index = this.readIndex();
    if (!index) return;
    const next = index.runs.filter((r) => r.id !== runId);
    if (next.length !== index.runs.length) writeJsonFile(INDEX_FILE(), { version: 1, runs: next });
  }

  /**
   * Rebuild the index from the run files, which are the authority.
   *
   * Called when the index is missing or unreadable, and available as a
   * repair. Returns how many runs it found, so a caller can report a
   * repair rather than performing one silently.
   */
  rebuildIndex(): number {
    const runs: WorkflowRunSummary[] = [];
    for (const wfId of this.workflowIds()) {
      for (const f of readdirSync(runsDir(wfId))) {
        if (!f.endsWith('.json')) continue;
        const run = readJsonFile<WorkflowRun | null>(path.join(runsDir(wfId), f), null);
        if (!run?.id) continue;
        runs.push(summarizeRun(run));
      }
    }
    runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (runs.length > MAX_INDEX_ENTRIES) runs.length = MAX_INDEX_ENTRIES;
    writeJsonFile(INDEX_FILE(), { version: 1, runs });
    return runs.length;
  }

  /**
   * Persist the run as it stands. Named for what it is used for: this is
   * called after every node resolves, and it is the only durability
   * mechanism a workflow run has.
   */
  checkpoint(run: WorkflowRun): void {
    this.save(run);
  }

  /**
   * Run summaries, newest first — the whole index, or one workflow's slice.
   *
   * Served from the index. A missing or corrupt index rebuilds itself from
   * the run files rather than returning an empty list, because "no runs"
   * and "I could not read my cache" must never look the same to a caller.
   */
  list(workflowId?: string): WorkflowRunSummary[] {
    let index = this.readIndex();
    if (!index) { this.rebuildIndex(); index = this.readIndex(); }
    const runs = index?.runs ?? [];
    const filtered = workflowId ? runs.filter((r) => r.workflowId === workflowId) : runs;
    return [...filtered].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * The cross-workflow run index, filtered and paged server-side.
   *
   * This exists so the UI never has to fetch every workflow's history and
   * merge it client-side — a merge the client would get wrong the moment
   * retention pruned one workflow but not another.
   */
  index(query: {
    workflowId?: string;
    projectId?: string;
    state?: RunState;
    trigger?: string;
    /** Substring match on the workflow name. */
    q?: string;
    since?: string;
    limit?: number;
    offset?: number;
  } = {}): { runs: WorkflowRunSummary[]; total: number; offset: number; limit: number } {
    let runs = this.list(query.workflowId);
    if (query.projectId) runs = runs.filter((r) => r.projectId === query.projectId);
    if (query.state) runs = runs.filter((r) => r.state === query.state);
    if (query.trigger) runs = runs.filter((r) => r.trigger === query.trigger);
    if (query.since) runs = runs.filter((r) => r.createdAt >= query.since!);
    if (query.q) {
      const needle = query.q.toLowerCase();
      runs = runs.filter((r) => r.workflowName.toLowerCase().includes(needle));
    }
    const total = runs.length;
    const offset = Math.max(0, query.offset ?? 0);
    const limit = Math.max(1, Math.min(500, query.limit ?? 100));
    return { runs: runs.slice(offset, offset + limit), total, offset, limit };
  }

  /** Runs parked on a human decision, across every workflow. */
  /**
   * Runs genuinely waiting on a person.
   *
   * A superseded run is excluded: its question was answered and another run
   * picked the work up, so leaving it here would keep a resolved item in
   * the approvals inbox forever — which is exactly what it used to do.
   */
  listAwaitingApproval(): WorkflowRunSummary[] {
    return this.list().filter((r) => r.state === 'awaiting-approval' && !r.supersededBy);
  }

  /**
   * Mark a run as continued by another, and stop offering it as resumable.
   *
   * The `state` is deliberately left alone. `awaiting-approval` remains the
   * honest description of how THAT leg ended, and rewriting it would lose
   * the reason the chain exists. What changes is that it stops claiming to
   * be actionable.
   */
  markSuperseded(workflowId: string, runId: string, bySupersedingRunId: string): WorkflowRun | null {
    const run = this.get(workflowId, runId);
    if (!run || run.supersededBy) return run;
    run.supersededBy = bySupersedingRunId;
    run.supersededAt = new Date().toISOString();
    run.resumable = false;
    run.notResumableReason = `continued as run ${bySupersedingRunId}`;
    this.save(run);
    return run;
  }

  /** Every leg of one logical execution, oldest first. */
  resumeChain(workflowId: string, runId: string): WorkflowRun[] {
    // Walk back to the head, then forward — a caller may hand us any leg.
    let head = this.get(workflowId, runId);
    if (!head) return [];
    const guard = new Set<string>();
    while (head.trigger.kind === 'resume' && !guard.has(head.id)) {
      guard.add(head.id);
      const prior = this.get(workflowId, head.trigger.of);
      if (!prior) break;
      head = prior;
    }
    const chain: WorkflowRun[] = [head];
    const seen = new Set<string>([head.id]);
    let cursor: WorkflowRun | null = head;
    while (cursor?.supersededBy && !seen.has(cursor.supersededBy)) {
      seen.add(cursor.supersededBy);
      cursor = this.get(workflowId, cursor.supersededBy);
      if (cursor) chain.push(cursor);
    }
    return chain;
  }

  /** Counts by state, for a dashboard that must not fetch every run. */
  stats(projectId?: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.list()) {
      if (projectId && r.projectId !== projectId) continue;
      out[r.state] = (out[r.state] ?? 0) + 1;
    }
    return out;
  }

  remove(workflowId: string, runId: string): boolean {
    try { rmSync(runFile(workflowId, runId)); this.indexRemove(runId); return true; } catch { return false; }
  }

  removeAll(workflowId: string): void {
    try { rmSync(runsDir(workflowId), { recursive: true, force: true }); } catch { /* nothing to remove */ }
    this.rebuildIndex();
  }

  private workflowIds(): string[] {
    try {
      return readdirSync(runsRoot()).filter((d) => {
        if (d.endsWith('.json')) return false; // the index lives here too
        try { return statSync(path.join(runsRoot(), d)).isDirectory(); } catch { return false; }
      });
    } catch {
      return [];
    }
  }

  /** Drop the oldest TERMINAL runs past the retention bound. */
  private prune(workflowId: string): void {
    const all = this.list(workflowId);
    if (all.length <= MAX_RUNS_PER_WORKFLOW) return;
    // Never prunes a run that could still advance — an in-flight or parked
    // run being deleted to make room would lose work, which no retention
    // policy is worth.
    const terminal = all.filter((r) => isTerminalRunState(r.state)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const excess = all.length - MAX_RUNS_PER_WORKFLOW;
    for (const r of terminal.slice(0, excess)) this.remove(workflowId, r.id);
  }

  /* ── crash recovery ──────────────────────────────────────────────── */

  /**
   * Mark runs that were in flight when the process died.
   *
   * Called once at startup. A run left `running` or `queued` cannot be
   * running now — nothing is executing it — so leaving it in that state
   * would have the Runs view assert something false. It becomes
   * `interrupted`, which is modelled as `failed` with an explicit reason
   * and `resumable` computed from whether any node actually completed.
   *
   * `awaiting-approval` is deliberately NOT touched: that run is correctly
   * parked, its approval request is itself durable (`fabric-approvals.json`),
   * and a restart is not an answer to the question it asked.
   */
  reconcileInterrupted(): WorkflowRunSummary[] {
    const recovered: WorkflowRunSummary[] = [];
    for (const wfId of this.workflowIds()) {
      for (const f of readdirSync(runsDir(wfId))) {
        if (!f.endsWith('.json')) continue;
        const run = readJsonFile<WorkflowRun | null>(path.join(runsDir(wfId), f), null);
        if (!run?.id) continue;
        if (run.state !== 'running' && run.state !== 'queued') continue;
        const completed = Object.values(run.nodes).filter((n) => n.state === 'succeeded').length;
        run.state = 'failed';
        run.error = 'AURA stopped while this run was in flight.';
        run.finishedAt = new Date().toISOString();
        run.resumable = completed > 0;
        if (!run.resumable) run.notResumableReason = 'No node completed before the interruption, so there is nothing to resume from.';
        run.log.push({
          at: run.finishedAt,
          nodeId: null,
          level: 'warn',
          text: `Run interrupted — recovered at startup with ${completed} completed node${completed === 1 ? '' : 's'}.`,
        });
        this.save(run);
        recovered.push(summarizeRun(run));
      }
    }
    return recovered;
  }
}

/* ── record helpers, shared by the engine ─────────────────────────── */

export function emptyNodeRecord(nodeId: string, type: string, iteration = 0): NodeRunRecord {
  return { nodeId, type, state: 'queued', iteration, ms: 0, attempts: 0, evidence: [], transitions: [] };
}

/**
 * Record one state change. The ONLY place `node.state` is assigned, so a
 * transition can never be applied without being recorded.
 */
export function transitionNode(node: NodeRunRecord, to: NodeState, note?: string): void {
  const from = node.state;
  if (from === to && node.transitions.length) return;
  node.state = to;
  node.transitions.push({ at: new Date().toISOString(), from, to, note });
  if (node.transitions.length > MAX_TRANSITIONS) node.transitions.splice(0, node.transitions.length - MAX_TRANSITIONS);
}

export function appendLog(run: WorkflowRun, nodeId: string | null, level: 'info' | 'warn' | 'error', text: string): void {
  run.log.push({ at: new Date().toISOString(), nodeId, level, text });
  if (run.log.length > MAX_RUN_LOG) run.log.splice(0, run.log.length - MAX_RUN_LOG);
}

export function attachEvidence(run: WorkflowRun, nodeId: string, evidence: EvidenceRef): void {
  run.evidence.push(evidence);
  const node = run.nodes[nodeId];
  if (node) node.evidence.push(evidence);
}

/** The run-level state implied by how the last node resolved. */
export function runStateFor(nodeState: NodeRunRecord['state']): RunState | null {
  switch (nodeState) {
    case 'awaiting-approval': return 'awaiting-approval';
    case 'cancelled': return 'cancelled';
    case 'timed-out': return 'timed-out';
    case 'failed': return 'failed';
    // `denied` is a governance outcome, not a crash — but the run cannot
    // continue past an action it was refused, so it stops as failed with
    // the policy reason carried on the node.
    case 'denied': return 'failed';
    default: return null;
  }
}
