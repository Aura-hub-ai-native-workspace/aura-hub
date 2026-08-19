/**
 * WorkflowRunStore — run history (§15, §16).
 * ==================================================================
 * One JSON file per run: `<AURA_HOME>/workflow-runs/<workflowId>/<runId>.json`,
 * written atomically. A run is an immutable record of one execution of
 * one definition version — the store only records, lists and prunes;
 * runs are created by the runtime phases, never here.
 */

import fs from 'node:fs';
import path from 'node:path';
import { homePath, readJsonFile, writeJsonFile } from './persist';
import { WORKFLOW_SCHEMA_VERSION, type WorkflowRun, type WorkflowRunStats, type WorkflowRunSummary } from './types';

export interface WorkflowRunStoreOptions {
  /** Overrides AURA_HOME for tests and embedding. */
  baseDir?: string;
}

export class WorkflowRunStore {
  private readonly root: string;

  constructor(opts: WorkflowRunStoreOptions = {}) {
    this.root = opts.baseDir ? path.join(opts.baseDir, 'workflow-runs') : homePath('workflow-runs');
    fs.mkdirSync(this.root, { recursive: true });
  }

  private dirOf(workflowId: string): string {
    return path.join(this.root, workflowId);
  }

  private fileOf(workflowId: string, runId: string): string {
    return path.join(this.dirOf(workflowId), `${runId}.json`);
  }

  /** Newest first, bounded by `limit`. */
  list(workflowId?: string, opts: { limit?: number } = {}): WorkflowRunSummary[] {
    const limit = opts.limit ?? 100;
    const dir = workflowId ? this.dirOf(workflowId) : this.root;
    let files: string[] = [];
    try {
      files = workflowId ? fs.readdirSync(dir) : fs.readdirSync(dir).flatMap((wf) => {
        try {
          return fs.readdirSync(path.join(dir, wf)).map((f) => path.join(wf, f));
        } catch {
          return [];
        }
      });
    } catch {
      return [];
    }
    const out: WorkflowRunSummary[] = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const run = readJsonFile<WorkflowRun | null>(path.join(dir, f), null);
      // A record that is not a recognisable run (missing id, workflow id,
      // or not an object) is corrupt — it is skipped, never interpreted as
      // a new or empty run, and never overwritten. This is deliberate:
      // a malformed file must not crash the whole list surface.
      if (!run || typeof run !== 'object' || typeof run.runId !== 'string' || !run.runId) continue;
      if (typeof run.workflowId !== 'string' || !run.workflowId) continue;
      out.push(runSummary(run));
    }
    // startedAt may be absent on a corrupt-but-parseable record; the sort
    // must never throw, so absent timestamps sort oldest.
    return out.sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? '')).slice(0, limit);
  }

  get(workflowId: string, runId: string): WorkflowRun | null {
    return readJsonFile<WorkflowRun | null>(this.fileOf(workflowId, runId), null);
  }

  /** Persist a run record (atomic). The record itself is treated as final. */
  record(run: WorkflowRun): void {
    fs.mkdirSync(this.dirOf(run.workflowId), { recursive: true });
    writeJsonFile(this.fileOf(run.workflowId, run.runId), run);
  }

  remove(workflowId: string, runId: string): boolean {
    try {
      fs.rmSync(this.fileOf(workflowId, runId));
      return true;
    } catch {
      return false;
    }
  }

  /** §16 — the per-workflow history projection. */
  stats(workflowId: string): WorkflowRunStats {
    const runs = this.list(workflowId, { limit: 10_000 });
    const durations = runs.filter((r) => r.ms !== undefined).map((r) => r.ms as number);
    return {
      runs: runs.length,
      success: runs.filter((r) => r.status === 'completed').length,
      failed: runs.filter((r) => r.status === 'failed').length,
      cancelled: runs.filter((r) => r.status === 'cancelled').length,
      avgDurationMs: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0,
      lastRunAt: runs[0]?.startedAt,
      lastStatus: runs[0]?.status,
    };
  }
}

export function runSummary(run: WorkflowRun): WorkflowRunSummary {
  return {
    runId: run.runId,
    workflowId: run.workflowId,
    workflowVersion: run.workflowVersion,
    triggerId: run.triggerId,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    ms: run.finishedAt && run.startedAt ? Date.parse(run.finishedAt) - Date.parse(run.startedAt) : undefined,
    error: run.error,
  };
}

/** A fresh, empty run record the runtime will fill in. */
export function newRun(input: { workflowId: string; workflowVersion: number; projectId: string | null; triggerId?: string | null; inputs?: Record<string, unknown> }): WorkflowRun {
  const now = new Date().toISOString();
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    runId: `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    workflowId: input.workflowId,
    workflowVersion: input.workflowVersion,
    projectId: input.projectId,
    triggerId: input.triggerId ?? null,
    status: 'queued',
    startedAt: now,
    nodeRuns: [],
    inputs: input.inputs ?? {},
    outputs: {},
    auditIds: [],
    createdAt: now,
  };
}