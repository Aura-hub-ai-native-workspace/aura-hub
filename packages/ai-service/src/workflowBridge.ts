/**
 * WorkflowBridge — the production seam between AURA Hub and @aura/workflow.
 * ==================================================================
 * Phase 7: the new runtime becomes the future authority. This module
 * owns the boundary so the legacy module never executes anything again:
 *
 *   HTTP / UI (legacy shape)      legacy WorkflowStore (builder only)
 *        ↓                              ↓
 *   WorkflowBridge            convertLegacyWorkflow()
 *        ↓                              ↓
 *   @aura/workflow            WorkflowDefinition
 *        ↓
 *   WorkflowRuntime → RunController → CapabilityFabric → policy →
 *   approval → executor → verify → audit
 *
 * Responsibilities:
 *   - convert legacy builder graphs to validated WorkflowDefinitions
 *     (explicit unsupported-node reporting — never silent semantic
 *     conversion)
 *   - migrate the legacy ~/.aura/workflows store into
 *     workflow-defs/ + workflow-runs/ (idempotent, IDs preserved)
 *   - run workflows through the new runtime, streaming legacy-shaped
 *     RunEvents so the existing UI keeps working unchanged
 *   - approval management through the ONE Fabric approval authority
 *   - manual trigger API (runId/status, audit correlated)
 *   - interrupted-run recovery so singleFlight never deadlocks after a
 *     crash (stale-lock recovery using existing persistence)
 *   - optional TriggerScheduler with the host event sources (Phase 6)
 *
 * The bridge contains no execution authority: every side effect still
 * routes through the Fabric.
 */

import {
  WorkflowDefinitionStore,
  WorkflowRunStore,
  WorkflowRuntime,
  TriggerScheduler,
  hasErrors,
  validateDefinition,
  type RuntimeEvent,
  type WorkflowDefinition,
  type WorkflowNode,
  type WorkflowRun,
  type WorkflowRunStatus,
} from '@aura/workflow';
import { CAPABILITY_MANIFEST, type CapabilityFabric } from '@aura/capability-fabric';
import type { MissionRecord } from './mission/types';
import type { Workflow as LegacyWorkflow, NodeRunState, RunEvent, RunResult } from './workflow/types';
import type { WorkspaceManager } from './workspace';
import { createFileChangeEventSource, createGitEventSource, createMissionEventSource } from './workflow/triggerSources';
import { registerWorkflowRunHook, type WorkflowRunHook } from './fabric/executors';

/* ══════════════════════════════════════════════════════════════════
   Legacy node → new node mapping (Phase 7 Step 3)
   ══════════════════════════════════════════════════════════════════ */

type MappedNode =
  | { kind: 'capability'; capabilityId: string; inputMap?: Record<string, unknown>; note?: string }
  | { kind: 'node'; nodeType: WorkflowNode['type']; config?: Record<string, unknown>; note?: string }
  | { kind: 'trigger' }
  | { kind: 'unsupported'; reason: string };

const legacyNodeMap: Record<string, (config: Record<string, unknown>) => MappedNode> = {
  'shell-command': (c) => ({ kind: 'capability', capabilityId: 'terminal.execute', inputMap: { command: c.command ?? '' } }),
  'git-status': () => ({ kind: 'capability', capabilityId: 'git.status' }),
  'git-diff': (c) => ({ kind: 'capability', capabilityId: 'git.diff', inputMap: { staged: c.staged === true } }),
  'git-commit': (c) => ({ kind: 'capability', capabilityId: 'git.commit', inputMap: { message: c.message ?? '' } }),
  'git-branch': (c) => ({ kind: 'capability', capabilityId: 'git.branch', inputMap: { name: c.name ?? '' } }),
  'http-request': (c) => ({
    kind: 'capability', capabilityId: 'http.request',
    inputMap: { method: c.method ?? 'GET', url: c.url ?? '', headers: c.headers ?? '', body: c.body ?? '', timeoutMs: c.timeoutMs ?? 10_000 },
  }),
  'changed-files': () => ({
    kind: 'capability', capabilityId: 'git.status',
    note: 'approximate: changed-files (a data node) maps to git.status — the output shape differs from the legacy node',
  }),
  condition: (c) => ({
    kind: 'node', nodeType: 'condition',
    config: { op: c.check ?? 'contains', value: c.value ?? '' },
    note: 'legacy "check" renamed to the new "op"',
  }),
  delay: (c) => ({ kind: 'node', nodeType: 'delay', config: { ms: typeof c.ms === 'number' ? c.ms : 1000 } }),
  loop: (c) => {
    const mode = c.mode === 'for-each-line' ? 'for-each-line' : 'repeat';
    return mode === 'for-each-line'
      ? { kind: 'node', nodeType: 'for-each', config: {}, note: 'legacy loop "for-each-line" maps to the new for-each node' }
      : { kind: 'node', nodeType: 'loop', config: { times: typeof c.times === 'number' ? c.times : 3 } };
  },
  'export-file': (c) => ({ kind: 'node', nodeType: 'export', config: { path: c.path ?? '' } }),
  output: () => ({ kind: 'node', nodeType: 'result' }),
  prompt: (c) => ({ kind: 'node', nodeType: 'generate', config: { instruction: c.prompt ?? '' } }),
  groq: (c) => ({ kind: 'node', nodeType: 'generate', config: { instruction: c.prompt ?? '' }, note: 'legacy "groq" provider selector is not representable — uses the default provider seam' }),
  'generate-markdown': (c) => ({ kind: 'node', nodeType: 'generate', config: { instruction: c.prompt ?? '', format: 'markdown' } }),
  'generate-code': (c) => ({ kind: 'node', nodeType: 'generate', config: { instruction: c.prompt ?? '', format: 'code' } }),
  'generate-json': (c) => ({ kind: 'node', nodeType: 'generate', config: { instruction: c.prompt ?? '', format: 'json' } }),
  'user-input': () => ({ kind: 'trigger' }),
  'current-project': () => ({ kind: 'unsupported', reason: 'data source node with no capability equivalent' }),
  'selected-files': () => ({ kind: 'unsupported', reason: 'data source node with no capability equivalent' }),
  'current-conversation': () => ({ kind: 'unsupported', reason: 'data source node with no capability equivalent' }),
  'project-memory': () => ({ kind: 'unsupported', reason: 'data source node with no capability equivalent' }),
  'engineering-memory': () => ({ kind: 'unsupported', reason: 'data source node — memory.search returns records, not the legacy shape' }),
  'coding-engine': () => ({ kind: 'unsupported', reason: 'pipeline engine node with no capability equivalent' }),
  'fullstack-engine': () => ({ kind: 'unsupported', reason: 'pipeline engine node with no capability equivalent' }),
  'research-engine': () => ({ kind: 'unsupported', reason: 'disabled legacy node' }),
  'intent-classifier': () => ({ kind: 'unsupported', reason: 'pipeline engine node with no capability equivalent' }),
  'prompt-enhancer': () => ({ kind: 'unsupported', reason: 'pipeline engine node with no capability equivalent' }),
  'save-memory': () => ({ kind: 'unsupported', reason: 'memory.search reads memory; there is no memory write capability yet' }),
  'create-note': () => ({ kind: 'unsupported', reason: 'no note capability in the manifest' }),
  'slack-notify': () => ({ kind: 'unsupported', reason: 'no slack capability in the manifest' }),
  variables: () => ({ kind: 'unsupported', reason: 'no variables node in the new vocabulary — use expressions instead' }),
};

export interface UnsupportedNode {
  nodeId: string;
  legacyType: string;
  reason: string;
}

export interface ConversionReport {
  unsupported: UnsupportedNode[];
  /** Hard problems — the definition cannot run faithfully. */
  errors: string[];
  /** Faithfulness notes — conversion is approximate but runnable. */
  warnings: string[];
}

export interface ConversionResult {
  definition: WorkflowDefinition;
  report: ConversionReport;
}

/** The Fabric manifest capability ids — the definition validator's catalogue. */
export const KNOWN_CAPABILITIES = new Set(CAPABILITY_MANIFEST.map((c) => c.id));

/**
 * Convert a legacy builder graph into a WorkflowDefinition.
 *
 * The result is always `draft`: it earns `ready` only when it validates
 * cleanly AND has no unsupported nodes. Unsupported nodes are reported,
 * never silently pruned.
 */
export function convertLegacyWorkflow(wf: LegacyWorkflow): ConversionResult {
  const report: ConversionReport = { unsupported: [], errors: [], warnings: [] };
  const entryIds = wf.nodes.filter((n) => !wf.edges.some((e) => e.to === n.id)).map((n) => n.id);
  const userInputCount = wf.nodes.filter((n) => n.type === 'user-input').length;

  const nodes: WorkflowNode[] = [];
  const edges: WorkflowDefinition['edges'] = [];
  let triggerId: string | null = null;

  for (const n of wf.nodes) {
    const mapped = legacyNodeMap[n.type];
    if (!mapped) {
      report.unsupported.push({ nodeId: n.id, legacyType: n.type, reason: `unknown legacy node type "${n.type}"` });
      continue;
    }
    const m = mapped(n.config ?? {});
    if (m.kind === 'unsupported') {
      report.unsupported.push({ nodeId: n.id, legacyType: n.type, reason: m.reason });
      continue;
    }
    if (m.kind === 'trigger') {
      if (triggerId === null) {
        triggerId = n.id;
        nodes.push({ id: n.id, type: 'manual', x: n.x, y: n.y, config: {} });
        report.warnings.push(`node ${n.id} (user-input): converted to the manual trigger — run inputs arrive as the trigger payload`);
      } else {
        report.errors.push(`multiple user-input nodes are not representable (${n.id} and ${triggerId}) — rework the workflow to use run inputs`);
      }
      continue;
    }
    let converted: WorkflowNode;
    if (m.kind === 'capability') {
      converted = {
        id: n.id, type: 'capability',
        x: n.x, y: n.y,
        config: { capabilityId: m.capabilityId, inputMap: inputMapToText(m.inputMap ?? {}) },
      };
    } else {
      converted = { id: n.id, type: m.nodeType, x: n.x, y: n.y, config: m.config ?? {} };
    }
    if (m.note) report.warnings.push(`node ${n.id} (${n.type}): ${m.note}`);
    nodes.push(converted);
  }

  for (const e of wf.edges) {
    const fromExists = nodes.some((x) => x.id === e.from);
    const toExists = nodes.some((x) => x.id === e.to);
    if (!fromExists || !toExists) continue;
    const fromNode = nodes.find((x) => x.id === e.from)!;
    // export/result are sinks in the new vocabulary — legacy graphs may
    // pass data THROUGH them; that flow is not representable, so it is
    // a hard error (never a silent drop).
    if (fromNode.type === 'export' || fromNode.type === 'result') {
      report.errors.push(`edge from ${e.from} leaves a sink node (${fromNode.type}) — output nodes are terminal in the new runtime; rework the workflow`);
      continue;
    }
    let fromPort = e.fromPort;
    if (fromPort !== 'true' && fromPort !== 'false' && fromPort !== 'each' && fromPort !== 'done') fromPort = 'out';
    if ((fromNode.type === 'condition' || fromNode.type === 'branch') && fromPort !== 'true' && fromPort !== 'false') {
      report.errors.push(`edge from ${e.from} uses port "${fromPort}" but condition/branch only has true/false`);
      continue;
    }
    edges.push({ id: e.id ?? `e-${e.from}-${e.to}`, from: e.from, fromPort, to: e.to, toPort: 'in' });
  }

  // The new runtime needs a trigger. A single user-input node became it;
  // otherwise prepend a manual trigger wired to the legacy entry nodes
  // (nodes with no incoming edges) so the graph stays runnable.
  if (nodes.length > 0 && triggerId === null) {
    triggerId = 'migrated-trigger';
    nodes.unshift({ id: triggerId, type: 'manual', x: 0, y: 0, config: {} });
    for (const entryId of entryIds) {
      if (!nodes.some((x) => x.id === entryId)) continue;
      edges.push({ id: `e-${triggerId}-${entryId}`, from: triggerId, fromPort: 'out', to: entryId, toPort: 'in' });
    }
    report.warnings.push('prepended a manual trigger node — legacy graphs have no explicit trigger');
  }
  if (userInputCount > 0 && triggerId === null) {
    report.errors.push('workflow has user-input nodes but no convertible entry — rework it');
  }

  const definition: WorkflowDefinition = {
    schemaVersion: 1,
    id: wf.id,
    name: wf.name,
    description: wf.description ?? '',
    projectId: null, // legacy workflows run against the currently open project
    status: 'draft',
    version: 1,
    nodes,
    edges,
    settings: {},
    createdAt: wf.createdAt,
    updatedAt: wf.updatedAt,
  };

  const issues = validateDefinition(definition, { knownCapabilities: KNOWN_CAPABILITIES });
  for (const i of issues) {
    if (i.severity === 'error') report.errors.push(i.message);
    else if (i.severity === 'warning') report.warnings.push(i.message);
  }

  return { definition, report };
}

/** True when the conversion is faithful enough to promote to `ready`. */
export function legacyIsRunnable(conversion: ConversionResult): boolean {
  return conversion.report.errors.length === 0 && conversion.report.unsupported.length === 0
    && !hasErrors(validateDefinition(conversion.definition, { knownCapabilities: KNOWN_CAPABILITIES }));
}

/** "key: value" per line — the new capability node's input mapping format. */
function inputMapToText(map: Record<string, unknown>): string {
  return Object.entries(map)
    .filter(([, v]) => v !== '' && v !== undefined && v !== null)
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join('\n');
}

/* ══════════════════════════════════════════════════════════════════
   The bridge
   ══════════════════════════════════════════════════════════════════ */

export interface MigrationEntry {
  workflowId: string;
  name: string;
  outcome: 'migrated' | 'partial' | 'skipped-existing' | 'invalid';
  status: WorkflowDefinition['status'];
  unsupported: UnsupportedNode[];
  errors: string[];
  warnings: string[];
}

export interface WorkflowBridgeOptions {
  fabric: CapabilityFabric;
  manager: WorkspaceManager;
  /** Overrides AURA_HOME for isolated tests. */
  baseDir?: string;
  /** Start the TriggerScheduler with the host event sources. Default true. */
  schedule?: boolean;
  /** Injectable timers (scheduler tests). */
  now?: () => Date;
  setTimeout?: (fn: () => void, ms: number) => { clear(): void };
  eventSourcePollMs?: number;
}

export class WorkflowBridge {
  readonly definitions: WorkflowDefinitionStore;
  readonly runs: WorkflowRunStore;
  readonly runtime: WorkflowRuntime;
  readonly scheduler: TriggerScheduler | null;
  /** The ONE Fabric this bridge drives (read access for operators/tests). */
  readonly fabric: CapabilityFabric;
  readonly manager: WorkspaceManager;

  constructor(opts: WorkflowBridgeOptions) {
    this.manager = opts.manager;
    this.fabric = opts.fabric;
    this.definitions = new WorkflowDefinitionStore({
      baseDir: opts.baseDir,
      knownCapabilities: KNOWN_CAPABILITIES,
    });
    this.runs = new WorkflowRunStore({ baseDir: opts.baseDir });

    const projectResolver = {
      resolve: (projectId: string | null) => {
        if (!projectId) return null;
        const p = this.manager.registry.get(projectId);
        return p ? p.path : null;
      },
    };

    this.runtime = new WorkflowRuntime(
      {
        fabric: this.fabric,
        ai: {
          generate: async (request) => {
            const res = await this.manager.pipeline.generate({ user: request.prompt, system: 'You are AURA Workflow.' });
            return res.ok
              ? { ok: true, output: { text: res.text } }
              : { ok: false, error: res.error?.message ?? 'provider unavailable' };
          },
        },
        missions: {
          wait: async (missionId, until, timeoutMs) => {
            const t0 = Date.now();
            while (Date.now() - t0 < timeoutMs) {
              for (const project of this.manager.registry.list()) {
                const rec = this.manager.getMission(project.id, missionId);
                if (!rec) continue;
                const state = rec.execution?.status ?? 'idle';
                if (state === until || state === 'completed' || state === 'failed' || state === 'cancelled') {
                  return { ok: state === until, state };
                }
              }
              await new Promise<void>((r) => setTimeout(r, 250));
            }
            return { ok: false, error: `mission ${missionId} did not reach ${until} within ${timeoutMs}ms` };
          },
          update: async (missionId, patch) => {
            for (const project of this.manager.registry.list()) {
              const rec = this.manager.getMission(project.id, missionId);
              if (!rec) continue;
              const saved = this.manager.missions.save(project.id, { ...rec, ...patch } as MissionRecord);
              return saved ? { ok: true } : { ok: false, error: 'save failed' };
            }
            return { ok: false, error: `no such mission: ${missionId}` };
          },
        },
        projectPath: (projectId) => {
          const p = this.manager.registry.get(projectId);
          return p ? p.path : undefined;
        },
        askApproval: async () => false, // no UI here; approvals park until decided via the API
      },
      { definitions: this.definitions, runs: this.runs },
    );

    if (opts.schedule !== false) {
      const sources = {
        'file-change': createFileChangeEventSource({ projects: projectResolver, pollMs: opts.eventSourcePollMs }),
        'git-event': createGitEventSource({ projects: projectResolver, pollMs: opts.eventSourcePollMs }),
        'mission-event': createMissionEventSource({ projects: projectResolver, missions: this.manager.missions, pollMs: opts.eventSourcePollMs }),
      };
      this.scheduler = new TriggerScheduler({
        definitions: this.definitions,
        runs: this.runs,
        runtime: this.runtime,
        eventSources: sources,
        now: opts.now,
        setTimeout: opts.setTimeout,
      });
    } else {
      this.scheduler = null;
    }

    this.recoverInterruptedRuns();

    // workflow.run: the Fabric delegates to this bridge (Step 12). Late
    // binding keeps the fabric/executor graph acyclic; the depth guard
    // bounds recursion in-process — static cycle detection is not
    // attempted because inputMap expressions are dynamic.
    registerWorkflowRunHook(this.childWorkflowHook);
  }

  /** module-level-ish depth guard: a child run may not nest deeper. */
  private readonly MAX_WORKFLOW_DEPTH = 3;
  private workflowDepth = 0;
  /** Set once shutdown begins; a second call is a no-op. */
  private shutDown = false;

  private readonly childWorkflowHook: WorkflowRunHook = {
    runWorkflow: async (input: { workflowId: string; projectId?: string | null; inputs?: Record<string, string> }) => {
      if (this.workflowDepth >= this.MAX_WORKFLOW_DEPTH) {
        return { runId: '', status: 'failed' as const, error: `workflow nesting depth limit (${this.MAX_WORKFLOW_DEPTH}) reached` };
      }
      const def = this.definitions.get(input.workflowId);
      if (!def) return { runId: '', status: 'failed' as const, error: `no workflow definition "${input.workflowId}"` };
      if (def.status !== 'ready') return { runId: '', status: 'failed' as const, error: `workflow "${input.workflowId}" is not ready to run` };
      this.workflowDepth += 1;
      try {
        const run = await this.runtime.startRun(input.workflowId, {
          inputs: input.inputs ?? {},
          projectId: input.projectId ?? null,
          trigger: { type: 'manual', payload: input.inputs ?? {} },
        });
        // Settle the child: wait until it completes, fails, or parks at an
        // approval (paused is terminal for the parent). The timeout keeps a
        // runaway child from hanging the parent forever.
        const deadline = Date.now() + 5 * 60_000;
        while (Date.now() < deadline) {
          const cur = this.runtime.getRun(run.runId);
          if (!cur) return { runId: run.runId, status: 'failed' as const, error: 'child run vanished' };
          if (cur.status === 'completed' || cur.status === 'failed' || cur.status === 'paused') {
            return { runId: run.runId, status: cur.status, error: cur.status === 'failed' ? cur.error : undefined };
          }
          await new Promise<void>((r) => setTimeout(r, 100));
        }
        return { runId: run.runId, status: 'running' as const, error: 'child still running after 5 minutes' };
      } finally {
        this.workflowDepth -= 1;
      }
    },
  };

  /* ── migration (Phase 7 Step 4) ────────────────────────────────── */

  /**
   * One-way, idempotent migration of the legacy ~/.aura/workflows store
   * into workflow-defs/. Existing definitions are never overwritten.
   * Malformed workflows are reported, never silently dropped.
   */
  migrateAll(): MigrationEntry[] {
    const out: MigrationEntry[] = [];
    for (const summary of this.manager.workflows.list()) {
      const wf = this.manager.workflows.get(summary.id);
      if (!wf) {
        out.push({ workflowId: summary.id, name: summary.name, outcome: 'invalid', status: 'draft', unsupported: [], errors: ['legacy file unreadable'], warnings: [] });
        continue;
      }
      out.push(this.migrateOne(wf));
    }
    return out;
  }

  /** Convert + record one legacy workflow (idempotent per id). */
  migrateOne(wf: LegacyWorkflow): MigrationEntry {
    const existing = this.definitions.get(wf.id);
    if (existing) {
      return {
        workflowId: wf.id, name: wf.name, outcome: 'skipped-existing', status: existing.status,
        unsupported: [], errors: [], warnings: [],
      };
    }
    const { definition, report } = convertLegacyWorkflow(wf);
    const runnable = report.errors.length === 0 && report.unsupported.length === 0;
    definition.status = runnable ? 'ready' : 'draft';
    try {
      this.definitions.record(definition);
    } catch (e) {
      report.errors.push((e as Error).message);
    }
    return {
      workflowId: wf.id, name: wf.name,
      outcome: runnable ? 'migrated' : 'partial',
      status: definition.status,
      unsupported: report.unsupported, errors: report.errors, warnings: report.warnings,
    };
  }

  /** Keep the new store in sync after the builder saves a workflow. */
  syncLegacy(wf: LegacyWorkflow): MigrationEntry {
    return this.migrateOne(wf);
  }

  /* ── running (Phase 7 Step 2) ──────────────────────────────────── */

  /**
   * Run a legacy-shaped workflow through the new runtime. A conversion
   * with unsupported nodes is refused (the definition would silently do
   * less than the builder shows). Emits legacy RunEvents so the SSE
   * consumer is unchanged.
   */
  async runLegacy(
    wf: LegacyWorkflow,
    opts: { inputs?: Record<string, string>; projectId?: string | null },
    emit: (e: RunEvent) => void,
  ): Promise<RunResult> {
    const t0 = Date.now();
    const { definition, report } = convertLegacyWorkflow(wf);
    if (report.errors.length > 0) throw new Error(`workflow is not convertible: ${report.errors[0]}`);
    if (report.unsupported.length > 0) {
      const first = report.unsupported[0]!;
      throw new Error(`node ${first.nodeId} (${first.legacyType}) is not supported by the new runtime: ${first.reason}`);
    }
    definition.status = 'ready';
    this.definitions.record(definition);

    emit({ type: 'start', workflowId: wf.id, at: new Date().toISOString() });
    const off = this.runtime.on((event) => this.toLegacyEvent(event, emit));
    try {
      const run = await this.runtime.startRun(wf.id, {
        inputs: opts.inputs ?? {},
        projectId: opts.projectId ?? null,
        trigger: { type: 'manual', payload: opts.inputs ?? {} },
      });
      const ms = Date.now() - t0;
      const outputs = run.nodeRuns
        .filter((nr) => nr.status === 'success')
        .map((nr) => ({ nodeId: nr.nodeId, title: nr.nodeId, text: outputText(nr.outputs) }));
      // The legacy UI only understands completed/failed — a run parked at
      // an approval gate must NOT look like a silent success or a crash:
      // surface it as a failure with an explicit, actionable error.
      const status: 'completed' | 'failed' = run.status === 'completed' ? 'completed' : 'failed';
      const error = run.error ?? (run.status === 'paused'
        ? `run ${run.runId} paused at an approval gate (${run.nodeRuns.filter((nr) => nr.status === 'approval-required').map((nr) => nr.nodeId).join(', ') || 'unknown node'}) — decide via the approvals API, then resume POST /workflows/runs/${run.runId}/resume`
        : undefined);
      emit({ type: 'done', status, ms, error });
      return {
        status,
        ms,
        outputs,
        nodes: Object.fromEntries(run.nodeRuns.map((nr) => [nr.nodeId, { status: nodeStatus(nr.status), ms: 0 }])),
        error,
      };
    } finally {
      off();
    }
  }

  /** Manual trigger (Phase 7 Step 9): returns runId/status, audit-correlated. */
  async startManual(workflowId: string, opts: { inputs?: Record<string, string>; projectId?: string | null; triggerPayload?: unknown } = {}): Promise<{ runId: string; status: WorkflowRunStatus }> {
    const wf = this.definitions.get(workflowId);
    if (!wf) throw new Error(`no workflow definition "${workflowId}"`);
    if (wf.status !== 'ready') throw new Error(this.notReadyReason(workflowId, wf));
    const run = await this.runtime.startRun(workflowId, {
      inputs: opts.inputs ?? {},
      projectId: opts.projectId ?? null,
      trigger: { type: 'manual', payload: opts.triggerPayload ?? opts.inputs ?? {} },
    });
    return { runId: run.runId, status: run.status };
  }

  /**
   * Why a definition cannot run, named precisely. A bare "not ready"
   * hides the actual blocker — an unsupported node, a conversion error —
   * so the operator gets the same detail the migration report would have
   * shown, rather than a dead end.
   */
  private notReadyReason(workflowId: string, wf: WorkflowDefinition): string {
    const base = `workflow "${workflowId}" is not ready to run`;
    // Definitions created natively in the new vocabulary carry no
    // migration report; fall back to validation output.
    const issues = validateDefinition(wf, { knownCapabilities: KNOWN_CAPABILITIES });
    const error = issues.find((i) => i.severity === 'error');
    if (error) return `${base}: ${error.message}`;
    // A migrated (legacy) definition may have been recorded as a draft
    // because conversion hit unsupported nodes — name them.
    const legacy = this.manager.workflows.get(workflowId);
    if (legacy) {
      const { report } = convertLegacyWorkflow(legacy);
      const unsupported = report.unsupported.map((u) => `${u.legacyType} (${u.nodeId}): ${u.reason}`);
      if (unsupported.length > 0) return `${base}: unsupported node(s) ${unsupported.join('; ')}`;
      if (report.errors.length > 0) return `${base}: ${report.errors[0]}`;
    }
    return base;
  }

  /**
   * Webhook-style fire (Phase 7 Step 2): token verified by caller.
   *
   * Trigger semantics match the scheduler: when `singleFlight` is set, a
   * replayed webhook (duplicate delivery) that arrives while the
   * workflow already has an active run is skipped — the event is
   * acknowledged, no duplicate run is created. Manual `startManual` is
   * deliberately NOT single-flighted (the Run button is an explicit
   * user act); a webhook is an event and inherits the scheduler guard.
   */
  async startTriggered(workflowId: string, opts: { inputs?: Record<string, string>; projectId?: string | null; triggerPayload?: unknown } = {}): Promise<{ runId: string; status: WorkflowRunStatus }> {
    const wf = this.definitions.get(workflowId);
    if (wf && wf.settings.singleFlight === true) {
      const active = this.runs.list(workflowId, { limit: 100 })
        .find((s) => s.status === 'running' || s.status === 'paused' || s.status === 'queued');
      if (active) {
        // Duplicate delivery folded into the already-active run — the
        // caller is handed its runId/status so both sides agree on what
        // is actually running, and no second run is created.
        return { runId: active.runId, status: active.status };
      }
    }
    return this.startManual(workflowId, opts);
  }

  /* ── approval management (Phase 7 Step 8) ───────────────────────── */

  pendingApprovals() {
    return this.fabric.pendingApprovals();
  }

  approvalById(requestId: string) {
    return this.fabric.approvalById(requestId);
  }

  /** Record the human's decision via the ONE Fabric authority; the
   *  runtime resumes or fails the parked node on the fabric event. */
  decideApproval(requestId: string, granted: boolean, decidedBy = 'user', reason?: string) {
    return this.runtime.decideApproval(requestId, granted, decidedBy, reason);
  }

  resumeRun(runId: string) {
    return this.runtime.resumeRun(runId);
  }

  /* ── reads ─────────────────────────────────────────────────────── */

  getRun(runId: string): WorkflowRun | null {
    return this.runtime.getRun(runId);
  }

  listRuns(workflowId?: string, opts?: { limit?: number }) {
    return this.runtime.listRuns(workflowId, opts);
  }

  getDefinition(workflowId: string): WorkflowDefinition | null {
    return this.definitions.get(workflowId);
  }

  listDefinitions() {
    return this.definitions.list();
  }

  /* ── crash recovery (Phase 7 Step 11) ──────────────────────────── */

  /**
   * Settle runs left 'running'/'queued' by a crashed process. The run
   * store is the persistence; there is no separate lock file. A
   * 'running' record with no live controller cannot be running — it was
   * interrupted.
   *
   * The interrupted node's own frontier is preserved, and a run that
   * already parked at an approval gate before the crash must recover to
   * `paused` — not `failed` — so the human decision is still answerable
   * and the gate's identity survives. Other stale 'running'/'queued'
   * runs settle to `failed` (never silently resume — there is no
   * in-flight continuation to re-enter). Paused runs survive untouched;
   * singleFlight keeps blocking while a pauseable run exists.
   */
  recoverInterruptedRuns(): number {
    let settled = 0;
    for (const summary of this.runs.list(undefined, { limit: 1000 })) {
      if (summary.status !== 'running' && summary.status !== 'queued') continue;
      if (this.runtime.hasLiveController(summary.runId)) continue; // live controller — not stale
      const run = this.runs.get(summary.workflowId, summary.runId);
      if (!run) continue;
      const parkedAtGate = run.nodeRuns.some((nr) => nr.status === 'approval-required' || nr.status === 'paused');
      if (parkedAtGate) {
        run.status = 'paused';
        run.error = 'interrupted by process restart (run was parked at an approval gate — decide via the approvals API, then resume)';
      } else {
        run.status = 'failed';
        run.error = 'interrupted by process restart';
        run.finishedAt = new Date().toISOString();
      }
      this.runs.record(run);
      settled += 1;
    }
    return settled;
  }

  /* ── scheduler ─────────────────────────────────────────────────── */

  startScheduler(): void {
    // Shutdown is terminal: re-starting the scheduler after a shutdown
    // would re-register timers/watchers behind the runtime's back. The
    // runtime already rejects new runs, so this guard keeps the two in
    // agreement instead of silently resurrecting a half-dead process.
    if (this.shutDown) return;
    this.scheduler?.start();
  }

  stopScheduler(): void {
    this.scheduler?.stop();
  }

  /* ── lifecycle ────────────────────────────────────────────────── */

  /**
   * Ordered shutdown: stop accepting new runs (scheduler + event
   * sources), then release the runtime's live controllers. Idempotent
   * and safe to call twice — a double shutdown is a no-op.
   */
  shutdown(): void {
    if (this.shutDown) return;
    this.shutDown = true;
    this.stopScheduler();
    this.runtime.shutdown();
  }

  /* ── legacy event translation ──────────────────────────────────── */

  private toLegacyEvent(event: RuntimeEvent, emit: (e: RunEvent) => void): void {
    if (event.type === 'node-settled') {
      emit({ type: 'node', nodeId: event.nodeId, status: legacyNodeState(event.status) });
    }
  }
}

/* ── status translation ──────────────────────────────────────────── */

function outputText(outputs: unknown): string {
  const v = (outputs as { value?: unknown } | undefined)?.value;
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v ?? '');
  } catch {
    return '';
  }
}

function nodeStatus(s: string): NodeRunState {
  switch (s) {
    case 'success': return 'completed';
    case 'failed':
    case 'denied': return 'failed';
    case 'skipped': return 'skipped';
    case 'waiting': return 'waiting';
    case 'paused':
    case 'approval-required': return 'waiting';
    default: return 'completed';
  }
}

function legacyNodeState(s: string): NodeRunState {
  return nodeStatus(s);
}