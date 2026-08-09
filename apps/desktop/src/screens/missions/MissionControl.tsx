/**
 * MissionControl — every project's own goal-to-plan surface.
 * ------------------------------------------------------------------
 * Scoped to the currently open project. A mission is built through a real
 * 9-stage pipeline (deterministic intent classification → intent
 * extraction → deterministic project-signal gathering → deterministic
 * strategy scaffold → Goal Graph → deterministic risk analysis →
 * adversarial review → deterministic quality score) — never a single
 * generic prompt.
 *
 * EXECUTION is engine-driven (mission/execution/): an approved plan
 * becomes a DAG (dependencies/blocks/critical path/parallel waves) and
 * the engine advances tasks wave by wave. Human gating is unchanged:
 * the whole plan needs an explicit Approve before any task runs, and
 * each AI proposal needs an explicit Accept before it is written to disk.
 *
 * The rail offers search, category and execution-status filters; list
 * rows carry live progress from the execution metrics.
 */
import { useEffect, useState } from 'react';
import { Badge, Button, Icon } from '@aura/ui';
import { useWorkspace } from '../../data/useWorkspace';
import { EmptyState } from '../../components/EmptyState';
import { useMissions } from './useMissions';
import { MissionDetail } from './MissionDetail';
import { CreationProgress } from './CreationProgress';
import type { ExecutionStatus, MissionCategory } from '../../ai/missionClient';
import { CATEGORY_LABEL, CATEGORY_TONE, EXECUTION_STATUS_LABEL, relTime, STAGE_LABEL } from './missionMeta';

const EXAMPLE_MISSION = 'Prepare this project for production';

const EXEC_FILTERS: (ExecutionStatus | 'all')[] = ['all', 'idle', 'approved', 'running', 'paused', 'reviewing', 'completed', 'failed'];

export function MissionControl() {
  const openId = useWorkspace((s) => s.openId);
  const project = useWorkspace((s) => s.projects.find((p) => p.id === s.openId));
  const missions = useMissions(openId);
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<MissionCategory | 'all'>('all');
  const [exec, setExec] = useState<ExecutionStatus | 'all'>('all');

  // Load the list when the panel opens, and whenever the open project
  // changes. Without this the panel showed "No missions yet" until some
  // other action happened to refresh it — `MissionDetailPanel` had the
  // effect, the main Missions panel never did.
  const { refreshList } = missions;
  useEffect(() => { void refreshList(); }, [openId, refreshList]);

  if (!openId || !project) {
    return (
      <div className="grid h-full place-items-center p-10">
        <EmptyState
          icon="deploy"
          title="Open a project to start a mission"
          description="Mission Control turns a real goal into a grounded, human-approved plan for whichever project you have open."
        />
      </div>
    );
  }

  const creating = missions.creation.stage !== 'idle' && missions.creation.stage !== 'done' && missions.creation.stage !== 'error';

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    setText('');
    void missions.createMission(t);
  };

  const needle = q.trim().toLowerCase();
  const filtered = missions.missions.filter((m) => {
    if (needle && !m.text.toLowerCase().includes(needle) && !CATEGORY_LABEL[m.category].toLowerCase().includes(needle)) return false;
    if (cat !== 'all' && m.category !== cat) return false;
    if (exec !== 'all' && m.execution?.status !== exec) return false;
    return true;
  });
  const categories = Array.from(new Set(missions.missions.map((m) => m.category)));

  return (
    <div className="flex h-full min-h-0 w-full">
      <div className="flex w-[330px] shrink-0 flex-col border-r border-line">
        <div className="shrink-0 border-b border-line px-5 py-4">
          <div className="flex items-center gap-2">
            <Icon name="deploy" size={16} className="text-accent" />
            <span className="text-[13px] font-semibold text-text">Mission Control</span>
          </div>
          <p className="mt-1 text-[11.5px] text-text-muted">{project.name}</p>
        </div>

        <div className="shrink-0 space-y-2 border-b border-line px-4 py-3">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(); }}
            placeholder={`Describe a mission… e.g. "${EXAMPLE_MISSION}"`}
            rows={3}
            className="w-full resize-none rounded-lg border border-line bg-canvas px-3 py-2 text-[12.5px] text-text outline-none placeholder:text-text-subtle focus:border-accent"
          />
          <Button size="sm" variant="primary" icon="plus" loading={creating} disabled={!text.trim() || creating} onClick={submit} className="w-full">
            New Mission
          </Button>
          {creating && (
            <p className="text-center text-[11px] text-text-subtle">{STAGE_LABEL[missions.creation.stage]}</p>
          )}
        </div>

        <div className="shrink-0 space-y-2 border-b border-line px-4 py-3">
          <div className="relative">
            <Icon name="search" size={13} className="pointer-events-none absolute left-2.5 top-2 text-text-subtle" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search missions…"
              className="w-full rounded-lg border border-line bg-canvas py-1.5 pl-7 pr-2.5 text-[12px] text-text outline-none placeholder:text-text-subtle focus:border-accent"
            />
          </div>
          {categories.length > 0 && (
            <div className="flex flex-wrap gap-1">
              <FilterChip active={cat === 'all'} label="All" onClick={() => setCat('all')} />
              {categories.map((c) => (
                <FilterChip key={c} active={cat === c} label={CATEGORY_LABEL[c]} onClick={() => setCat(c)} />
              ))}
            </div>
          )}
          <div className="flex flex-wrap gap-1">
            {EXEC_FILTERS.map((e) => (
              <FilterChip key={e} active={exec === e} label={e === 'all' ? 'any state' : EXECUTION_STATUS_LABEL[e]} onClick={() => setExec(e)} />
            ))}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {missions.loadingList && !missions.missions.length && (
            <div className="px-3 py-6 text-center text-[12px] text-text-subtle">Loading…</div>
          )}
          {!missions.loadingList && !missions.missions.length && (
            <div className="px-3 py-6 text-center text-[12px] text-text-subtle">No missions yet.</div>
          )}
          {missions.missions.length > 0 && filtered.length === 0 && (
            <div className="px-3 py-6 text-center text-[12px] text-text-subtle">No missions match the filters.</div>
          )}
          {filtered.map((m) => {
            const progress = m.execution?.metrics ? Math.round(m.execution.metrics.completion * 100) : m.approval.status === 'approved' ? 0 : null;
            const execLabel = m.execution ? EXECUTION_STATUS_LABEL[m.execution.status] : m.approval.status;
            return (
              <button
                key={m.id}
                onClick={() => void missions.selectMission(m.id)}
                className={`mb-1 w-full rounded-lg px-3 py-2.5 text-left transition-colors ${missions.active?.id === m.id ? 'bg-surface-active' : 'hover:bg-surface-active/50'}`}
              >
                <div className="line-clamp-2 text-[12.5px] font-medium text-text">{m.text}</div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  <Badge tone={CATEGORY_TONE[m.category]}>{CATEGORY_LABEL[m.category]}</Badge>
                  <Badge tone={m.execution?.status === 'completed' ? 'positive' : m.execution?.status === 'failed' ? 'critical' : m.execution?.status === 'running' || m.execution?.status === 'approved' ? 'info' : 'neutral'}>
                    {execLabel}
                  </Badge>
                  {m.qualityOverall != null && <span className="text-[10.5px] text-text-subtle">Q{Math.round(m.qualityOverall * 100)}</span>}
                  <span className="text-[10.5px] text-text-subtle">{m.taskCount} tasks · {relTime(m.createdAt)}</span>
                </div>
                {progress != null && (
                  <div className="mt-1.5 flex items-center gap-2">
                    <div className="h-1 flex-1 overflow-hidden rounded-full bg-surface-active">
                      <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${progress}%` }} />
                    </div>
                    <span className="w-9 text-right text-[10px] tabular-nums text-text-subtle">{progress}%</span>
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {creating ? (
          <CreationProgress stage={missions.creation.stage} classification={missions.creation.classification} strategy={missions.creation.strategy} />
        ) : missions.active ? (
          <MissionDetail projectPath={project.path} missions={missions} />
        ) : (
          <div className="grid h-full place-items-center p-10">
            <EmptyState
              icon="deploy"
              title="Describe a real goal to get started"
              description={`Try something concrete, e.g. "${EXAMPLE_MISSION}" — AURA grounds the plan in this project's real health score, architecture, and change hotspots.`}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function FilterChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full px-2 py-0.5 text-[10.5px] font-medium transition-colors ${active ? 'bg-accent/15 text-accent' : 'bg-surface-active text-text-muted hover:text-text'}`}
    >
      {label}
    </button>
  );
}
