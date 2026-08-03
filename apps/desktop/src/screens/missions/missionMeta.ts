/**
 * missionMeta — shared display maps for Mission Control v3.
 * ------------------------------------------------------------------
 * One place for every label/tone/icon mapping so MissionControl,
 * MissionDetail and the dashboard never drift.
 */
import type { StatusTone } from '@aura/core';
import type { IconName } from '@aura/ui';
import type {
  CheckpointStatus,
  ExecutionStatus,
  ExecutionTaskStatus,
  MissionCategory,
  TaskKind,
  TaskPriority,
  TaskRisk,
  TaskStatus,
} from '../../ai/missionClient';
import type { CreationStage } from './useMissions';

export const CATEGORY_LABEL: Record<MissionCategory, string> = {
  'feature-development': 'Feature',
  architecture: 'Architecture',
  'bug-resolution': 'Bug Fix',
  performance: 'Performance',
  security: 'Security',
  documentation: 'Docs',
  testing: 'Testing',
  presentation: 'Presentation',
  deployment: 'Deployment',
  migration: 'Migration',
  maintenance: 'Maintenance',
  research: 'Research',
  release: 'Release',
  refactoring: 'Refactor',
  unknown: 'General',
};

export const CATEGORY_TONE: Record<MissionCategory, StatusTone> = {
  'feature-development': 'info',
  architecture: 'info',
  'bug-resolution': 'critical',
  performance: 'attention',
  security: 'critical',
  documentation: 'neutral',
  testing: 'positive',
  presentation: 'info',
  deployment: 'attention',
  migration: 'attention',
  maintenance: 'neutral',
  research: 'neutral',
  release: 'positive',
  refactoring: 'info',
  unknown: 'neutral',
};

export const EXECUTION_STATUS_LABEL: Record<ExecutionStatus, string> = {
  idle: 'Plan ready',
  approved: 'Approved',
  running: 'Executing',
  paused: 'Paused',
  reviewing: 'In review',
  completed: 'Completed',
  cancelled: 'Cancelled',
  failed: 'Failed',
};

export const EXECUTION_STATUS_TONE: Record<ExecutionStatus, StatusTone> = {
  idle: 'info',
  approved: 'attention',
  running: 'info',
  paused: 'attention',
  reviewing: 'attention',
  completed: 'positive',
  cancelled: 'neutral',
  failed: 'critical',
};

export const EXECUTION_STATUS_ICON: Record<ExecutionStatus, IconName> = {
  idle: 'clipboard',
  approved: 'check',
  running: 'activity',
  paused: 'dot',
  reviewing: 'eye',
  completed: 'check',
  cancelled: 'close',
  failed: 'bug',
};

export const RUNTIME_STATUS_LABEL: Record<ExecutionTaskStatus, string> = {
  queued: 'Queued',
  waiting: 'Waiting',
  blocked: 'Blocked',
  running: 'Running',
  paused: 'Paused',
  review: 'Review',
  completed: 'Completed',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
  retrying: 'Retrying',
  failed: 'Failed',
  rollback: 'Rollback',
};

export const RUNTIME_STATUS_TONE: Record<ExecutionTaskStatus, StatusTone> = {
  queued: 'neutral',
  waiting: 'neutral',
  blocked: 'critical',
  running: 'info',
  paused: 'attention',
  review: 'info',
  completed: 'positive',
  rejected: 'critical',
  cancelled: 'neutral',
  retrying: 'attention',
  failed: 'critical',
  rollback: 'critical',
};

export const TASK_STATUS_TONE: Record<TaskStatus, StatusTone> = {
  pending: 'neutral',
  proposed: 'info',
  accepted: 'positive',
  rejected: 'critical',
  done: 'positive',
  error: 'critical',
};

export const KIND_LABEL: Record<TaskKind, string> = {
  'file-operation': 'File edit',
  'manual-operation': 'Manual',
  review: 'Review',
  approval: 'Approval',
  documentation: 'Documentation',
  research: 'Research',
};

export const KIND_ICON: Record<TaskKind, IconName> = {
  'file-operation': 'code',
  'manual-operation': 'check',
  review: 'eye',
  approval: 'shield',
  documentation: 'doc',
  research: 'research',
};

export const PRIORITY_TONE: Record<TaskPriority, StatusTone> = {
  critical: 'critical',
  high: 'attention',
  medium: 'info',
  low: 'neutral',
};

export const RISK_TONE: Record<TaskRisk, StatusTone> = {
  high: 'critical',
  medium: 'attention',
  low: 'neutral',
};

export const CHECKPOINT_LABEL: Record<string, string> = {
  planning: 'Plan approval',
  execution: 'Execution',
  review: 'Mission review',
  completion: 'Completion',
};

export const CHECKPOINT_STATUS_TONE: Record<CheckpointStatus, StatusTone> = {
  'not-started': 'neutral',
  pending: 'info',
  passed: 'positive',
  failed: 'critical',
  skipped: 'neutral',
};

export const STAGE_LABEL: Record<CreationStage, string> = {
  idle: '',
  classify: 'Classifying intent…',
  signals: 'Gathering real project signals…',
  intent: 'Extracting intent…',
  strategy: 'Selecting mission strategy…',
  'goal-graph': 'Building Goal Graph…',
  risk: 'Analyzing risk…',
  review: 'Adversarial review…',
  quality: 'Scoring plan quality…',
  done: 'Done',
  error: 'Failed',
};

export function relTime(iso: string): string {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

export function fmtDur(minutes: number): string {
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))}m`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

export function fmtClock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
