import type { ReactNode } from 'react';
import type { MissionRecord } from '../../../ai/missionClient';
import type { CreationState } from '../../missions/useMissions';
import type { HubProgress } from '../../../workspace/hubPhase';
import type { TimelineStep } from './TimelineStepCard';

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function fileListBody(files: string[]): ReactNode {
  return files.length === 0 ? 'No files yet.' : files.join('  ·  ');
}

/**
 * Maps authoritative mission state onto the reference timeline flow.
 * No invented providers, times, or counts — every row derives from
 * CreationState / MissionRecord. Rows with no real data are omitted.
 */
export function toTimelineSteps(
  active: MissionRecord | null,
  creation: CreationState,
  progress: HubProgress,
): TimelineStep[] {
  const steps: TimelineStep[] = [];
  const tasks = active?.goalGraph?.tasks ?? [];
  const exec = active?.execution ?? null;
  const metrics = exec?.metrics ?? null;

  // 1 — AURA planning (always present once a mission exists or is streaming)
  if (active || creation.stage !== 'idle') {
    const planTitles = tasks.slice(0, 5).map((t) => t.title);
    steps.push({
      id: 'aura-plan',
      actor: 'AURA Agent',
      detail: progress.phase === 'idle' ? 'Ready — describe the outcome you want.' : progress.detail || 'Analyzing your request and planning the workflow…',
      timestamp: fmtTime(active?.createdAt),
      status: progress.phase === 'failed' ? 'failed' : progress.phase === 'idle' ? 'idle' : 'planning',
      tint: 'violet',
      icon: 'cpu',
      body: planTitles.length > 0 ? planTitles.map((t, i) => `${i + 1}. ${t}`).join('\n') : undefined,
    });
  }

  // 2 — Analysis (research/documentation tasks, real titles only)
  const analysis = tasks.filter((t) => t.kind === 'research' || t.kind === 'documentation').slice(0, 4);
  if (analysis.length > 0) {
    steps.push({
      id: 'analysis',
      actor: 'Analysis',
      detail: 'Generating application architecture and system design…',
      timestamp: fmtTime(active?.createdAt),
      status: 'analyzing',
      tint: 'amber',
      icon: 'research',
      body: analysis.map((t) => t.title).join('\n'),
      ctaLabel: 'View Details',
    });
  }

  // 3 — Coding (file-operation tasks with real target files)
  const codeTasks = tasks.filter((t) => t.kind === 'file-operation' || t.kind === 'git-operation');
  if (codeTasks.length > 0) {
    const files = codeTasks.map((t) => t.targetFile).filter((f): f is string => !!f).slice(0, 8);
    const done = active?.taskRuns?.filter((r) => r.status === 'done').length ?? 0;
    steps.push({
      id: 'coding',
      actor: 'Code',
      detail: `Creating boilerplate code and core components… (${done}/${codeTasks.length} done)`,
      timestamp: fmtTime(exec?.startedAt ?? active?.createdAt),
      status: exec?.status === 'running' ? 'executing' : 'coding',
      tint: 'blue',
      icon: 'code',
      body: files.length > 0 ? fileListBody(files) : `${codeTasks.length} tasks planned`,
      ctaLabel: 'View Files',
    });
  }

  // 4 — Assets/generating (remaining manual/documentation work, if any)
  const assetTasks = tasks.filter((t) => t.owner === 'human' || t.kind === 'manual-operation').slice(0, 4);
  if (assetTasks.length > 0) {
    steps.push({
      id: 'assets',
      actor: 'Assets',
      detail: 'Generating UI design and assets…',
      timestamp: fmtTime(exec?.startedAt ?? active?.createdAt),
      status: 'generating',
      tint: 'violet',
      icon: 'spark',
      body: assetTasks.map((t) => t.title).join('\n'),
      ctaLabel: 'View Assets',
    });
  }

  // 5 — Tools/execution (real execution timeline tail)
  if (exec) {
    const tail = exec.timeline.slice(-3).map((e) => e.title).join(' · ') || `Batch ${exec.batchIndex + 1}`;
    steps.push({
      id: 'tools',
      actor: 'Tools',
      detail: metrics
        ? `Setting up environment · ${metrics.tasksCompleted}/${metrics.tasksTotal} tasks`
        : 'Setting up development environment and installing dependencies…',
      timestamp: fmtTime(exec.lastUpdatedAt),
      status: exec.status === 'completed' ? 'completed' : exec.status === 'failed' ? 'failed' : 'executing',
      tint: 'cyan',
      icon: 'terminal',
      body: tail,
      ctaLabel: 'Open in Terminal',
    });
  }

  // 6 — Result (only when truly completed)
  if (exec?.status === 'completed') {
    steps.push({
      id: 'result',
      actor: 'AURA Agent',
      detail: 'Work completed — project is ready.',
      timestamp: fmtTime(exec.completedAt ?? exec.lastUpdatedAt),
      status: 'completed',
      tint: 'green',
      icon: 'check',
      body: metrics
        ? `Completed ${metrics.tasksCompleted}/${metrics.tasksTotal} tasks · ${metrics.parallelBatches} batches`
        : 'All tasks finished.',
      ctaLabel: 'Open Project',
    });
  }

  return steps;
}
