/**
 * WorkflowDefinitionStore — versioned definition persistence (§21).
 * ==================================================================
 * One JSON file per definition: `<AURA_HOME>/workflow-defs/<id>.workflow.json`,
 * written atomically and pretty-printed so a definition is human-readable,
 * exportable and importable. Files carry `schemaVersion` and a `version`
 * revision counter that bumps on every save; a WorkflowRun records which
 * definition version it executed.
 *
 * Lifecycle rule: a definition may only be stored as `ready` when it
 * validates cleanly. Drafts may be incomplete — `draft` exists precisely
 * so half-built graphs can be saved. Promoting to `ready` is the moment
 * a definition becomes a runnable contract.
 *
 * The store validates with the real Fabric manifest as the capability
 * catalogue by default (`knownCapabilities`); a host may pass a narrower
 * set. `baseDir` overrides the AURA home for tests and embedding.
 */

import fs from 'node:fs';
import path from 'node:path';
import { homePath, readJsonFile, writeJsonFile } from './persist';
import { hasErrors, validateDefinition, type ValidationIssue } from './validate';
import { genId, WORKFLOW_SCHEMA_VERSION, type WorkflowDefinition, type WorkflowDefinitionInput, type WorkflowDefinitionSummary, type WorkflowStatus } from './types';

export interface WorkflowDefinitionStoreOptions {
  /** Overrides AURA_HOME for tests and embedding. */
  baseDir?: string;
  /** Narrower capability catalogue than the full Fabric manifest. */
  knownCapabilities?: ReadonlySet<string>;
}

export class WorkflowDefinitionStore {
  readonly knownCapabilities?: ReadonlySet<string>;
  private readonly dir: string;

  constructor(opts: WorkflowDefinitionStoreOptions = {}) {
    this.knownCapabilities = opts.knownCapabilities;
    this.dir = opts.baseDir ? path.join(opts.baseDir, 'workflow-defs') : homePath('workflow-defs');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private fileOf(id: string): string {
    return path.join(this.dir, `${id}.workflow.json`);
  }

  private validate(wf: WorkflowDefinition): ValidationIssue[] {
    return validateDefinition(wf, { knownCapabilities: this.knownCapabilities });
  }

  private assertStorable(wf: WorkflowDefinition): void {
    const issues = this.validate(wf);
    if (wf.status === 'ready' && hasErrors(issues)) {
      const first = issues.find((i) => i.severity === 'error');
      throw new Error(`definition is not valid for "ready": ${first?.message ?? 'unknown error'}`);
    }
  }

  list(projectId?: string | null): WorkflowDefinitionSummary[] {
    const out: WorkflowDefinitionSummary[] = [];
    let files: string[] = [];
    try {
      files = fs.readdirSync(this.dir);
    } catch {
      return out;
    }
    for (const f of files) {
      if (!f.endsWith('.workflow.json')) continue;
      const wf = readJsonFile<WorkflowDefinition | null>(path.join(this.dir, f), null);
      // A record that is not a recognisable definition (missing id, name
      // or node list) is corrupt — it is skipped, never interpreted as a
      // new or empty workflow, and never overwritten. A malformed file
      // must not crash the whole list surface.
      if (!wf || typeof wf !== 'object' || typeof wf.id !== 'string' || !wf.id) continue;
      if (!Array.isArray(wf.nodes)) continue;
      if (projectId !== undefined && wf.projectId !== projectId) continue;
      out.push(definitionSummary(wf));
    }
    // updatedAt may be absent on a corrupt-but-parseable record; the sort
    // must never throw, so absent timestamps sort oldest.
    return out.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  }

  get(id: string): WorkflowDefinition | null {
    return readJsonFile<WorkflowDefinition | null>(this.fileOf(id), null);
  }

  /**
   * Create a definition from writable input. Id, timestamps and the
   * version counter are derived here, never trusted from the input.
   * `status` defaults to 'draft' — a brand-new definition must earn
   * 'ready' by validating.
   */
  create(input: WorkflowDefinitionInput = {}): WorkflowDefinition {
    const now = new Date().toISOString();
    const wf: WorkflowDefinition = {
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      id: genId('wf'),
      name: typeof input.name === 'string' && input.name.trim() ? input.name.trim() : 'Untitled workflow',
      description: typeof input.description === 'string' ? input.description : '',
      projectId: typeof input.projectId === 'string' ? input.projectId : null,
      status: input.status === 'ready' ? 'ready' : 'draft',
      version: 1,
      nodes: Array.isArray(input.nodes) ? input.nodes : [],
      edges: Array.isArray(input.edges) ? input.edges : [],
      settings: input.settings && typeof input.settings === 'object' ? input.settings : {},
      createdAt: now,
      updatedAt: now,
    };
    this.assertStorable(wf);
    writeJsonFile(this.fileOf(wf.id), wf);
    return wf;
  }

  /** Write a definition verbatim (embedding, tests, migration). The
   *  definition is treated as final, like `runStore.record`; a `ready`
   *  definition still must validate cleanly. */
  record(wf: WorkflowDefinition): void {
    this.assertStorable(wf);
    writeJsonFile(this.fileOf(wf.id), wf);
  }

  /** Full-definition save. Bumps `version` and `updatedAt`; `id` and `createdAt` are immutable. */
  save(id: string, def: Partial<WorkflowDefinition>): WorkflowDefinition | null {
    const existing = this.get(id);
    if (!existing) return null;
    const wf: WorkflowDefinition = {
      ...existing,
      ...def,
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      id,
      createdAt: existing.createdAt,
      version: existing.version + 1,
      updatedAt: new Date().toISOString(),
      status: def.status === 'ready' || def.status === 'draft' ? def.status : existing.status,
      nodes: Array.isArray(def.nodes) ? def.nodes : existing.nodes,
      edges: Array.isArray(def.edges) ? def.edges : existing.edges,
    };
    this.assertStorable(wf);
    writeJsonFile(this.fileOf(id), wf);
    return wf;
  }

  patch(id: string, partial: { name?: string; description?: string; projectId?: string | null; status?: WorkflowStatus; settings?: WorkflowDefinition['settings'] }): WorkflowDefinition | null {
    const existing = this.get(id);
    if (!existing) return null;
    return this.save(id, { ...existing, ...partial });
  }

  /** Promote a draft to ready — only when it validates cleanly. */
  markReady(id: string): WorkflowDefinition | null {
    const existing = this.get(id);
    if (!existing) return null;
    return this.save(id, { status: 'ready' });
  }

  remove(id: string): boolean {
    try {
      fs.rmSync(this.fileOf(id));
      return true;
    } catch {
      return false;
    }
  }

  /** Portable JSON — a definition without any runtime state. */
  exportJson(id: string): string | null {
    const wf = this.get(id);
    if (!wf) return null;
    return JSON.stringify(wf, null, 2);
  }

  /**
   * Import a definition from JSON (the export format). Gets a fresh id
   * and timestamps; `version` starts at 1. Rejects unparseable JSON and
   * definitions that cannot even be stored as drafts (e.g. unknown node
   * types are tolerated as drafts; garbage is not).
   */
  importJson(text: string): { ok: true; definition: WorkflowDefinition } | { ok: false; error: string } {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return { ok: false, error: 'not valid JSON' };
    }
    if (!raw || typeof raw !== 'object') return { ok: false, error: 'expected a workflow definition object' };
    const input = raw as WorkflowDefinitionInput;
    const now = new Date().toISOString();
    const wf: WorkflowDefinition = {
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      id: genId('wf'),
      name: typeof input.name === 'string' && input.name.trim() ? input.name.trim() : 'Imported workflow',
      description: typeof input.description === 'string' ? input.description : '',
      projectId: typeof input.projectId === 'string' ? input.projectId : null,
      status: 'draft', // imported definitions always land as drafts
      version: 1,
      nodes: Array.isArray(input.nodes) ? input.nodes : [],
      edges: Array.isArray(input.edges) ? input.edges : [],
      settings: input.settings && typeof input.settings === 'object' ? input.settings : {},
      createdAt: now,
      updatedAt: now,
    };
    this.assertStorable(wf);
    writeJsonFile(this.fileOf(wf.id), wf);
    return { ok: true, definition: wf };
  }
}

export function definitionSummary(wf: WorkflowDefinition): WorkflowDefinitionSummary {
  return {
    id: wf.id,
    name: wf.name,
    description: wf.description,
    projectId: wf.projectId,
    status: wf.status,
    version: wf.version,
    nodeCount: wf.nodes.length,
    edgeCount: wf.edges.length,
    triggerCount: wf.nodes.filter((n) => n.type === 'manual' || n.type === 'schedule' || n.type === 'git-event' || n.type === 'file-change' || n.type === 'mission-event' || n.type === 'agent-event' || n.type === 'environment-event').length,
    createdAt: wf.createdAt,
    updatedAt: wf.updatedAt,
  };
}

/** The enabled trigger nodes of a definition — what the runtime should listen to. */
export function enabledTriggers(wf: WorkflowDefinition): WorkflowDefinition['nodes'] {
  return wf.nodes.filter((n) => {
    if (n.type !== 'manual' && n.type !== 'schedule' && n.type !== 'git-event' && n.type !== 'file-change' && n.type !== 'mission-event' && n.type !== 'agent-event' && n.type !== 'environment-event') return false;
    return n.config.enabled !== false;
  });
}