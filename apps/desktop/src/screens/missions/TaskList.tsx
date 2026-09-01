/**
 * TaskList — the human-gated per-task execution surface.
 * ------------------------------------------------------------------
 * One task per row, grouped by goal. Each row fuses three sources of
 * real state:
 *   • planning detail  — `MissionTask` (what it is, its diff/new-file mode)
 *   • runtime state    — `DagNode` (queued/waiting/blocked/running/review…)
 *   • execution result — `MissionTaskRun` (the generated proposal)
 *
 * Actions follow the state machine: Run a task once its dependencies are
 * met, Accept/Reject once it lands in `review`, Retry when it fails, and
 * Mark Done for manual work. Nothing is ever written until Accept.
 */
import { useEffect, useState } from 'react';
import { DiffEditor } from '@monaco-editor/react';
import { Badge, Button, Icon } from '@aura/ui';
import { useAppStore } from '@aura/core';
import type { DagNode, MissionGoal, MissionTask, MissionTaskRun } from '../../ai/missionClient';
import type { ApprovalRequest } from '../../ai/fabricClient';
import { ApprovalGate } from './ApprovalGate';
import { fsReadFile } from '../../editor/fsClient';
import {
  KIND_ICON, KIND_LABEL, NODE_LABEL, PRIORITY_TONE, RISK_TONE,
  RUNTIME_STATUS_LABEL, TASK_STATUS_TONE, fmtDur,
} from './missionMeta';
import { runtimeFill } from './WorkflowCanvas';

function languageForPath(relPath: string): string {
  const ext = relPath.slice(relPath.lastIndexOf('.'));
  const map: Record<string, string> = { '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript', '.md': 'markdown', '.json': 'json' };
  return map[ext] ?? 'plaintext';
}

export interface TaskListProps {
  projectPath: string;
  tasks: MissionTask[];
  nodes: DagNode[];
  runs: MissionTaskRun[];
  goals?: MissionGoal[];
  approved: boolean;
  busyTaskId: string | null;
  /** Service-side authorization requests. The gate's only source of truth. */
  approvals?: ApprovalRequest[];
  approvalBusyId?: string | null;
  onDecideApproval?: (id: string, granted: boolean, reason?: string) => void;
  onRun: (taskId: string) => void;
  onAccept: (taskId: string) => void;
  onReject: (taskId: string) => void;
  onRetry: (taskId: string) => void;
  onComplete: (taskId: string) => void;
}

export function TaskList(props: TaskListProps) {
  const { goals, tasks } = props;
  if (goals && goals.length) {
    return (
      <div className="space-y-4">
        {goals.map((goal) => {
          const goalTasks = tasks.filter((t) => t.goalId === goal.id);
          if (!goalTasks.length) return null;
          return (
            <section key={goal.id} className="rounded-xl border border-line bg-canvas p-4">
              <header className="mb-3 flex items-center gap-2">
                <Badge tone={PRIORITY_TONE[goal.priority]}>{goal.priority}</Badge>
                <span className="text-[13.5px] font-semibold text-text">{goal.title}</span>
                <span className="ml-auto text-[11px] text-text-subtle">{goalTasks.length} task{goalTasks.length === 1 ? '' : 's'}</span>
              </header>
              <div className="space-y-2">
                {goalTasks.map((t) => <TaskRow key={t.id} {...props} task={t} />)}
              </div>
            </section>
          );
        })}
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {tasks.map((t) => <TaskRow key={t.id} {...props} task={t} />)}
    </div>
  );
}

function TaskRow({
  task, projectPath, nodes, runs, approved, busyTaskId, approvals, approvalBusyId, onDecideApproval,
  onRun, onAccept, onReject, onRetry, onComplete,
}: TaskListProps & { task: MissionTask }) {
  const theme = useAppStore((s) => s.theme);
  const node = nodes.find((n) => n.id === task.id);
  const run = runs.find((r) => r.taskId === task.id);
  const runtime = node?.status ?? 'waiting';
  const depsMet = (node?.blockedBy.length ?? 0) === 0;
  const isManualKind = ['manual-operation', 'review', 'approval', 'documentation', 'research'].includes(task.kind);
  const [original, setOriginal] = useState<string>('');
  const busy = busyTaskId === task.id;

  useEffect(() => {
    if (run?.status !== 'proposed' || task.mode !== 'diff' || !task.targetFile) return;
    let alive = true;
    fsReadFile(projectPath, task.targetFile).then((c) => { if (alive) setOriginal(c); }).catch(() => {});
    return () => { alive = false; };
  }, [run?.status, task.mode, task.targetFile, projectPath]);

  const fill = runtimeFill(runtime);
  const IconCmp = KIND_ICON[task.kind] ?? 'doc';
  const showProposal = run?.status === 'proposed' && run.proposal;
  // A gated task sits in `queued` like any other — the gate itself is the
  // only thing that distinguishes it, and it comes from the service.
  const gate = approvals?.find((a) => a.taskId === task.id && a.state === 'pending');

  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2.5 transition-colors hover:bg-surface-hover">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold" style={{ background: `${fill}22`, color: fill }}>
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: fill }} />
          {RUNTIME_STATUS_LABEL[runtime]}
        </span>
        <Badge tone={TASK_STATUS_TONE[task.status]}>{task.status}</Badge>
        <Icon name={IconCmp} size={13} className="text-text-muted" />
        <span className="text-[12.5px] font-medium text-text">{task.title}</span>
        {task.targetFile && <span className="text-[11px] text-text-subtle">{task.targetFile}</span>}
        {(task.resolvedNode || task.requestedNode) && (
          <span className="rounded bg-surface-active px-1.5 py-0.5 text-[10px] font-medium text-text-muted" title={`Requested: ${task.requestedNode ?? 'auto'} · Resolved: ${task.resolvedNode ?? 'pending'}`}>
            {NODE_LABEL[task.resolvedNode ?? task.requestedNode ?? ''] ?? task.resolvedNode ?? task.requestedNode}
          </span>
        )}
        {run?.executedNode && (
          <span className="rounded bg-surface-active px-1.5 py-0.5 text-[10px] font-medium" style={{ color: 'var(--positive)' }} title="Executed node (Recorded)">
            {NODE_LABEL[run.executedNode] ?? run.executedNode}
          </span>
        )}
        <span className="ml-auto flex items-center gap-1.5 text-[10.5px] text-text-subtle">
          <Badge tone={PRIORITY_TONE[task.priority]}>{task.priority}</Badge>
          <Badge tone={RISK_TONE[task.risk]}>{task.risk} risk</Badge>
          <span>{fmtDur(task.estimatedDurationMinutes)}</span>
          {task.owner === 'human' && <span className="rounded bg-surface-active px-1 py-0.5">manual</span>}
        </span>
      </div>

      <p className="mt-1 text-[11.5px] leading-relaxed text-text-muted">{task.description}</p>

      {(runtime === 'blocked' || (node && node.blockedBy.length > 0)) && (
        <p className="mt-1 text-[10.5px] text-danger">
          Blocked by: {node?.blockedBy.map((b) => nodes.find((n) => n.id === b)?.title ?? b).join(' · ') || 'unmet dependencies'}
        </p>
      )}

      {gate && onDecideApproval && (
        <ApprovalGate request={gate} busy={approvalBusyId === gate.id} onDecide={onDecideApproval} />
      )}

      {showProposal && run?.proposal && (
        <div className="mt-2 space-y-2">
          <div className="flex flex-wrap items-center gap-1.5">
            {run.proposal.operation?.type === 'git' && (
              <Badge tone="info">git · {run.proposal.operation.operation}{run.proposal.operation.message ? ` — "${run.proposal.operation.message}"` : ''}</Badge>
            )}
          </div>
          <p className="text-[11.5px] text-text-muted">{run.proposal.explanation}</p>
          {run.proposal.newCode != null && task.targetFile && (
            <div className="overflow-hidden rounded-lg border border-line">
              <DiffEditor
                height="240px"
                language={languageForPath(task.targetFile)}
                original={original}
                modified={run.proposal.newCode}
                theme={theme === 'dark' ? 'aura-dark' : 'aura-light'}
                options={{ fontSize: 12, readOnly: true, renderSideBySide: true, minimap: { enabled: false }, scrollBeyondLastLine: false }}
              />
            </div>
          )}
        </div>
      )}

      <div className="mt-2 flex items-center justify-end gap-2">
        <span className="mr-auto text-[10.5px] text-text-subtle">{KIND_LABEL[task.kind]}{task.mode === 'new-file' ? ' · new file' : task.mode === 'diff' ? ' · edits existing' : ''}</span>
        {isManualKind && (runtime === 'waiting' || runtime === 'queued') && (
          <Button size="sm" variant="secondary" disabled={!approved || !depsMet} loading={busy} onClick={() => onComplete(task.id)}>Mark Done</Button>
        )}
        {/* While a gate is open the answer is Approve/Decline on the gate
            itself — offering Run as well would present two ways to say yes,
            only one of which is authorized. */}
        {runtime === 'queued' && !isManualKind && !gate && (
          <Button size="sm" variant="primary" disabled={!approved || !depsMet} loading={busy} onClick={() => onRun(task.id)}>
            {depsMet ? 'Run Task' : 'Waiting on deps'}
          </Button>
        )}
        {(runtime === 'failed' || runtime === 'retrying') && (
          <Button size="sm" variant="secondary" loading={busy} onClick={() => onRetry(task.id)}>Retry</Button>
        )}
        {runtime === 'review' && (
          <>
            <Button size="sm" variant="secondary" onClick={() => onReject(task.id)}>Reject</Button>
            <Button size="sm" variant="primary" icon="check" loading={busy} onClick={() => onAccept(task.id)}>Accept</Button>
          </>
        )}
        {runtime === 'completed' && <Icon name="check" size={14} className="text-positive" />}
      </div>
    </div>
  );
}
