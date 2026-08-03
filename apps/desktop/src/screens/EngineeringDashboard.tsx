/**
 * EngineeringDashboard — the global mission/execution control plane.
 * ------------------------------------------------------------------
 * A read-only aggregate of real engine state across every project:
 * mission totals by execution status, task flow (running / review /
 * blocked / failed), risk distribution, category mix, and the most
 * recent missions — each row showing live DAG-derived progress.
 *
 * This screen intentionally does not invent data: every number comes
 * from the engine's `missionDashboard` aggregate, and "Open" drops you
 * into that mission's project with Mission Control selected.
 */
import { useEffect, useState } from 'react';
import { Badge, Button, Icon } from '@aura/ui';
import { useAppStore } from '@aura/core';
import { useWorkspace } from '../data/useWorkspace';
import { useLayoutStore } from '../ops/layoutStore';
import { missionClient, type MissionDashboard } from '../ai/missionClient';
import { EmptyState } from '../components/EmptyState';
import { CATEGORY_LABEL, CATEGORY_TONE, EXECUTION_STATUS_LABEL, EXECUTION_STATUS_TONE, relTime } from './missions/missionMeta';

export function EngineeringDashboard() {
  const setNav = useAppStore((s) => s.setNav);
  const openPanel = useLayoutStore((s) => s.openPanel);
  const projects = useWorkspace((s) => s.projects);
  const [data, setData] = useState<MissionDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await missionClient.dashboard());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); }, []);

  const openMission = (projectId: string) => {
    const w = useWorkspace.getState();
    void w.open(projectId).then(() => { setNav('workspace'); openPanel('missions'); });
  };

  if (error && !data) {
    return (
      <div className="mx-auto max-w-[1080px] px-8 py-10">
        <EmptyState icon="activity" title="Engineering dashboard unavailable" description={`${error}. Start the AI service to aggregate mission state.`} />
      </div>
    );
  }
  if (!data) {
    return (
      <div className="mx-auto max-w-[1080px] px-8 py-10">
        <div className="space-y-4">
          <div className="h-8 w-64 animate-pulse rounded-lg bg-surface-active" />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            {Array.from({ length: 5 }).map((_, i) => <div key={i} className="h-20 animate-pulse rounded-xl bg-surface-active" />)}
          </div>
        </div>
      </div>
    );
  }

  const t = data.totals;
  const tk = data.tasks;
  const hasActive = t.active > 0 || t.reviewing > 0 || tk.running > 0;

  return (
    <div className="mx-auto max-w-[1080px] space-y-5 px-8 py-8">
      {/* header */}
      <div className="flex flex-wrap items-center gap-3">
        <span className="grid h-10 w-10 place-items-center rounded-xl border border-line bg-canvas">
          <Icon name="activity" size={18} className="text-accent" />
        </span>
        <div className="mr-auto">
          <h1 className="text-[17px] font-semibold text-text">Engineering Dashboard</h1>
          <p className="text-[11.5px] text-text-muted">Every mission's execution state, across {t.projects} project{t.projects === 1 ? '' : 's'}.</p>
        </div>
        {hasActive && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-accent/10 px-2.5 py-1 text-[11px] font-medium text-accent">
            <span className="aura-live h-1.5 w-1.5 rounded-full bg-accent" /> live
          </span>
        )}
        <Button size="sm" variant="secondary" icon="refresh" loading={loading} onClick={() => void load()}>Refresh</Button>
      </div>

      {/* mission totals */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Stat label="Missions" value={t.missions} sub={`${t.planned} planned`} color="var(--text)" />
        <Stat label="Active" value={t.active} sub={`${t.approved} ready to run`} color="var(--accent)" />
        <Stat label="In review" value={t.reviewing} sub="awaiting human gate" color="var(--attention)" />
        <Stat label="Completed" value={t.completed} sub={`${Math.round(t.missions ? (t.completed / Math.max(1, t.planned + t.approved + t.active + t.reviewing + t.completed)) * 100 : 0)}% of started`} color="var(--positive)" />
        <Stat label="Failed / cancelled" value={t.failed + t.cancelled} sub={`${t.failed} failed`} color="var(--danger)" />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
        {/* task flow + risk */}
        <div className="space-y-4">
          <section className="rounded-xl border border-line bg-canvas p-4">
            <div className="flex items-center justify-between">
              <span className="text-[12px] font-semibold text-text">Task flow</span>
              <span className="text-[11px] tabular-nums text-text-subtle">{tk.completed}/{tk.total} done</span>
            </div>
            <div className="mt-3 flex h-2.5 w-full overflow-hidden rounded-full bg-surface-active">
              {tk.completed > 0 && <div className="h-full bg-positive" style={{ width: `${(tk.completed / Math.max(1, tk.total)) * 100}%` }} />}
              {tk.running > 0 && <div className="h-full bg-accent" style={{ width: `${(tk.running / Math.max(1, tk.total)) * 100}%` }} />}
              {tk.review > 0 && <div className="h-full bg-attention" style={{ width: `${(tk.review / Math.max(1, tk.total)) * 100}%` }} />}
              {tk.failed > 0 && <div className="h-full bg-danger" style={{ width: `${(tk.failed / Math.max(1, tk.total)) * 100}%` }} />}
            </div>
            <div className="mt-2.5 grid grid-cols-4 gap-2 text-center">
              <FlowStat label="running" value={tk.running} color="var(--accent)" />
              <FlowStat label="review" value={tk.review} color="var(--attention)" />
              <FlowStat label="blocked" value={tk.blocked} color="var(--danger)" />
              <FlowStat label="failed" value={tk.failed} color="var(--danger)" />
            </div>
            <div className="mt-3 flex items-center gap-3 border-t border-line pt-3 text-[11px] text-text-muted">
              <span>Completion</span>
              <div className="h-1 flex-1 overflow-hidden rounded-full bg-surface-active">
                <div className="h-full rounded-full bg-positive" style={{ width: `${Math.round(tk.completion * 100)}%` }} />
              </div>
              <span className="tabular-nums text-text">{Math.round(tk.completion * 100)}%</span>
            </div>
          </section>

          <section className="rounded-xl border border-line bg-canvas p-4">
            <span className="text-[12px] font-semibold text-text">Risk distribution</span>
            <div className="mt-3 space-y-2">
              {([['low', data.riskDistribution.low, 'var(--positive)'], ['medium', data.riskDistribution.medium, 'var(--attention)'], ['high', data.riskDistribution.high, 'var(--danger)']] as const).map(([k, n, color]) => {
                const total = data.riskDistribution.low + data.riskDistribution.medium + data.riskDistribution.high;
                return (
                  <div key={k} className="flex items-center gap-2">
                    <span className="w-14 text-[11px] capitalize text-text-muted">{k}</span>
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-active">
                      <div className="h-full rounded-full" style={{ width: `${total ? (n / total) * 100 : 0}%`, background: color }} />
                    </div>
                    <span className="w-6 text-right text-[11px] tabular-nums text-text-subtle">{n}</span>
                  </div>
                );
              })}
            </div>
          </section>
        </div>

        {/* category mix + recent */}
        <div className="space-y-4">
          <section className="rounded-xl border border-line bg-canvas p-4">
            <span className="text-[12px] font-semibold text-text">Mission mix by category</span>
            <div className="mt-3 space-y-2">
              {data.byCategory.length === 0 && <p className="text-[11.5px] text-text-subtle">No missions yet.</p>}
              {data.byCategory.slice(0, 8).map((c) => (
                <div key={c.category} className="flex items-center gap-2">
                  <span className="w-24 truncate text-[11px] text-text-muted">{CATEGORY_LABEL[c.category]}</span>
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-active">
                    <div className="h-full rounded-full bg-accent/70" style={{ width: `${data.byCategory[0] ? (c.count / data.byCategory[0].count) * 100 : 0}%` }} />
                  </div>
                  <span className="w-6 text-right text-[11px] tabular-nums text-text-subtle">{c.count}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-xl border border-line bg-canvas p-4">
            <div className="flex items-center justify-between">
              <span className="text-[12px] font-semibold text-text">Recent missions</span>
              <button onClick={() => { setNav('workspace'); openPanel('missions'); }} className="text-[11px] text-accent hover:underline">Mission Control →</button>
            </div>
            <div className="mt-2 space-y-1.5">
              {data.recent.length === 0 && <p className="text-[11.5px] text-text-subtle">No missions yet.</p>}
              {data.recent.map((m) => {
                const progress = m.execution?.metrics ? Math.round(m.execution.metrics.completion * 100) : null;
                const name = projects.find((p) => p.id === m.projectId)?.name ?? m.projectId;
                return (
                  <button key={m.id} onClick={() => openMission(m.projectId)} className="block w-full rounded-lg border border-line bg-surface px-3 py-2 text-left transition-colors hover:bg-surface-hover">
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-text">{m.text}</span>
                      <Badge tone={CATEGORY_TONE[m.category]}>{CATEGORY_LABEL[m.category]}</Badge>
                      <Badge tone={m.execution ? EXECUTION_STATUS_TONE[m.execution.status] : 'neutral'}>
                        {m.execution ? EXECUTION_STATUS_LABEL[m.execution.status] : m.approval.status}
                      </Badge>
                    </div>
                    <div className="mt-1 flex items-center gap-2">
                      <span className="truncate text-[10.5px] text-text-subtle">{name} · {m.taskCount} tasks · {relTime(m.createdAt)}</span>
                      {progress != null && (
                        <span className="ml-auto flex w-24 items-center gap-1.5">
                          <div className="h-1 flex-1 overflow-hidden rounded-full bg-surface-active">
                            <div className="h-full rounded-full bg-accent" style={{ width: `${progress}%` }} />
                          </div>
                          <span className="w-8 text-right text-[10px] tabular-nums text-text-subtle">{progress}%</span>
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </section>
        </div>
      </div>

      <p className="pb-2 text-[10.5px] text-text-subtle">
        Aggregate computed live from each mission's execution engine — DAG, metrics and replay. No synthetic state.
      </p>
    </div>
  );
}

function Stat({ label, value, sub, color }: { label: string; value: number; sub: string; color: string }) {
  return (
    <div className="rounded-xl border border-line bg-canvas p-3">
      <div className="text-[20px] font-semibold tabular-nums" style={{ color }}>{value}</div>
      <div className="text-[10.5px] font-medium text-text-muted">{label}</div>
      <div className="truncate text-[9.5px] text-text-subtle">{sub}</div>
    </div>
  );
}

function FlowStat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="rounded-lg border border-line px-2 py-1.5">
      <div className="text-[13px] font-semibold tabular-nums" style={{ color }}>{value}</div>
      <div className="text-[9px] uppercase tracking-wide text-text-subtle">{label}</div>
    </div>
  );
}
