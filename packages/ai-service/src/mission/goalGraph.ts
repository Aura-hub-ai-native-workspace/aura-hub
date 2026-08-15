/**
 * goalGraph — Stage 5, Goal Graph Generation. The mission's one
 * structure-generating LLM call.
 * ==================================================================
 * This is deliberately NOT where distinctiveness comes from — that's
 * already guaranteed by Stage 1 (category) and Stage 4 (strategy
 * scaffold, see `strategies.ts`). This stage's job is narrower and
 * more honest: given a category-specific list of `focusAreas`, the
 * user's actual extracted intent, and real project signals, fill that
 * scaffold in with goals and tasks that are traceable to real
 * evidence. The model may only attach a goal to a `focusAreaId` that
 * already exists in the strategy it was given — never invent a new
 * focus area — and every task must belong to a goal produced in the
 * same response.
 *
 * Three real levels are implemented (Mission → Goal → Task), not the
 * five the original spec sketched (…→Subtask→File-Operation/Manual-
 * Operation): a literal 5th tree level would just be a wrapper around
 * the same leaf data `MissionTask` already carries via its `kind`
 * (what the task IS) and `automationLevel` (how it's carried out).
 */
import type { PipelineManager } from '../pipeline';
import { parseModelJson } from '../jsonMode';
import { genId } from '../workflow/types';
import type { TaskNode } from './execution/nodes';
import type {
  AutomationLevel,
  ExtractedIntent,
  GoalGraph,
  GoalPriority,
  MissionGoal,
  MissionSignals,
  MissionStrategy,
  MissionTask,
  TaskKind,
  TaskMode,
  TaskPriority,
  TaskRisk,
} from './types';

const TASK_KINDS: TaskKind[] = ['file-operation', 'git-operation', 'manual-operation', 'review', 'approval', 'documentation', 'research'];
const TASK_NODES: TaskNode[] = ['aura-ai', 'git', 'opencode', 'claude-code'];
const TASK_MODES: TaskMode[] = ['diff', 'new-file'];
const TASK_PRIORITIES: TaskPriority[] = ['critical', 'high', 'medium', 'low'];
const TASK_RISKS: TaskRisk[] = ['low', 'medium', 'high'];
const AUTOMATION_LEVELS: AutomationLevel[] = ['automatic', 'assisted', 'manual'];
const GOAL_PRIORITIES: GoalPriority[] = ['high', 'medium', 'low'];

function pickEnum<T extends string>(value: unknown, allowed: T[], fallback: T): T {
  return typeof value === 'string' && (allowed as string[]).includes(value) ? (value as T) : fallback;
}

function buildSystemPrompt(strategy: MissionStrategy): string {
  const focusAreaIds = strategy.focusAreas.map((f) => f.id).join('", "');
  return 'You are AURA\'s mission planner, acting as a Senior Staff Engineer preparing a real execution plan — not a generic checklist. ' +
    'You output ONLY valid JSON, no prose, no code fences. The JSON object must have exactly these keys: ' +
    '"goals" (array of {"id":string,"focusAreaId":string (MUST be one of the given focus area ids — never invent a new one),' +
    '"title":string,"rationale":string (why this goal matters, citing real evidence given below),' +
    '"relatedEvidence":array of short strings quoting/paraphrasing real evidence you actually used,"priority":"high"|"medium"|"low"}), ' +
    '"tasks" (array of {"id":string,"goalId":string (must match a goal id you produced),"focusAreaId":string,' +
    '"title":string,"description":string,' +
    `"kind":one of "file-operation"|"git-operation"|"manual-operation"|"review"|"approval"|"documentation"|"research", ` +
    '"targetFile":string or null (exact relative path from evidence given, or a plausible new file only for genuinely new files, or null if there is no single concrete file),' +
    '"mode":"diff"|"new-file" or null (null when targetFile is null; "new-file" only if the file plausibly does not exist yet),' +
    '"node": one of "aura-ai"|"git"|"opencode"|"claude-code" or null — include it ONLY if the user\'s mission text explicitly demanded a specific execution tool; otherwise null. ' +
    '"priority":"critical"|"high"|"medium"|"low",' +
    '"dependencies":array of task ids from THIS SAME response that should be done first (empty array if none),' +
    '"estimatedDurationMinutes":number (realistic, not padded),' +
    '"confidence":number 0-1 (your honest confidence this task is well-scoped and correctly grounded),' +
    '"risk":"low"|"medium"|"high",' +
    '"owner":"ai"|"human" (use "human" for anything requiring a real judgment call, external access, or manual verification AI cannot do),' +
    '"automationLevel":"automatic"|"assisted"|"manual"}). ' +
    `The ONLY valid focus area ids for this mission are: "${focusAreaIds}". ` +
    'Never treat every task equally: not everything is a file edit — use "git-operation" for a task that is purely a repository operation (committing changes, branching, tagging), ' +
    'and "review"/"approval"/"documentation"/"research" honestly when that is what the work actually is. ' +
    'Ground every goal and task in the REAL evidence given below — invent no files, numbers, or issues that were not given to you. ' +
    'Produce at most 8 goals and at most 4 tasks per goal. Every goal must be traceable to the user\'s actual intent or to a real project signal — never a generic engineering checklist.';
}

function renderStrategy(strategy: MissionStrategy): string {
  const lines = [`Mission category: ${strategy.category}`, `Planning guidance for this category: ${strategy.guidance}`, 'Focus areas (use these ids verbatim for focusAreaId):'];
  for (const f of strategy.focusAreas) lines.push(`- id="${f.id}" label="${f.label}" — ${f.description}`);
  return lines.join('\n');
}

function renderIntent(intent: ExtractedIntent): string {
  const lines: string[] = [];
  lines.push(`Primary goal (verbatim from the user's actual intent): ${intent.primaryGoal}`);
  if (intent.secondaryGoals.length) lines.push(`Secondary goals: ${intent.secondaryGoals.join('; ')}`);
  if (intent.constraints.length) lines.push(`Constraints: ${intent.constraints.join('; ')}`);
  if (intent.deadline) lines.push(`Deadline: ${intent.deadline}`);
  if (intent.targetComponents.length) lines.push(`Target components: ${intent.targetComponents.join(', ')}`);
  lines.push(`Expected outcome: ${intent.expectedOutcome}`);
  lines.push(`Scope: ${intent.scope}  Risk level: ${intent.riskLevel}  Required quality: ${intent.requiredQuality}`);
  return lines.join('\n');
}

function renderEvidence(signals: MissionSignals): string {
  const lines: string[] = [];
  if (signals.health) {
    lines.push(`Health score — overall:${signals.health.overall} documentation:${signals.health.documentation} architecture:${signals.health.architecture} testing:${signals.health.testing} dependencies:${signals.health.dependencies} maintainability:${signals.health.maintainability}`);
  } else {
    lines.push('Health score: unavailable');
  }
  if (signals.healthIssues.length) {
    lines.push('Health issues:');
    for (const i of signals.healthIssues.slice(0, 25)) lines.push(`- [${i.severity}] (${i.category}) ${i.message}${i.file ? ` — ${i.file}` : ''}`);
  }
  lines.push(`Verification score: ${signals.verificationScore}`);
  for (const r of signals.verificationRecommendations.slice(0, 12)) lines.push(`- verification recommendation: ${r}`);
  if (signals.hotspots.length) {
    lines.push('Change hotspots:');
    for (const h of signals.hotspots.slice(0, 12)) lines.push(`- ${h.file} (score ${h.score}) — ${h.reason}`);
  }
  lines.push('Architecture layers:');
  for (const l of signals.architectureLayers.slice(0, 12)) lines.push(`- ${l.title}${l.subtitle ? ` (${l.subtitle})` : ''}${l.items?.length ? `: ${l.items.slice(0, 8).join(', ')}` : ''}`);
  if (signals.securityFindings.length) {
    lines.push(`Pattern-scan security findings (not a full audit, ${signals.securityFindings.length} total):`);
    for (const s of signals.securityFindings.slice(0, 10)) lines.push(`- ${s.pattern} — ${s.file}:${s.line} [${s.severity}]`);
  }
  lines.push(signals.gitStatus.available
    ? `Git status: branch ${signals.gitStatus.branch}, ${signals.gitStatus.dirty ? `${signals.gitStatus.changedFiles} uncommitted change(s)` : 'clean'}`
    : `Git status: unavailable (${signals.gitStatus.reason})`);
  if (signals.recentCommits.length) {
    lines.push('Recent commits:');
    for (const c of signals.recentCommits.slice(0, 8)) lines.push(`- ${c.hash} ${c.date} ${c.subject}`);
  }
  if (signals.technicalDebt.length) {
    lines.push(`Technical debt markers (${signals.technicalDebt.length} total):`);
    for (const t of signals.technicalDebt.slice(0, 15)) lines.push(`- [${t.marker}] ${t.file}:${t.line} ${t.text}`);
  }
  lines.push(`Dependencies: ${signals.dependencySummary.total} total, ${signals.dependencySummary.pinnedExact} exact-pinned, ${signals.dependencySummary.looseRange} loose-range`);
  lines.push(signals.buildStatus.available ? `Build status: ${signals.buildStatus.ok ? 'ok' : 'failing'} — ${signals.buildStatus.message}` : `Build status: unavailable (${signals.buildStatus.reason})`);
  if (signals.openMissions.length) {
    lines.push('Other currently open missions (avoid duplicating their work):');
    for (const m of signals.openMissions.slice(0, 8)) lines.push(`- [${m.category}] ${m.text}`);
  }
  return lines.join('\n');
}

function buildUserPrompt(missionText: string, intent: ExtractedIntent, strategy: MissionStrategy, signals: MissionSignals, revisionNotes?: string[]): string {
  const lines = [
    `Mission (verbatim user text): ${missionText}`,
    '',
    'Extracted intent:',
    renderIntent(intent),
    '',
    renderStrategy(strategy),
    '',
    'Real project evidence (use only this — invent nothing):',
    renderEvidence(signals),
  ];
  if (revisionNotes?.length) {
    lines.push('', 'A previous draft of this Goal Graph was reviewed and found genuine defects. You MUST address every one of these in this revision:');
    for (const n of revisionNotes) lines.push(`- ${n}`);
  }
  lines.push('', 'Respond with ONLY the JSON object described in the system message.');
  return lines.join('\n');
}

export async function generateGoalGraph(
  pipeline: PipelineManager,
  missionText: string,
  intent: ExtractedIntent,
  strategy: MissionStrategy,
  signals: MissionSignals,
  signal?: AbortSignal,
  revisionNotes?: string[],
): Promise<{ ok: true; goalGraph: GoalGraph } | { ok: false; error: { type: string; message: string; retryable: boolean } }> {
  const validFocusAreaIds = new Set(strategy.focusAreas.map((f) => f.id));
  const fallbackFocusAreaId = strategy.focusAreas[0]?.id ?? 'general';

  const user = buildUserPrompt(missionText, intent, strategy, signals, revisionNotes);
  const res = await pipeline.generate({ system: buildSystemPrompt(strategy), user, json: true }, signal);
  if (!res.ok) return { ok: false, error: res.error };

  let parsed: Record<string, unknown>;
  try {
    parsed = parseModelJson(res.text);
  } catch (e) {
    return { ok: false, error: { type: 'parse_error', message: (e as Error).message, retryable: true } };
  }

  const goalIdMap = new Map<string, string>(); // model id -> our stable id
  const rawGoals = Array.isArray(parsed.goals) ? parsed.goals : [];
  const goals: MissionGoal[] = rawGoals
    .filter((g): g is Record<string, unknown> => Boolean(g && typeof g === 'object'))
    .map((g) => {
      const ourId = genId('goal');
      if (typeof g.id === 'string') goalIdMap.set(g.id, ourId);
      const focusAreaId = typeof g.focusAreaId === 'string' && validFocusAreaIds.has(g.focusAreaId) ? g.focusAreaId : fallbackFocusAreaId;
      return {
        id: ourId,
        focusAreaId,
        title: typeof g.title === 'string' && g.title.trim() ? g.title.trim() : 'Untitled goal',
        rationale: typeof g.rationale === 'string' ? g.rationale : '',
        relatedEvidence: Array.isArray(g.relatedEvidence) ? (g.relatedEvidence as unknown[]).filter((e): e is string => typeof e === 'string') : [],
        priority: pickEnum(g.priority, GOAL_PRIORITIES, 'medium'),
      };
    });

  const rawTasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
  const taskIdMap = new Map<string, string>();
  const preTasks = rawTasks
    .filter((t): t is Record<string, unknown> => Boolean(t && typeof t === 'object'))
    .map((t) => {
      const ourId = genId('task');
      if (typeof t.id === 'string') taskIdMap.set(t.id, ourId);
      return { ourId, raw: t };
    });

  const tasks: MissionTask[] = preTasks
    .map(({ ourId, raw: t }) => {
      const goalId = typeof t.goalId === 'string' ? goalIdMap.get(t.goalId) : undefined;
      if (!goalId) return null;
      const goal = goals.find((g) => g.id === goalId);
      const targetFile = typeof t.targetFile === 'string' && t.targetFile.trim() ? t.targetFile.trim() : null;
      const mode: TaskMode | null = targetFile ? pickEnum(t.mode, TASK_MODES, 'diff') : null;
      const rawDeps = Array.isArray(t.dependencies) ? (t.dependencies as unknown[]).filter((d): d is string => typeof d === 'string') : [];
      const dependencies = rawDeps.map((d) => taskIdMap.get(d)).filter((d): d is string => Boolean(d));
      const kind = pickEnum(t.kind, TASK_KINDS, targetFile ? 'file-operation' : 'manual-operation');
      const automationLevel = pickEnum(t.automationLevel, AUTOMATION_LEVELS, kind === 'file-operation' || kind === 'git-operation' ? 'assisted' : 'manual');
      const durationRaw = typeof t.estimatedDurationMinutes === 'number' && Number.isFinite(t.estimatedDurationMinutes) ? t.estimatedDurationMinutes : 30;
      const confidenceRaw = typeof t.confidence === 'number' && Number.isFinite(t.confidence) ? t.confidence : 0.5;
      const requestedNode = typeof t.node === 'string' ? pickEnum(t.node, TASK_NODES, 'aura-ai' as TaskNode) : undefined;
      const task: MissionTask = {
        id: ourId,
        goalId,
        focusAreaId: typeof t.focusAreaId === 'string' && validFocusAreaIds.has(t.focusAreaId) ? t.focusAreaId : goal?.focusAreaId ?? fallbackFocusAreaId,
        title: typeof t.title === 'string' && t.title.trim() ? t.title.trim() : 'Untitled task',
        description: typeof t.description === 'string' ? t.description : '',
        kind,
        targetFile: kind === 'git-operation' ? null : targetFile,
        mode: kind === 'git-operation' ? null : mode,
        ...(requestedNode ? { requestedNode } : {}),
        priority: pickEnum(t.priority, TASK_PRIORITIES, 'medium'),
        dependencies,
        estimatedDurationMinutes: Math.max(1, Math.min(480, Math.round(durationRaw))),
        confidence: Math.max(0, Math.min(0.99, confidenceRaw)),
        risk: pickEnum(t.risk, TASK_RISKS, 'medium'),
        owner: t.owner === 'human' ? 'human' : kind === 'file-operation' || kind === 'git-operation' ? 'ai' : 'human',
        automationLevel,
        status: 'pending',
      };
      return task;
    })
    .filter((t): t is MissionTask => t !== null);

  // ── Deterministic working-tree safety ─────────────────────────────
  // A git operation mutates the shared working tree, so it must always run
  // AFTER the file-operations whose changes it captures. Planning may or may
  // not encode this — enforce it here, cycle-safely: for every git-operation
  // task, add every file-operation task as a dependency UNLESS the file task
  // already transitively depends on this git task (which would create a cycle).
  const reachable = new Map<string, Set<string>>();
  const depsOf = new Map(tasks.map((t) => [t.id, new Set(t.dependencies)] as const));
  const reach = (seed: string): Set<string> => {
    const cached = reachable.get(seed);
    if (cached) return cached;
    const out = new Set<string>();
    const stack = [...(depsOf.get(seed) ?? [])];
    while (stack.length) {
      const id = stack.pop()!;
      if (out.has(id)) continue;
      out.add(id);
      for (const d of depsOf.get(id) ?? []) stack.push(d);
    }
    reachable.set(seed, out);
    return out;
  };
  const fileOpIds = tasks.filter((t) => t.kind === 'file-operation').map((t) => t.id);
  if (fileOpIds.length) {
    for (const t of tasks) {
      if (t.kind !== 'git-operation') continue;
      const tReach = reach(t.id);
      const extra = fileOpIds.filter((f) => f !== t.id && !tReach.has(f) && !reach(f).has(t.id));
      if (extra.length) t.dependencies = [...new Set([...t.dependencies, ...extra])];
    }
  }

  return { ok: true, goalGraph: { goals, tasks } };
}
