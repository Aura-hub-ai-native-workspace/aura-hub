/**
 * planner — the deterministic core of the Planner.
 * ==================================================================
 * The Planner turns a goal into a structured, editable plan; it never
 * executes it. Execution belongs to Workspace, reached through an
 * explicit handoff (`toWorkspacePlan`). This module holds everything
 * about a plan that needs no model:
 *
 *   · `simplePlan`      — the lightweight path: a short goal that names
 *                         exactly one file ("Add a short NOTES.md file")
 *                         becomes a one-task plan targeting THAT file,
 *                         with no model call at all.
 *   · `validatePlan`    — structural checks shown to the person: unknown
 *                         or self dependencies, cycles, files the goal
 *                         names that no task targets, tasks Workspace
 *                         could not carry out.
 *   · `applyPlanEdit`   — a person's edit, validated and normalised.
 *   · `toWorkspacePlan` — the handoff payload: the actual tasks,
 *                         dependencies, files and workers.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { genId } from '../workflow/types';
import type { GoalGraph, MissionGoal, MissionRecord, MissionTask, PlanHandoff } from './types';

/** Worker value meaning "AURA writes the target file itself". */
export const AURA_WORKER = 'aura';

/** Matches the Python handoff validator's id rule. */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const FILE_RE = /(?:^|[\s"'`(])((?:[\w.-]+\/)*[\w-][\w.-]*\.(?:md|mdx|txt|rst|json|ya?ml|toml|ini|cfg|env|ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|css|scss|html|sql|sh|bat|ps1|xml|csv|lock|gitignore))(?=$|[\s"'`),.;:!?])/gi;

/** Files a goal names explicitly, in order, de-duplicated. */
export function namedFiles(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(FILE_RE)) {
    const f = m[1].replace(/^\.\//, '');
    if (!out.includes(f)) out.push(f);
  }
  return out;
}

const CREATE_RE = /\b(add|create|write|make|start|draft|generate|new)\b/i;
const CHANGE_RE = /\b(update|edit|change|modify|fix|improve|rewrite|extend|expand|clean ?up|refactor|document)\b/i;

/**
 * The lightweight path. Only for a short goal that names exactly ONE
 * file and says to create or change it — anything bigger is genuine
 * planning work and goes to the model.
 */
export function simplePlan(text: string, projectPath: string): GoalGraph | null {
  const goal = text.trim();
  const files = namedFiles(goal);
  if (files.length !== 1) return null;
  if (goal.split(/\s+/).length > 24) return null;
  if (/\b(and then|then|also|plus|after that)\b|;/i.test(goal)) return null;
  const creates = CREATE_RE.test(goal);
  const changes = CHANGE_RE.test(goal);
  if (!creates && !changes) return null;
  const file = files[0];
  const exists = existsSync(path.join(projectPath, file));
  const goalId = genId('goal');
  const title = exists ? `Update ${file}` : `Create ${file}`;
  const g: MissionGoal = {
    id: goalId, focusAreaId: 'general', title: goal, rationale: 'The goal names this file directly.',
    relatedEvidence: [], priority: 'medium',
  };
  const task: MissionTask = {
    id: genId('task'), goalId, focusAreaId: 'general', title,
    description: goal,
    kind: 'file-operation', targetFile: file, mode: exists ? 'diff' : 'new-file',
    priority: 'medium', dependencies: [], estimatedDurationMinutes: 5, confidence: 0.9,
    risk: 'low', owner: 'ai', automationLevel: 'automatic', status: 'pending',
    files: [], worker: AURA_WORKER,
    expectedOutput: `${file} exists in the project${exists ? ' with the requested change applied' : ' with the requested content'}.`,
    verification: `Read ${file} back and confirm it matches what was written.`,
  };
  return { goals: [g], tasks: [task] };
}

/** Acceptance for the lightweight path: the same fact the task is verified by. */
export function simpleAcceptance(graph: GoalGraph): string[] {
  return graph.tasks.map((t) => t.expectedOutput).filter((x): x is string => Boolean(x));
}

/** Is the task something Workspace can carry out as planned? */
export function actionable(_task: MissionTask): boolean {
  // Every task is carried out by a connected coding agent that Laya selects at run
  // time (or the one the person chose here), so a task needs no target file to be
  // actionable. Whether an agent is available is checked when the plan is sent.
  return true;
}

function cycleIn(tasks: MissionTask[]): string[] | null {
  const deps = new Map(tasks.map((t) => [t.id, t.dependencies] as const));
  const state = new Map<string, number>();
  let found: string[] | null = null;
  const visit = (id: string, trail: string[]): void => {
    if (found) return;
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) { found = [...trail.slice(trail.indexOf(id)), id]; return; }
    state.set(id, 1);
    for (const d of deps.get(id) ?? []) if (deps.has(d)) visit(d, [...trail, id]);
    state.set(id, 2);
  };
  for (const t of tasks) visit(t.id, []);
  return found;
}

/**
 * Issues a person can act on. Never blocks saving — an imperfect plan is
 * still the person's plan — but an issue marked `blocksHandoff` keeps
 * Send to Workspace disabled until it is resolved.
 */
export interface PlanIssue { message: string; taskId?: string; blocksHandoff: boolean }

export function validatePlan(graph: GoalGraph | null, goalText: string): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const tasks = graph?.tasks ?? [];
  if (!tasks.length) {
    issues.push({ message: 'The plan has no tasks yet.', blocksHandoff: true });
    return issues;
  }
  const ids = new Set(tasks.map((t) => t.id));
  for (const t of tasks) {
    if (!t.title.trim()) issues.push({ message: 'A task has no title.', taskId: t.id, blocksHandoff: true });
    for (const d of t.dependencies) {
      if (d === t.id) issues.push({ message: `"${t.title}" depends on itself.`, taskId: t.id, blocksHandoff: true });
      else if (!ids.has(d)) issues.push({ message: `"${t.title}" depends on a task that is no longer in the plan.`, taskId: t.id, blocksHandoff: true });
    }
    if (!actionable(t)) {
      issues.push({
        message: `"${t.title}" has no target file and no worker, so Workspace could not carry it out. Give it a target file or choose a worker.`,
        taskId: t.id, blocksHandoff: true,
      });
    }
  }
  const cycle = cycleIn(tasks);
  if (cycle) {
    const names = cycle.map((id) => tasks.find((t) => t.id === id)?.title ?? id);
    issues.push({ message: `These tasks depend on each other in a loop: ${names.join(' → ')}.`, blocksHandoff: true });
  }
  const targeted = new Set(tasks.flatMap((t) => [t.targetFile, ...(t.files ?? [])]).filter(Boolean) as string[]);
  // A task that only READS, reviews or tests a file mentions it without
  // writing it. That is addressing the request, not ignoring it, so a
  // mention counts as coverage.
  const mentioned = tasks
    .flatMap((t) => [t.title, t.description, t.expectedOutput, t.verification])
    .filter(Boolean)
    .join('\n');
  for (const f of namedFiles(goalText)) {
    const covered = [...targeted].some((p) => p === f || p.endsWith(`/${f}`));
    if (!covered && !mentioned.includes(f)) {
      // BLOCKS. The request is the authority: a plan that ignores the
      // deliverable the person named can still satisfy its own
      // acceptance criteria, and then report a verified mission for
      // work nobody asked for and nobody did.
      issues.push({ message: `The goal names ${f}, but no task targets it.`, blocksHandoff: true });
    }
  }
  const writes = tasks.filter((t) => (t.worker ?? AURA_WORKER) === AURA_WORKER && t.targetFile).map((t) => t.targetFile as string);
  for (const f of new Set(writes.filter((f, i) => writes.indexOf(f) !== i))) {
    issues.push({ message: `More than one task has AURA write ${f}. Merge them or give one a worker.`, blocksHandoff: true });
  }
  return issues;
}

/** What a person may change on one task. */
export interface TaskEdit {
  id?: string;
  title: string;
  description?: string;
  targetFile?: string | null;
  files?: string[];
  dependencies?: string[];
  worker?: string | null;
  expectedOutput?: string;
  verification?: string;
  requires?: string[];
}

const TOOL_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function cleanPath(p: unknown): string | null {
  if (typeof p !== 'string') return null;
  const v = p.trim().replace(/^\.\//, '');
  if (!v) return null;
  if (path.isAbsolute(v) || /^[A-Za-z]:/.test(v) || v.split(/[\\/]/).includes('..')) {
    throw new Error(`"${v}" must be a path inside the project.`);
  }
  return v;
}

/**
 * Apply a person's edited task list to a plan. Ids of existing tasks are
 * kept (so dependencies and history stay attached); new tasks get fresh
 * ids. Throws on input that can never be a plan (bad paths, bad ids).
 */
export function applyPlanEdit(graph: GoalGraph | null, edits: TaskEdit[]): GoalGraph {
  if (!Array.isArray(edits)) throw new Error('tasks must be a list');
  if (edits.length > 16) throw new Error('A plan can hold at most 16 tasks.');
  const goals = graph?.goals?.length ? graph.goals : [{
    id: genId('goal'), focusAreaId: 'general', title: 'Goal', rationale: '', relatedEvidence: [], priority: 'medium' as const,
  }];
  const byId = new Map((graph?.tasks ?? []).map((t) => [t.id, t] as const));
  const tasks: MissionTask[] = edits.map((e) => {
    const prior = e.id ? byId.get(e.id) : undefined;
    const id = prior?.id ?? (e.id && ID_RE.test(e.id) ? e.id : genId('task'));
    const title = String(e.title ?? '').trim().slice(0, 300);
    const targetFile = cleanPath(e.targetFile);
    const files = (Array.isArray(e.files) ? e.files : []).map(cleanPath).filter((f): f is string => Boolean(f)).slice(0, 12);
    const worker = typeof e.worker === 'string' && e.worker.trim() ? e.worker.trim() : AURA_WORKER;
    if (!ID_RE.test(worker)) throw new Error(`"${worker}" is not a worker id.`);
    return {
      ...(prior ?? {
        goalId: goals[0].id, focusAreaId: goals[0].focusAreaId, kind: 'file-operation' as const, mode: null,
        priority: 'medium' as const, estimatedDurationMinutes: 15, confidence: 0.5, risk: 'medium' as const,
        owner: 'ai' as const, automationLevel: 'automatic' as const, status: 'pending' as const,
      }),
      id,
      title,
      description: String(e.description ?? '').slice(0, 4000),
      targetFile,
      kind: targetFile ? 'file-operation' : (prior?.kind ?? 'manual-operation'),
      files,
      dependencies: [...new Set((e.dependencies ?? []).filter((d) => typeof d === 'string'))],
      worker,
      expectedOutput: String(e.expectedOutput ?? prior?.expectedOutput ?? '').slice(0, 600),
      verification: String(e.verification ?? prior?.verification ?? '').slice(0, 600),
      requires: [...new Set((e.requires ?? prior?.requires ?? []).filter((r): r is string => typeof r === 'string' && TOOL_ID.test(r.trim())).map((r) => r.trim()))].slice(0, 6),
    };
  });
  return { goals, tasks };
}

/** The handoff contract (mirrors backend/aura/central_agent/plan_handoff.py). */
export interface WorkspacePlan {
  source: 'planner';
  planId: string;
  revision: number;
  goal: string;
  /** What must be true for the goal to count as met. */
  acceptance: string[];
  /** The shared context the plan was built from (decisions, requirements, research). */
  context: { text: string; scope: string; sources: { title: string; url: string }[] } | null;
  tasks: {
    id: string; title: string; description: string; targetFile: string | null;
    files: string[]; dependsOn: string[]; worker: string | null;
    expectedOutput: string; verification: string; requires: string[];
  }[];
}

export function toWorkspacePlan(record: MissionRecord): WorkspacePlan {
  return {
    source: 'planner',
    planId: record.id,
    revision: record.revision ?? 1,
    goal: record.text,
    acceptance: record.acceptance ?? [],
    context: record.context ? { text: record.context.text, scope: record.context.scope, sources: record.context.sources } : null,
    tasks: (record.goalGraph?.tasks ?? []).map((t) => ({
      id: t.id,
      title: t.title,
      description: t.description,
      targetFile: t.targetFile,
      files: t.files ?? [],
      dependsOn: t.dependencies,
      worker: t.worker && t.worker !== AURA_WORKER ? t.worker : null,
      expectedOutput: t.expectedOutput ?? '',
      verification: t.verification ?? '',
      requires: t.requires ?? [],
    })),
  };
}

/**
 * Decide a handoff for one plan revision. Pure: the caller persists
 * `handoffs` and supplies fresh ids. Idempotent per revision — a revision
 * already reserved or started returns that same handoff (`duplicate`),
 * and one that failed to start is reused with its session id, so neither
 * a repeated click nor a retry can run the plan twice.
 */
export function decideHandoff(
  record: MissionRecord,
  revision: number,
  fresh: () => { id: string; sessionId: string },
  at: string,
):
  | { ok: false; status: number; error: string; issues?: PlanIssue[] }
  | { ok: true; handoff: PlanHandoff; duplicate: boolean; handoffs: PlanHandoff[]; issues: PlanIssue[] } {
  const current = record.revision ?? 1;
  if (revision !== current) {
    return { ok: false, status: 409, error: `This plan changed since you opened it (now revision ${current}). Reload it before sending.` };
  }
  const issues = validatePlan(record.goalGraph, record.text);
  const blocking = issues.find((i) => i.blocksHandoff);
  if (blocking) return { ok: false, status: 400, error: blocking.message, issues };
  const handoffs = [...(record.handoffs ?? [])];
  const live = handoffs.find((h) => h.revision === current && h.status !== 'failed');
  if (live) return { ok: true, handoff: live, duplicate: true, handoffs, issues };
  const failed = handoffs.find((h) => h.revision === current && h.status === 'failed');
  const ids = failed ? { id: failed.id, sessionId: failed.sessionId } : fresh();
  const handoff: PlanHandoff = { id: ids.id, revision: current, sessionId: ids.sessionId, status: 'reserved', at };
  return { ok: true, handoff, duplicate: false, handoffs: [...handoffs.filter((h) => h.id !== handoff.id), handoff], issues };
}
