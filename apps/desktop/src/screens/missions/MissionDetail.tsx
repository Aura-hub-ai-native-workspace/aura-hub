/**
 * MissionDetail — Mission Control v3's detail surface for one mission.
 * ------------------------------------------------------------------
 * Everything renders from real state: the engine's DAG drives the
 * Canvas + wave stepper, checkpoint gates own plan approval and mission
 * review, and the Timeline/Activity/Replay tabs re-trace what actually
 * happened. Execution controls follow the state machine exactly
 * (approved→start, running→pause/cancel, paused→resume, …). Proposals
 * are never written until a human accepts them.
 */
import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Icon } from '@aura/ui';
import type { IconName } from '@aura/ui';
import type { MissionRecord } from '../../ai/missionClient';
import type { useMissions } from './useMissions';
import {
  CATEGORY_LABEL, CATEGORY_TONE, EXECUTION_STATUS_ICON,
  EXECUTION_STATUS_LABEL, EXECUTION_STATUS_TONE, PRIORITY_TONE, RISK_TONE,
  fmtDur, relTime,
} from './missionMeta';
import { CheckpointPanel } from './CheckpointPanel';
import { TaskList } from './TaskList';
import { WorkflowCanvas, runtimeFill } from './WorkflowCanvas';
import { MissionTimeline } from './MissionTimeline';
import { ActivityFeed } from './ActivityFeed';
import { MissionReplay } from './MissionReplay';

type Tab = 'overview' | 'tasks' | 'canvas' | 'timeline' | 'activity' | 'replay';
const TABS: { key: Tab; label: string; icon: IconName }[] = [
  { key: 'overview', label: 'Overview', icon: 'grid' },
  { key: 'tasks', label: 'Tasks', icon: 'clipboard' },
  { key: 'canvas', label: 'Canvas', icon: 'workflows' },
  { key: 'timeline', label: 'Timeline', icon: 'activity' },
  { key: 'activity', label: 'Activity', icon: 'bell' },
  { key: 'replay', label: 'Replay', icon: 'refresh' },
];

export function MissionDetail({
  projectPath,
  missions,
}: {
  projectPath: string;
  missions: ReturnType<typeof useMissions>;
}) {
  const mission = missions.active as MissionRecord;
  const ex = mission.execution ?? null;
  const [tab, setTab] = useState<Tab>('overview');
  const [selNode, setSelNode] = useState<string | null>(null);

  useEffect(() => { setTab('overview'); setSelNode(null); }, [mission.id]);

  const metrics = ex?.metrics ?? null;
  const status = ex?.status ?? 'idle';
  const running = status === 'running' || status === 'paused';

  const handleAction = {
    approve: () => void missions.approve(),
    rejectPlan: () => void missions.rejectPlan(),
    start: () => void missions.startExecution(),
    runWave: () => void missions.runBatch(),
    pause: () => void missions.pause(),
    resume: () => void missions.resume(),
    cancel: () => void missions.cancel(),
    review: (pass: boolean, note?: string) => void missions.reviewCheckpoint(pass, note),
  };

  const goalTasks = mission.goalGraph?.tasks ?? [];
  const dagNodes = ex?.dag?.nodes ?? [];
  const selectedNode = selNode ? dagNodes.find((n) => n.id === selNode) ?? null : null;
  const selectedTask = selNode ? goalTasks.find((t) => t.id === selNode) ?? null : null;
  const selectedRun = selNode ? mission.taskRuns.find((r) => r.taskId === selNode) ?? null : null;

  const waveChunks = useMemo(() => ex?.dag?.batches ?? [], [ex?.dag]);

  return (
    <div className="mx-auto max-w-[960px] space-y-4 px-8 py-6">
      {/* header */}
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-[16px] font-semibold text-text">{mission.text}</h1>
          <Badge tone={CATEGORY_TONE[mission.classification?.category ?? 'unknown']}>{CATEGORY_LABEL[mission.classification?.category ?? 'unknown']}</Badge>
          <Badge tone={EXECUTION_STATUS_TONE[status]}><Icon name={EXECUTION_STATUS_ICON[status]} size={11} className="mr-0.5" />{EXECUTION_STATUS_LABEL[status]}</Badge>
          {mission.approval.status === 'pending' && <Badge tone="attention">plan pending approval</Badge>}
        </div>
        <p className="mt-1 text-[11.5px] text-text-muted">
          {relTime(mission.createdAt)} · {mission.goalGraph?.goals.length ?? 0} goals · {goalTasks.length} tasks
          {mission.quality && <span className="text-text-subtle"> · plan quality <strong className="text-text">Q{Math.round(mission.quality.overall * 100)}</strong></span>}
          {mission.risk && <span className="text-text-subtle"> · risk <strong className="text-text">{mission.risk.overall.toFixed(1)}/5</strong></span>}
        </p>
        {mission.error && (
          <div className="mt-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">{mission.error}</div>
        )}
        {missions.error && (
          <div className="mt-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">{missions.error}</div>
        )}
      </div>

      {/* execution controls */}
      {ex && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-canvas px-4 py-2.5">
          {status === 'approved' && (
            <>
              <span className="mr-auto text-[12px] text-text-muted">Plan approved — ready to execute wave by wave.</span>
              <Button size="sm" variant="primary" icon="activity" loading={missions.batchBusy} onClick={handleAction.start}>Start Execution</Button>
            </>
          )}
          {status === 'running' && (
            <>
              <span className="mr-auto inline-flex items-center gap-2 text-[12px] text-text-muted"><span className="aura-live h-2 w-2 rounded-full bg-accent text-accent" />Execution in progress</span>
              <Button size="sm" variant="secondary" onClick={handleAction.pause}>Pause</Button>
              <Button size="sm" variant="primary" icon="spark" loading={missions.batchBusy} onClick={handleAction.runWave}>Run next wave</Button>
              <Button size="sm" variant="secondary" className="text-danger" onClick={() => { if (confirm('Cancel this mission?')) handleAction.cancel(); }}>Cancel</Button>
            </>
          )}
          {status === 'paused' && (
            <>
              <span className="mr-auto text-[12px] text-text-muted">Execution paused.</span>
              <Button size="sm" variant="secondary" onClick={() => { if (confirm('Cancel this mission?')) handleAction.cancel(); }} className="text-danger">Cancel</Button>
              <Button size="sm" variant="secondary" onClick={handleAction.resume}>Resume</Button>
              <Button size="sm" variant="primary" icon="spark" loading={missions.batchBusy} onClick={handleAction.runWave}>Run next wave</Button>
            </>
          )}
          {status === 'reviewing' && (
            <span className="mr-auto inline-flex items-center gap-2 text-[12px] text-text-muted">
              <span className="aura-live h-2 w-2 rounded-full bg-accent text-accent" />All tasks resolved — mission review required below.
            </span>
          )}
          {status === 'completed' && <span className="mr-auto text-[12px] text-positive">Mission completed {ex.completedAt ? `· ${relTime(ex.completedAt)}` : ''}</span>}
          {status === 'cancelled' && <span className="mr-auto text-[12px] text-text-muted">Mission cancelled.</span>}
          {status === 'failed' && <span className="mr-auto text-[12px] text-danger">Execution failed — review the timeline for what went wrong.</span>}
          {status === 'idle' && mission.approval.status === 'approved' && <span className="mr-auto text-[12px] text-text-muted">Plan approved — start execution when ready.</span>}
          {running && metrics && (
            <span className="text-[11px] tabular-nums text-text-muted">{metrics.tasksCompleted}/{metrics.tasksTotal} done</span>
          )}
        </div>
      )}

      {/* checkpoint gates */}
      {ex && <CheckpointPanel checkpoints={ex.checkpoints} executionStatus={status} approval={mission.approval} onApprove={handleAction.approve} onRejectPlan={handleAction.rejectPlan} onReview={handleAction.review} />}

      {/* metrics strip */}
      {metrics && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
          <Metric label="Completion" value={`${Math.round(metrics.completion * 100)}%`} tone={metrics.completion >= 1 ? 'positive' : 'info'} />
          <Metric label="Tasks" value={`${metrics.tasksCompleted}/${metrics.tasksTotal}`} />
          <Metric label="Running" value={String(metrics.tasksRunning)} tone={metrics.tasksRunning > 0 ? 'attention' : 'neutral'} />
          <Metric label="In review" value={String(metrics.tasksReview)} tone={metrics.tasksReview > 0 ? 'info' : 'neutral'} />
          <Metric label="Failed" value={String(metrics.tasksFailed)} tone={metrics.tasksFailed > 0 ? 'critical' : 'neutral'} />
          <Metric label="Critical path" value={`${metrics.criticalPathDone}/${metrics.criticalPathTotal}`} />
          <Metric label="Wave" value={`${Math.min(metrics.currentBatch + 1, metrics.parallelBatches)}/${metrics.parallelBatches}`} />
          <Metric label="Remaining" value={metrics.estimatedRemainingMinutes > 0 ? fmtDur(metrics.estimatedRemainingMinutes) : '—'} />
        </div>
      )}

      {/* wave stepper (plan overview) */}
      {ex?.dag && waveChunks.length > 1 && (
        <div className="rounded-xl border border-line bg-canvas p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-text-subtle">Execution waves</span>
            {metrics && <span className="text-[10.5px] text-text-subtle">auto-ordered by dependencies · critical path in accent</span>}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {waveChunks.map((chunk, i) => {
              const done = chunk.every((id) => ex.dag?.nodes.find((n) => n.id === id)?.status === 'completed');
              const active = metrics?.currentBatch === i && !done;
              return (
                <button
                  key={i}
                  onClick={() => setTab('canvas')}
                  className={`rounded-lg border px-2.5 py-1.5 text-left transition-colors ${done ? 'border-positive/40 bg-positive/10' : active ? 'border-accent bg-accent/10' : 'border-line bg-surface hover:bg-surface-hover'}`}
                >
                  <div className="text-[10px] font-medium text-text">Wave {i + 1}</div>
                  <div className="mt-0.5 flex items-center gap-1">
                    {chunk.slice(0, 4).map((id) => {
                      const n = ex.dag?.nodes.find((x) => x.id === id);
                      const s = n?.status ?? 'waiting';
                      return <span key={id} className="h-1.5 w-1.5 rounded-full" style={{ background: s === 'completed' ? 'var(--positive)' : runtimeFill(s) }} title={n?.title} />;
                    })}
                    {chunk.length > 4 && <span className="text-[9px] text-text-subtle">+{chunk.length - 4}</span>}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* tabs */}
      <div className="flex gap-0.5 rounded-lg border border-line bg-canvas p-0.5">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[11.5px] font-medium transition-colors ${tab === t.key ? 'bg-surface text-text shadow-sm' : 'text-text-muted hover:text-text'}`}
          >
            <Icon name={t.icon} size={12} />{t.label}
          </button>
        ))}
      </div>

      {!ex && mission.goalGraph && (
        <div className="rounded-xl border border-line bg-canvas p-4 text-[12px] text-text-muted">
          Plan built — approve it in the checkpoints panel to unlock execution.
        </div>
      )}
      {!ex && !mission.goalGraph && !mission.error && (
        <div className="rounded-xl border border-line bg-canvas p-4 text-[12px] text-text-subtle">No plan was generated for this mission.</div>
      )}

      {tab === 'overview' && ex && (
        <div className="space-y-4">
          <SignalsPanel signals={mission.signals} />
          <div className="grid gap-4 sm:grid-cols-2">
            <StrategyCard mission={mission} />
            <RiskQualityCard mission={mission} />
          </div>
        </div>
      )}
      {tab === 'overview' && !ex && mission.goalGraph && (
        <div className="space-y-4">
          <SignalsPanel signals={mission.signals} />
          <div className="grid gap-4 sm:grid-cols-2">
            <StrategyCard mission={mission} />
            <RiskQualityCard mission={mission} />
          </div>
        </div>
      )}

      {tab === 'tasks' && goalTasks.length > 0 && (
        <TaskList
          projectPath={projectPath}
          tasks={goalTasks}
          nodes={dagNodes}
          runs={mission.taskRuns}
          goals={mission.goalGraph?.goals}
          approved={mission.approval.status === 'approved'}
          busyTaskId={missions.busyTaskId}
          onRun={missions.runTask}
          onAccept={missions.acceptTask}
          onReject={missions.rejectTask}
          onRetry={missions.retryTask}
          onComplete={missions.completeTask}
        />
      )}
      {tab === 'tasks' && goalTasks.length === 0 && (
        <div className="rounded-xl border border-line bg-canvas p-4 text-[12px] text-text-subtle">No tasks in this plan.</div>
      )}

      {tab === 'canvas' && ex?.dag && (
        <div className="space-y-3">
          <WorkflowCanvas dag={ex.dag} selectedId={selNode} onSelect={setSelNode} height={520} />
          {selectedNode && (
            <div className="rounded-xl border border-line bg-canvas p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full px-2 py-0.5 text-[10px] font-semibold" style={{ background: `${runtimeFill(selectedNode.status)}22`, color: runtimeFill(selectedNode.status) }}>
                  {selectedNode.status}
                </span>
                <span className="text-[12.5px] font-medium text-text">{selectedNode.title}</span>
                <span className="ml-auto flex items-center gap-1.5 text-[10.5px] text-text-subtle">
                  <Badge tone={PRIORITY_TONE[selectedNode.priority]}>{selectedNode.priority}</Badge>
                  <Badge tone={RISK_TONE[selectedNode.risk]}>{selectedNode.risk} risk</Badge>
                  <span>{fmtDur(selectedNode.estimatedDurationMinutes)}</span>
                </span>
              </div>
              {selectedTask && <p className="mt-1.5 text-[11.5px] text-text-muted">{selectedTask.description}</p>}
              <div className="mt-2 flex items-center gap-2">
                {selectedRun?.status === 'proposed' && (
                  <>
                    <Button size="sm" variant="secondary" onClick={() => void missions.rejectTask(selectedNode.id)}>Reject</Button>
                    <Button size="sm" variant="primary" icon="check" loading={missions.busyTaskId === selectedNode.id} onClick={() => void missions.acceptTask(selectedNode.id)}>Accept</Button>
                  </>
                )}
                {(selectedNode.status === 'failed' || selectedNode.status === 'retrying') && (
                  <Button size="sm" variant="secondary" onClick={() => void missions.retryTask(selectedNode.id)}>Retry</Button>
                )}
                <span className="ml-auto text-[10.5px] text-text-subtle">
                  {selectedNode.dependencies.length > 0 && `depends on ${selectedNode.dependencies.length}`}
                  {selectedNode.dependencies.length > 0 && selectedNode.blockedBy.length > 0 && ' · '}
                  {selectedNode.blockedBy.length > 0 && `blocked by ${selectedNode.blockedBy.length}`}
                </span>
              </div>
            </div>
          )}
        </div>
      )}
      {tab === 'canvas' && !ex?.dag && (
        <div className="rounded-xl border border-line bg-canvas p-4 text-[12px] text-text-subtle">The execution DAG will appear here once the plan is approved.</div>
      )}

      {tab === 'timeline' && <MissionTimeline entries={ex?.timeline ?? []} />}

      {tab === 'activity' && <ActivityFeed activity={ex?.activity ?? []} />}

      {tab === 'replay' && <MissionReplay replay={missions.replay} loadReplay={() => void missions.loadReplay(mission.id)} />}
    </div>
  );
}

/* ── helpers ──────────────────────────────────────────────────────── */

function Metric({ label, value, tone }: { label: string; value: string; tone?: 'positive' | 'attention' | 'critical' | 'info' | 'neutral' }) {
  const color = tone === 'positive' ? 'var(--positive)' : tone === 'attention' ? 'var(--attention)' : tone === 'critical' ? 'var(--danger)' : tone === 'info' ? 'var(--accent)' : 'var(--text)';
  return (
    <div className="rounded-lg border border-line bg-canvas px-2.5 py-2 text-center">
      <div className="text-[13px] font-semibold tabular-nums" style={{ color }}>{value}</div>
      <div className="text-[9.5px] uppercase tracking-wide text-text-subtle">{label}</div>
    </div>
  );
}

function SignalsPanel({ signals }: { signals: MissionRecord['signals'] }) {
  return (
    <div className="rounded-xl border border-line bg-canvas p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-[12px] font-semibold text-text">Real signals (deterministic)</span>
        {signals.buildStatus?.available === true && (
          <span className={`text-[10.5px] ${signals.buildStatus.ok ? 'text-positive' : 'text-danger'}`}>build: {signals.buildStatus.ok ? 'ok' : 'failing'}</span>
        )}
      </div>
      {signals.health ? (
        <div className="mb-3 grid grid-cols-3 gap-2 sm:grid-cols-6">
          {(['overall', 'documentation', 'architecture', 'testing', 'dependencies', 'maintainability'] as const).map((k) => (
            <div key={k} className="rounded-lg border border-line px-2.5 py-2 text-center">
              <div className="text-[15px] font-semibold text-text">{signals.health![k]}</div>
              <div className="text-[10px] uppercase tracking-wide text-text-subtle">{k}</div>
            </div>
          ))}
        </div>
      ) : (
        <div className="mb-3 text-[12px] text-text-subtle">Health score unavailable.</div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <div className="mb-1 text-[11px] font-medium text-text-muted">Health issues ({signals.healthIssues.length})</div>
          <ul className="space-y-1">
            {signals.healthIssues.slice(0, 6).map((i, idx) => (
              <li key={idx} className="text-[11.5px] text-text-muted">
                <Badge tone={i.severity === 'critical' ? 'critical' : i.severity === 'warning' ? 'attention' : 'neutral'}>{i.severity}</Badge>{' '}
                {i.message}
              </li>
            ))}
            {!signals.healthIssues.length && <li className="text-[11.5px] text-text-subtle">None found.</li>}
          </ul>
        </div>
        <div>
          <div className="mb-1 text-[11px] font-medium text-text-muted">Change hotspots (velocity: {signals.changeVelocity.toFixed(1)}/day)</div>
          <ul className="space-y-1">
            {signals.hotspots.slice(0, 6).map((h, idx) => (
              <li key={idx} className="text-[11.5px] text-text-muted">{h.file} <span className="text-text-subtle">— {h.reason}</span></li>
            ))}
            {!signals.hotspots.length && <li className="text-[11.5px] text-text-subtle">None found.</li>}
          </ul>
        </div>
      </div>

      <div className="mt-3 border-t border-line pt-3 text-[11.5px] text-text-muted">
        Verification score: <strong className="text-text">{signals.verificationScore}</strong>
        {signals.verificationRecommendations.length > 0 && (
          <ul className="mt-1 list-inside list-disc space-y-0.5">
            {signals.verificationRecommendations.slice(0, 4).map((r, idx) => <li key={idx}>{r}</li>)}
          </ul>
        )}
      </div>
    </div>
  );
}

function StrategyCard({ mission }: { mission: MissionRecord }) {
  const s = mission.strategy;
  return (
    <div className="rounded-xl border border-line bg-canvas p-4">
      <span className="text-[12px] font-semibold text-text">Mission strategy</span>
      {s ? (
        <>
          <p className="mt-1.5 text-[11.5px] leading-relaxed text-text-muted">{s.guidance}</p>
          <div className="mt-2 flex flex-wrap gap-1">
            {s.focusAreas.slice(0, 6).map((f) => (
              <span key={f.id} title={f.description} className="rounded-full bg-surface-active px-2 py-0.5 text-[10px] text-text-muted">{f.label}</span>
            ))}
          </div>
        </>
      ) : (
        <p className="mt-1.5 text-[11.5px] text-text-subtle">Not selected.</p>
      )}
    </div>
  );
}

function RiskQualityCard({ mission }: { mission: MissionRecord }) {
  const r = mission.risk;
  return (
    <div className="space-y-4">
      {mission.review && (
        <div className="rounded-xl border border-line bg-canvas p-4">
          <div className="flex items-center justify-between">
            <span className="text-[12px] font-semibold text-text">Adversarial review</span>
            <Badge tone={mission.review.verdict === 'approved' ? 'positive' : 'attention'}>{mission.review.verdict}</Badge>
          </div>
          <p className="mt-1.5 text-[11.5px] leading-relaxed text-text-muted">{mission.review.summary}</p>
          {mission.review.findings.length > 0 && (
            <ul className="mt-1.5 list-inside list-disc space-y-0.5 text-[11px] text-text-subtle">
              {mission.review.findings.slice(0, 4).map((f, i) => <li key={i}>{f.detail}</li>)}
            </ul>
          )}
        </div>
      )}
      {r && (
        <div className="rounded-xl border border-line bg-canvas p-4">
          <div className="flex items-center justify-between">
            <span className="text-[12px] font-semibold text-text">Risk analysis</span>
            <Badge tone={RISK_TONE[r.overall > 3 ? 'high' : r.overall > 1.8 ? 'medium' : 'low']}>{r.overall.toFixed(1)}/5</Badge>
          </div>
          <div className="mt-2 grid grid-cols-5 gap-1.5">
            {([['arch', r.architectureRisk], ['deps', r.dependencyRisk], ['security', r.securityRisk], ['regression', r.regressionRisk], ['complexity', r.complexity]] as const).map(([label, v]) => (
              <div key={label} className="text-center">
                <div className="h-1 overflow-hidden rounded-full bg-surface-active">
                  <div className="h-full rounded-full" style={{ width: `${Math.min(100, v * 20)}%`, background: v > 3 ? 'var(--danger)' : v > 1.8 ? 'var(--attention)' : 'var(--positive)' }} />
                </div>
                <div className="mt-0.5 text-[9px] text-text-subtle">{label}</div>
              </div>
            ))}
          </div>
          {r.unknowns.length > 0 && (
            <ul className="mt-1.5 list-inside list-disc space-y-0.5 text-[11px] text-text-subtle">
              {r.unknowns.slice(0, 3).map((u, i) => <li key={i}>{u}</li>)}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
