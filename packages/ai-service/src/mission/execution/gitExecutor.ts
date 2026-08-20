/**
 * Mission git executor — the governed `git` node for Mission Control v3.
 * ==================================================================
 * Reuses the single governed git runner (`runGit` from workflow/nodes.ts) —
 * the ONLY git executor in AURA. No shell, fixed binary, plain args,
 * cwd confinement, bounded timeout, real exit codes.
 *
 * Human-gated exactly like every other mission task:
 *   1. `planGitOperation`  — runs a read-only PREVIEW (status/diff/log) and
 *      asks the model to plan ONE allow-listed operation. Nothing mutates.
 *   2. `executeGitOperation` — called ONLY from `acceptMissionTask` (explicit
 *      human Accept), and only for allow-listed operations with server-built
 *      arguments. A per-project mutex serializes mutations so two accepted
 *      git tasks can never race each other in the same working tree.
 */
import type { PipelineManager } from '../../pipeline';
import { runGit } from '../../workflow/nodes';
import { parseModelJson } from '../../jsonMode';
import type { MissionGoal, MissionTask, TaskOperation, TaskProposal } from '../types';

export type GitOperation = 'status' | 'diff' | 'log' | 'commit' | 'branch' | 'checkout';

const ALLOWED_OPERATIONS: GitOperation[] = ['status', 'diff', 'log', 'commit', 'branch', 'checkout'];

/** The mission-domain operation type (`mission/types` TaskOperation) — single definition, no duplicate shape. */
export type GitTaskOperation = TaskOperation & { type: 'git' };

/** Structured preview: human-readable state + a cleanliness verdict the plan guard can trust. */
export interface GitPreview {
  text: string;
  hasChanges: boolean;
}

function sanitizeMessage(raw: unknown, maxLen = 100): string {
  const s = typeof raw === 'string' ? raw : '';
  const cleaned = s.replace(/[\r\n\t\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, maxLen);
}

function sanitizeBranchName(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s || s.length > 100) return '';
  if (!/^[\w./-]+$/.test(s)) return '';
  if (s.startsWith('-') || s.includes('..') || s.endsWith('.') || /[\\ ]/.test(s)) return '';
  return s;
}

/* ── Read-only preview ─────────────────────────────────────────────── */

export async function previewGitState(projectPath: string, signal?: AbortSignal): Promise<GitPreview> {
  const status = await runGit(projectPath, ['status', '--short', '--branch'], { signal });
  const diff = await runGit(projectPath, ['diff', '--stat', '--no-color'], { signal });
  const last = await runGit(projectPath, ['log', '-1', '--oneline', '--no-color'], { signal }).catch(() => ({ out: '', code: 0 }));
  // `status --short` never prints "nothing to commit": cleanliness must be
  // derived from the entry lines beyond the `## branch` header. Untracked
  // files count as changes — `git add -A` at Accept would commit them.
  const entries = status.out.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('##'));
  const hasChanges = entries.length > 0;
  const lines = [
    `Branch / status:\n${status.out || '(clean)'}`,
    diff.out ? `Uncommitted diff stat:\n${diff.out}` : hasChanges ? 'No tracked diff (untracked/unstaged entries only).' : 'No uncommitted changes.',
    last.out ? `Last commit: ${last.out.split('\n')[0]}` : 'No commits yet.',
  ];
  return { text: lines.join('\n'), hasChanges };
}

/* ── Proposal generation (dry run — never mutates) ─────────────────── */

const PLAN_SYSTEM =
  'You plan exactly ONE git operation for AURA\'s governed git node. You output ONLY valid JSON, no prose, no code fences. ' +
  'The JSON object must have exactly these keys: ' +
  '"operation" (one of "status"|"diff"|"log"|"commit"|"branch"|"checkout"), ' +
  '"message" (string — REQUIRED for "commit": a concise imperative commit subject, <=72 chars, single line), ' +
  '"branchName" (string — REQUIRED for "branch" and "checkout": a new branch name, lowercase, hyphens, no spaces). ' +
  'Set unused keys to null. Choose the operation the task actually requires based on the real repository preview below. ' +
  '"commit" is only appropriate when there are uncommitted changes and the task is to commit them. ' +
  'Never invent repository state that is not shown in the preview.';

export interface GitPlanResult {
  ok: boolean;
  proposal: TaskProposal;
}

export async function planGitOperation(
  pipeline: PipelineManager,
  opts: {
    projectPath: string;
    task: MissionTask;
    goal: MissionGoal;
    missionText: string;
    signal?: AbortSignal;
  },
): Promise<GitPlanResult> {
  const { projectPath, task, goal, missionText, signal } = opts;
  const preview = await previewGitState(projectPath, signal);

  const user = [
    `Mission: ${missionText}`,
    `Goal: ${goal.title} — ${goal.rationale}`,
    `Task: ${task.title}`,
    `Task description: ${task.description}`,
    '',
    'Real repository preview:',
    preview.text,
    '',
    'Respond with ONLY the JSON object described in the system message.',
  ].join('\n');

  const res = await pipeline.generate({ system: PLAN_SYSTEM, user, json: true }, signal);
  if (!res.ok) {
    return { ok: false, proposal: { explanation: '', newCode: null, error: res.error } };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = parseModelJson(res.text);
  } catch (e) {
    return { ok: false, proposal: { explanation: '', newCode: null, error: { type: 'parse_error', message: (e as Error).message, retryable: true } } };
  }

  const operation = ALLOWED_OPERATIONS.find((o) => o === parsed.operation);
  if (!operation) {
    return { ok: false, proposal: { explanation: '', newCode: null, error: { type: 'invalid_operation', message: `git plan rejected: unknown operation (allowed: ${ALLOWED_OPERATIONS.join(', ')})`, retryable: true } } };
  }
  if (operation === 'commit' && !sanitizeMessage(parsed.message)) {
    return { ok: false, proposal: { explanation: '', newCode: null, error: { type: 'invalid_plan', message: 'git plan rejected: commit requires a non-empty message', retryable: true } } };
  }
  if ((operation === 'branch' || operation === 'checkout') && !sanitizeBranchName(parsed.branchName)) {
    return { ok: false, proposal: { explanation: '', newCode: null, error: { type: 'invalid_plan', message: 'git plan rejected: branch/checkout requires a valid branch name', retryable: true } } };
  }
  if (operation === 'commit' && !preview.hasChanges) {
    return { ok: false, proposal: { explanation: '', newCode: null, error: { type: 'nothing_to_commit', message: 'git plan rejected: there is nothing to commit', retryable: false } } };
  }

  const explanation = [
    `Git node plan: ${operation}${operation === 'commit' ? ` — "${sanitizeMessage(parsed.message)}"` : operation === 'branch' || operation === 'checkout' ? ` — "${sanitizeBranchName(parsed.branchName)}"` : ''}`,
    '',
    preview.text,
  ].join('\n');

  return {
    ok: true,
    proposal: {
      explanation,
      newCode: null,
      operation: {
        type: 'git',
        operation,
        message: operation === 'commit' ? sanitizeMessage(parsed.message) : undefined,
        branchName: (operation === 'branch' || operation === 'checkout') ? sanitizeBranchName(parsed.branchName) : undefined,
        preview: preview.text,
      },
    },
  };
}

/* ── Governed execution (human Accept only) ────────────────────────── */

/** Per-project FIFO mutex so two accepted git tasks never mutate the same tree at once. */
const projectLocks = new Map<string, Promise<void>>();

async function withProjectLock<T>(projectPath: string, fn: () => Promise<T>): Promise<T> {
  const prev = projectLocks.get(projectPath) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((r) => { release = r; });
  projectLocks.set(projectPath, prev.then(() => next));
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

export async function executeGitOperation(
  projectPath: string,
  op: GitTaskOperation,
  signal?: AbortSignal,
): Promise<{ ok: boolean; output: string; error?: string }> {
  const buildArgs = (): string[] => {
    switch (op.operation) {
      case 'status': return ['status', '--short', '--branch'];
      case 'diff': return ['diff', '--stat', '-p', '--no-color'];
      case 'log': return ['log', '-5', '--oneline', '--no-color'];
      case 'commit': return ['commit', '-m', op.message ?? 'mission commit'];
      case 'branch': return ['branch', op.branchName ?? 'chore/aura-mission'];
      case 'checkout': return ['checkout', '-b', op.branchName ?? 'chore/aura-mission'];
    }
  };

  // Read-only operations need no lock.
  if (op.operation === 'status' || op.operation === 'diff' || op.operation === 'log') {
    const res = await runGit(projectPath, buildArgs(), { signal });
    if (res.code !== 0) return { ok: false, output: res.out, error: res.out || `git ${op.operation} failed` };
    return { ok: true, output: res.out || `git ${op.operation} — clean` };
  }

  // Mutating operations are serialized per project.
  return withProjectLock(projectPath, async () => {
    if (op.operation === 'commit') {
      const staged = await runGit(projectPath, ['add', '-A'], { signal });
      if (staged.code !== 0) return { ok: false, output: staged.out, error: staged.out || 'git add failed' };
      const commit = await runGit(projectPath, buildArgs(), { signal });
      if (commit.code !== 0) return { ok: false, output: commit.out, error: commit.out || 'git commit failed' };
      // `--stat` verify: the audit trail shows EXACTLY which files the
      // accepted commit carried, so an Accept can never silently sweep in
      // unrelated working-tree changes.
      const verify = await runGit(projectPath, ['log', '-1', '--stat', '--oneline', '--no-color'], { signal });
      return { ok: true, output: [commit.out, verify.out].filter(Boolean).join('\n') };
    }
    const res = await runGit(projectPath, buildArgs(), { signal });
    if (res.code !== 0) return { ok: false, output: res.out, error: res.out || `git ${op.operation} failed` };
    return { ok: true, output: res.out || `git ${op.operation} — done` };
  });
}
