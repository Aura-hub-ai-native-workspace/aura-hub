/**
 * Automation integration — binds the AutomationEngine to real actions.
 * ==================================================================
 * This is the ONLY place where the automation package's injected action
 * registry is filled with REAL implementations. Each action calls the
 * same public seams the AI workspace uses (diagnosis engine, governance
 * platform, knowledge fabric, engineering memory) — never duplicated
 * logic, and every human safety gate (accept-before-write) is kept.
 */

import {
  AutomationEngine,
  AutomationScheduler,
  AutomationStore,
  type ActionResult,
  type AutomationEvent,
  type AutomationRunEvent,
  type AutomationRule,
  type ScheduleState,
} from '@aura/automation';
import {
  getEngineeringAudit,
  getSecurityReport,
  getDocumentationHealth,
  isCancellation,
} from '@aura/governance';
import { FullStackKnowledgeEngine } from '@aura/knowledge-fullstack';
import type { PipelineManager } from './pipeline';
import type { ProjectMemory } from './memory';
import { homePath, readJsonFile, writeJsonFile } from './persist';
import { runDiagnosis } from './diagnosis/orchestrator';
import type { DiagnosisStore } from './diagnosis/store';
import type { DiagnosisEvent } from './diagnosis/types';

export interface AutomationHost {
  /** Resolve a project's root path (throws if unknown). */
  projectPath(projectId: string): string;
  /** Pipeline for the project (for diagnosis + knowledge update). */
  pipelineFor(projectId: string): PipelineManager;
  /** Memory store for the project (for the save-memory action). */
  memoryFor(projectId: string): ProjectMemory;
  diagnoses: DiagnosisStore;
  /**
   * Hand a workflow to the one Workflow Engine.
   *
   * Injected, like every other side effect this package uses, so the
   * Automation Engine never gains a second way to execute a graph. Absent
   * on hosts that have no workflow engine, in which case the action
   * refuses rather than silently doing nothing.
   */
  runWorkflow?(input: {
    workflowId: string;
    projectId: string;
    ruleId: string;
    automationRunId: string;
    event: string;
    signal?: AbortSignal;
  }): Promise<{ ok: true; runId: string; runState: string } | { ok: false; error: string }>;
  signal?: AbortSignal;
}

export interface AutomationRuntime {
  engine: AutomationEngine;
  store: AutomationStore;
  /** The clock. Present only when the host supplied a project resolver. */
  scheduler: AutomationScheduler;
  emit?: (e: AutomationRunEvent) => void;
  /** Subscribe to run events (for SSE/UI streaming). Returns an unsubscribe fn. */
  subscribe(fn: (e: AutomationRunEvent) => void): () => void;
}

/**
 * A Stop reached an action that was cooperating. The result is a FAILED action
 * with a plain statement of what was and was not done; the engine keeps the run
 * `cancelled` (the first terminal state wins) and records this as the action's
 * own outcome. Anything other than a cancellation is rethrown untouched.
 */
function stoppedBy(e: unknown, signal: AbortSignal | undefined, what: string): ActionResult {
  if (signal?.aborted || isCancellation(e)) return { ok: false, error: what };
  throw e;
}

function ok(summary: string): ActionResult {
  return { ok: true, summary };
}

/**
 * Where the scheduler's small state lives.
 *
 * `~/.aura/automation/schedule-state.json`, through the same atomic
 * write-then-rename every other store in this service uses. It holds only
 * last/next fire times and a missed count — no rule data, which stays in
 * `AutomationStore`, and no second copy of anything.
 */
function schedulePersistence() {
  const file = () => homePath('automation', 'schedule-state.json');
  return {
    load: () => readJsonFile<Record<string, ScheduleState>>(file(), {}),
    save: (state: Record<string, ScheduleState>) => writeJsonFile(file(), state),
  };
}

/** Build a configured AutomationEngine whose actions call the real engines. */
export function createAutomationRuntime(host: AutomationHost, emit?: (e: AutomationRunEvent) => void): AutomationRuntime {
  const store = new AutomationStore();
  const listeners = new Set<(e: AutomationRunEvent) => void>();
  const emitAll = (e: AutomationRunEvent) => {
    emit?.(e);
    for (const fn of listeners) fn(e);
  };

  const engine = new AutomationEngine({
    store,
    emit: emitAll,
    actions: {
      'run-diagnosis': async (ctx, config): Promise<ActionResult> => {
        const root = host.projectPath(ctx.projectId);
        const pipeline = host.pipelineFor(ctx.projectId);
        // `||` (not `??`): the built-in template ships `config.filePath: ''`
        // as an explicit "no override — use the event payload" placeholder.
        // `??` only falls through on null/undefined, so an empty string
        // would win and permanently mask a real filePath in the payload.
        const filePath = String(config.filePath || ctx.event.payload.filePath || '');
        if (!filePath) return { ok: false, error: 'run-diagnosis requires a filePath in the action config or event payload' };
        const events: DiagnosisEvent[] = [];
        const emitDiag = (e: DiagnosisEvent) => events.push(e);
        const record = await runDiagnosis(
          pipeline,
          host.memoryFor(ctx.projectId),
          host.diagnoses,
          root,
          { projectId: ctx.projectId, filePath, language: String(config.language ?? ''), selectionRange: null },
          emitDiag,
          ctx.signal,
        );
        return ok(`diagnosis ${record.id} — ${record.classification.category}`);
      },

      'run-governance-audit': async (ctx, config): Promise<ActionResult> => {
        const root = host.projectPath(ctx.projectId);
        const scopeRaw = String(config.scope ?? 'daily');
        const scope: 'daily' | 'weekly' | 'release' | 'architecture' =
          scopeRaw === 'weekly' ? 'weekly' : scopeRaw === 'release' ? 'release' : scopeRaw === 'architecture' ? 'architecture' : 'daily';
        try {
          const report = await getEngineeringAudit({ projectPath: root, scope, signal: ctx.signal });
          return ok(`audit ${report.scope} — overall ${report.overallHealth}/100 (${report.grade})`);
        } catch (e) {
          return stoppedBy(e, ctx.signal, 'governance audit stopped before it finished; no audit snapshot was written');
        }
      },

      'run-security-review': async (ctx): Promise<ActionResult> => {
        const root = host.projectPath(ctx.projectId);
        try {
          const report = await getSecurityReport({ projectPath: root, signal: ctx.signal });
          return ok(`security review — ${report.findings.length} findings`);
        } catch (e) {
          return stoppedBy(e, ctx.signal, 'security review stopped before it finished; it is read-only, so nothing was changed');
        }
      },

      'run-docs-review': async (ctx): Promise<ActionResult> => {
        const root = host.projectPath(ctx.projectId);
        try {
          const report = await getDocumentationHealth({ projectPath: root, signal: ctx.signal });
          return ok(`docs review — ${report.issues.length} issues`);
        } catch (e) {
          return stoppedBy(e, ctx.signal, 'documentation review stopped before it finished; it is read-only, so nothing was changed');
        }
      },

      'update-knowledge': async (ctx): Promise<ActionResult> => {
        const root = host.projectPath(ctx.projectId);
        const pipeline = host.pipelineFor(ctx.projectId);
        const fsEngine = pipeline.fullstack;
        try {
          if (fsEngine) {
            const delta = await fsEngine.update({ signal: ctx.signal });
            return ok(`knowledge update — ${delta.filesAdded} added, ${delta.filesModified} modified, ${delta.filesDeleted} deleted`);
          }
          const fresh = new FullStackKnowledgeEngine(root, { indexDir: homePath('index', ctx.projectId, 'fullstack') });
          const delta = await fresh.update({ signal: ctx.signal });
          return ok(`knowledge update (fresh) — ${delta.filesAdded} added, ${delta.filesModified} modified, ${delta.filesDeleted} deleted`);
        } catch (e) {
          return stoppedBy(e, ctx.signal, 'knowledge update stopped before it finished; the index on disk and the live graph were left as they were');
        }
      },

      /**
       * Trigger → condition → workflow.run → Workflow Engine → Fabric.
       *
       * The rule names a workflow; everything after that is the ordinary
       * governed run path. In particular this action grants NOTHING: an
       * automation fires without a human present, so a node whose policy
       * decision is above auto-execute parks the run at
       * `awaiting-approval` and it waits to be answered. An automation
       * that could authorize its own high-risk actions would be a hole
       * straight through the policy engine.
       */
      'run-workflow': async (ctx, config): Promise<ActionResult> => {
        if (!host.runWorkflow) return { ok: false, error: 'this host cannot run workflows' };
        const workflowId = String(config.workflowId ?? '').trim();
        if (!workflowId) return { ok: false, error: 'run-workflow requires a workflowId in the action config' };
        const outcome = await host.runWorkflow({
          workflowId,
          projectId: ctx.projectId,
          ruleId: ctx.ruleId,
          automationRunId: ctx.runId,
          event: ctx.event.type,
          signal: ctx.signal,
        });
        if (!outcome.ok) return { ok: false, error: outcome.error };
        const produced = {
          kind: 'workflow-run' as const,
          workflowId,
          runId: outcome.runId,
          state: outcome.runState,
        };
        // A parked run is reported as a SUCCESSFUL action with an honest
        // detail, not a failure: the automation did exactly what it was
        // asked to do, and the run is waiting on a person. Reporting it as
        // failed would make the rule retry and ask the same question again.
        return { ...ok(`workflow ${outcome.runState} — run ${outcome.runId}`), produced };
      },

      // Instant and synchronous: there is nothing to interrupt once it starts, so the
      // only meaningful check is BEFORE the write. After it, the memory item exists
      // (a Stop cannot un-write it) and the result says so.
      'save-memory': async (ctx, config): Promise<ActionResult> => {
        if (ctx.signal?.aborted) return { ok: false, error: 'save-memory not started: the run was stopped first; nothing was saved' };
        const kind = String(config.kind ?? 'decision') as Parameters<ProjectMemory['add']>[0]['kind'];
        const title = String(config.title ?? 'Engineering decision');
        const body = String(config.body ?? '');
        const item = host.memoryFor(ctx.projectId).add({ kind, title, body });
        return ok(`memory ${item.id} — ${item.kind}`);
      },
    },
  });

  /**
   * The clock. Constructed here so the runtime owns exactly one, and given
   * the SAME engine and store the rest of this file uses — a scheduler
   * with its own engine would be a second execution path with a timer.
   */
  const scheduler = new AutomationScheduler({
    engine,
    store,
    persistence: schedulePersistence(),
    projectPath: (projectId) => host.projectPath(projectId),
  });

  return {
    engine,
    store,
    scheduler,
    emit,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/** Re-export the event helper so hosts can push real moments. */
export function automationEvent(
  type: AutomationEvent['type'],
  projectId: string,
  projectPath: string,
  payload: Record<string, unknown>,
): AutomationEvent {
  return { type, projectId, projectPath, at: new Date().toISOString(), payload };
}

export type { AutomationEvent, AutomationRule };
