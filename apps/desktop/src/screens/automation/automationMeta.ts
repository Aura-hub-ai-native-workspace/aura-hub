/**
 * automationMeta — how the engine's vocabulary reads on screen.
 * ==================================================================
 * Labels and tones only. Every key here corresponds one-to-one with a
 * member of the service's own unions in `packages/automation/src/types.ts`,
 * so a new trigger or action on the service is a compile error here rather
 * than a silently unlabelled chip.
 */

import type { IconName } from '@aura/ui';
import type { StatusTone } from '@aura/core';
import type {
  AutomationActionType,
  AutomationRunStatus,
  AutomationTimelineType,
  AutomationTriggerType,
  ConditionOp,
  RunActionStatus,
} from '../../ai/automationClient';

/* ── triggers ──────────────────────────────────────────────────────── */

export interface TriggerMeta {
  label: string;
  /** What actually has to happen. Written from the user's side. */
  when: string;
  icon: IconName;
  /** Payload paths a condition can read, for the field picker. */
  fields: string[];
}

export const TRIGGERS: Record<AutomationTriggerType, TriggerMeta> = {
  'mission-completed': {
    label: 'A mission finishes',
    when: 'a mission execution reaches “completed”',
    icon: 'deploy',
    fields: ['mission.id', 'mission.status', 'mission.category', 'mission.text', 'mission.taskCount'],
  },
  'mission-accepted': {
    label: 'A mission task is accepted',
    when: 'a task proposal is accepted and written to disk',
    icon: 'check',
    fields: ['mission.id', 'task.id', 'task.title', 'task.kind'],
  },
  'diagnosis-completed': {
    label: 'A diagnosis finishes',
    when: 'the Diagnosis Engine produces a record',
    icon: 'bug',
    fields: ['diagnosis.id', 'diagnosis.severity', 'diagnosis.findingCount', 'diagnosis.file'],
  },
  'diagnosis-accepted': {
    label: 'A diagnosis fix is accepted',
    when: 'a diagnosis candidate is accepted and the patch is written',
    icon: 'check',
    fields: ['diagnosis.id', 'candidate.id', 'candidate.file'],
  },
  'file-changed': {
    label: 'Files change',
    when: 'real file changes are detected in the project',
    icon: 'file',
    fields: ['files', 'fileCount', 'changed'],
  },
  'readme-changed': {
    label: 'Docs change',
    when: 'a README, CHANGELOG or docs file changes',
    icon: 'doc',
    fields: ['files', 'fileCount'],
  },
  'dependency-changed': {
    label: 'Dependencies change',
    when: 'a package manifest gains, loses or updates a dependency',
    icon: 'cpu',
    fields: ['manifest', 'added', 'removed', 'updated'],
  },
  schedule: {
    label: 'On a schedule',
    when: 'the clock reaches a time you set',
    icon: 'activity',
    fields: ['firedAt', 'cron'],
  },
  'pr-merged': {
    label: 'A pull request merges',
    when: 'a merge commit lands in the project',
    icon: 'git-branch',
    fields: ['commit', 'subject', 'branch', 'author'],
  },
};

export const TRIGGER_LIST = Object.keys(TRIGGERS) as AutomationTriggerType[];

/**
 * A schedule's next fire, in words.
 *
 * `nextFireAt` is computed by the service's scheduler, so this only
 * formats it — the renderer never parses cron to answer "when next".
 */
export function fmtNextFire(iso: string | undefined): string {
  if (!iso) return 'not scheduled';
  const at = new Date(iso);
  const mins = Math.round((at.getTime() - Date.now()) / 60_000);
  if (mins < 0) return 'due now';
  if (mins < 1) return 'in under a minute';
  if (mins < 60) return `in ${mins} min`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `in ${hrs}h · ${at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  return at.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

/* ── actions ───────────────────────────────────────────────────────── */

export interface ActionMeta {
  label: string;
  /** One sentence: what the action actually does when it runs. */
  does: string;
  icon: IconName;
  /** Config keys this action reads, with a label for each. */
  fields: { key: string; label: string; placeholder?: string; help?: string }[];
}

export const ACTIONS: Record<AutomationActionType, ActionMeta> = {
  'run-workflow': {
    label: 'Run a workflow',
    does: 'Hands a workflow to the Workflow Engine, which runs it through the Capability Fabric exactly as the Run button does.',
    icon: 'workflows',
    fields: [{ key: 'workflowId', label: 'Workflow', help: 'Chosen from your workflow library.' }],
  },
  'run-diagnosis': {
    label: 'Run a diagnosis',
    does: 'Runs the Engineering Diagnosis Engine over the project and records what it finds.',
    icon: 'bug',
    fields: [
      { key: 'filePath', label: 'File path (optional)', placeholder: 'src/server.ts' },
      { key: 'language', label: 'Language (optional)', placeholder: 'typescript' },
      { key: 'scope', label: 'Scope', placeholder: 'mission' },
    ],
  },
  'run-governance-audit': {
    label: 'Run a governance audit',
    does: 'Runs the Engineering Audit over the project at the given scope.',
    icon: 'shield',
    fields: [{ key: 'scope', label: 'Scope', placeholder: 'daily · weekly · release · architecture' }],
  },
  'run-security-review': {
    label: 'Run a security review',
    does: 'Runs the Security Engine over the project.',
    icon: 'shield',
    fields: [],
  },
  'run-docs-review': {
    label: 'Review documentation',
    does: 'Runs Documentation Governance over the project’s docs.',
    icon: 'doc',
    fields: [],
  },
  'update-knowledge': {
    label: 'Update the knowledge graph',
    does: 'Runs the FullStack Knowledge Engine’s incremental update so the graph stays current.',
    icon: 'knowledge',
    fields: [],
  },
  'save-memory': {
    label: 'Write to project memory',
    does: 'Records an entry in this project’s memory inside AURA.',
    icon: 'memory',
    fields: [
      { key: 'kind', label: 'Kind', placeholder: 'decision · learning · code · conversation' },
      { key: 'title', label: 'Title', placeholder: 'Engineering decision' },
      { key: 'body', label: 'Body' },
    ],
  },
};

export const ACTION_LIST = Object.keys(ACTIONS) as AutomationActionType[];

/* ── conditions ────────────────────────────────────────────────────── */

export const CONDITION_OPS: Record<ConditionOp, { label: string; needsValue: boolean }> = {
  equals: { label: 'is', needsValue: true },
  'not-equals': { label: 'is not', needsValue: true },
  exists: { label: 'is present', needsValue: false },
  'not-exists': { label: 'is missing', needsValue: false },
  contains: { label: 'contains', needsValue: true },
  'not-contains': { label: 'does not contain', needsValue: true },
  in: { label: 'is one of', needsValue: true },
  'matches-regex': { label: 'matches pattern', needsValue: true },
  gt: { label: 'is greater than', needsValue: true },
  gte: { label: 'is at least', needsValue: true },
  lt: { label: 'is less than', needsValue: true },
  lte: { label: 'is at most', needsValue: true },
};

export const CONDITION_OP_LIST = Object.keys(CONDITION_OPS) as ConditionOp[];

/* ── run status ────────────────────────────────────────────────────── */

/**
 * Four terminal states, kept apart on purpose.
 *
 * `cancelled` is a person's decision, not an error. `paused` is a run
 * that will continue. Collapsing either into "failed" would teach users
 * that their own actions break things.
 */
export const RUN_STATUS_LABEL: Record<AutomationRunStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  paused: 'Paused',
  retrying: 'Retrying',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export const RUN_STATUS_TONE: Record<AutomationRunStatus, StatusTone> = {
  queued: 'neutral',
  running: 'info',
  paused: 'attention',
  retrying: 'attention',
  completed: 'positive',
  failed: 'critical',
  cancelled: 'attention',
};

export const ACTION_STATUS_LABEL: Record<RunActionStatus, string> = {
  pending: 'pending',
  running: 'running',
  retrying: 'retrying',
  completed: 'completed',
  failed: 'failed',
  skipped: 'skipped',
};

export const ACTION_STATUS_TONE: Record<RunActionStatus, StatusTone> = {
  pending: 'neutral',
  running: 'info',
  retrying: 'attention',
  completed: 'positive',
  failed: 'critical',
  skipped: 'neutral',
};

/* ── timeline ──────────────────────────────────────────────────────── */

export const TIMELINE_ICON: Record<AutomationTimelineType, IconName> = {
  queued: 'dot',
  started: 'activity',
  'condition-check': 'eye',
  'action-started': 'activity',
  'action-completed': 'check',
  'action-failed': 'close',
  'action-retried': 'refresh',
  'action-skipped': 'more',
  paused: 'dot',
  resumed: 'activity',
  cancelled: 'close',
  completed: 'check',
  failed: 'close',
  log: 'note',
};

export const TIMELINE_COLOR: Record<AutomationTimelineType, string> = {
  queued: 'var(--text-muted)',
  started: 'var(--accent)',
  'condition-check': 'var(--text-subtle)',
  'action-started': 'var(--accent)',
  'action-completed': 'var(--positive)',
  'action-failed': 'var(--danger)',
  'action-retried': 'var(--attention)',
  'action-skipped': 'var(--text-subtle)',
  paused: 'var(--attention)',
  resumed: 'var(--accent)',
  cancelled: 'var(--text-muted)',
  completed: 'var(--positive)',
  failed: 'var(--danger)',
  log: 'var(--text-muted)',
};

/* ── formatting ────────────────────────────────────────────────────── */

export function fmtRetry(r: { maxAttempts: number; delayMs: number; backoffFactor: number }): string {
  if (r.maxAttempts <= 1) return 'No retries — one attempt per action.';
  const delays: string[] = [];
  let d = r.delayMs;
  for (let i = 1; i < r.maxAttempts; i++) {
    delays.push(d >= 1000 ? `${(d / 1000).toFixed(d % 1000 ? 1 : 0)}s` : `${d}ms`);
    d = Math.round(d * r.backoffFactor);
  }
  return `Up to ${r.maxAttempts} attempts per action, waiting ${delays.join(', then ')}.`;
}
