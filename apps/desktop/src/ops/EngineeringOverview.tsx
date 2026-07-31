/**
 * EngineeringOverview — the engineering landing page (Part 7).
 * ------------------------------------------------------------------
 * A single pane of truth for the whole operating environment: project
 * health, mission totals, pending reviews, the engineering feed, the
 * live risk/category picture, technical debt and architecture health.
 * Every number is derived from public engine APIs (mission dashboard,
 * health, diagnoses, the knowledge fabric) — nothing is fabricated.
 *
 * `variant="screen"` renders the full landing with a section header;
 * `variant="panel"` renders a compact version for the workspace panel
 * (ops/panels/OverviewPanel). Either way the same hook feeds both.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Icon } from '@aura/ui';
import type { IconName } from '@aura/ui';
import { Badge } from '@aura/ui';
import { cn } from '@aura/core';
import { missionClient, type MissionDashboard, type MissionSummary } from '../ai/missionClient';
import { diagnosisClient } from '../ai/diagnosisClient';
import { aiClient, type HealthResult, type IndexStatus } from '../ai/aiClient';
import { useWorkspace } from '../data/useWorkspace';
import { CATEGORY_LABEL, EXECUTION_STATUS_TONE, relTime } from '../screens/missions/missionMeta';
import { Meter, StatTile } from '../screens/project/components/kit';
import { useLayoutStore } from './layoutStore';

interface OverviewData {
  loading: boolean;
  totals: MissionDashboard['totals'] | null;
  tasks: MissionDashboard['tasks'] | null;
  byCategory: MissionDashboard['byCategory'];
  risk: MissionDashboard['riskDistribution'];
  recent: MissionSummary[];
  health: HealthResult['health'] | null;
  index: IndexStatus | null;
  pendingDiagnoses: number;
  signals: {
    verification: number | null;
    debtMarkers: number;
    architectureLayers: number;
    healthOverall: number | null;
  } | null;
  fabric: { nodes: number; edges: number } | null;
}

function useOverviewData(): OverviewData {
  const openId = useWorkspace((s) => s.openId);
  const kg = useWorkspace((s) => s.kg);
  const [data, setData] = useState<OverviewData>({
    loading: true,
    totals: null,
    tasks: null,
    byCategory: [],
    risk: { low: 0, medium: 0, high: 0 },
    recent: [],
    health: null,
    index: null,
    pendingDiagnoses: 0,
    signals: null,
    fabric: null,
  });

  useEffect(() => {
    let alive = true;
    const load = async () => {
      let totals: MissionDashboard['totals'] | null = null;
      let tasks: MissionDashboard['tasks'] | null = null;
      let byCategory: MissionDashboard['byCategory'] = [];
      let risk: MissionDashboard['riskDistribution'] = { low: 0, medium: 0, high: 0 };
      let recent: MissionSummary[] = [];
      let health: HealthResult['health'] | null = null;
      let index: IndexStatus | null = null;
      let pendingDiagnoses = 0;
      let signals: OverviewData['signals'] = null;

      try {
        const dash = await missionClient.dashboard();
        totals = dash.totals;
        tasks = dash.tasks;
        byCategory = dash.byCategory;
        risk = dash.riskDistribution;
        recent = dash.recent;
      } catch {
        /* dashboard unavailable */
      }
      try {
        const h = await aiClient.health();
        health = h.health;
        index = h.index ?? null;
      } catch {
        /* health unavailable */
      }

      const projects = useWorkspace.getState().projects;
      for (const project of projects.slice(0, 3)) {
        try {
          const res = await diagnosisClient.list(project.id);
          pendingDiagnoses += res.diagnoses.filter((d) => d.decision.status === 'pending').length;
        } catch {
          /* skip */
        }
      }

      // Real project signals (health, debt, layers, verification) from the
      // most recent mission of the open project — public API only.
      const pid = openId ?? projects[0]?.id ?? null;
      if (pid) {
        try {
          const res = await missionClient.list(pid);
          const latest = res.missions[res.missions.length - 1];
          if (latest) {
            const rec = await missionClient.get(pid, latest.id);
            if (!('error' in rec) && rec.signals) {
              signals = {
                verification: rec.signals.verificationScore ?? null,
                debtMarkers: rec.signals.technicalDebt.length,
                architectureLayers: rec.signals.architectureLayers.length,
                healthOverall: rec.signals.health?.overall ?? null,
              };
            }
          }
        } catch {
          /* skip */
        }
      }

      if (alive) {
        setData({
          loading: false,
          totals,
          tasks,
          byCategory,
          risk,
          recent,
          health,
          index,
          pendingDiagnoses,
          signals,
          fabric: kg ? { nodes: kg.nodes.length, edges: kg.edges.length } : null,
        });
      }
    };
    void load();
    const id = window.setInterval(() => void load(), 20000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [openId, kg]);

  return data;
}

export function EngineeringOverview({ variant = 'screen' }: { variant?: 'screen' | 'panel' }) {
  const d = useOverviewData();
  const openPanel = useLayoutStore((s) => s.openPanel);

  const healthTone = d.health == null ? 'neutral' : d.health.ok ? 'positive' : 'critical';
  const active = d.totals?.active ?? 0;
  const reviewing = d.totals?.reviewing ?? 0;
  const completed = d.totals?.completed ?? 0;
  const failed = d.totals?.failed ?? 0;
  const debt = d.signals?.debtMarkers ?? 0;

  const riskTotal = d.risk.low + d.risk.medium + d.risk.high || 1;

  const headline = useMemo(() => {
    const health = d.signals?.healthOverall ?? 0;
    if (d.health == null) return 'Engine offline';
    if (failed > 0) return 'Attention needed';
    if (reviewing > 0) return 'Reviews waiting';
    if (active > 0) return 'Missions in flight';
    if (health >= 70) return 'Environment healthy';
    if (d.signals) return 'Watch the signals';
    return 'Ready';
  }, [d.health, d.signals, active, reviewing, failed]);

  return (
    <div className={variant === 'screen' ? 'mx-auto w-full max-w-[1360px] px-6 py-7 sm:px-10' : 'flex h-full min-h-0 flex-col'}>
      {/* header */}
      <div className={cn('mb-5 flex items-end justify-between gap-4', variant === 'panel' && 'px-3 pt-3')}>
        <div>
          <div className="flex items-center gap-2">
            <h2 className={cn('font-semibold tracking-[-0.01em] text-text', variant === 'screen' ? 'text-[19px]' : 'text-[13px]')}>
              Engineering Overview
            </h2>
            {d.loading && <span className="h-3 w-3 animate-spin rounded-full border border-accent border-t-transparent" />}
          </div>
          <p className="mt-1 text-[12.5px] text-text-muted">
            {headline} — {d.totals ? `${d.totals.missions} missions across ${d.totals.projects} projects` : 'no mission data yet'}.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone={healthTone} dot>
            {d.health == null ? 'Backend offline' : `Runtime ${d.health.ok ? 'ready' : 'degraded'}`}
          </Badge>
          <button
            onClick={() => openPanel('missions')}
            className="hidden items-center gap-1 rounded-lg bg-accent px-3 py-1.5 text-[11.5px] font-medium text-white transition-colors hover:bg-accent-600 sm:inline-flex"
          >
            <Icon name="deploy" size={13} /> Open Mission Control
          </button>
        </div>
      </div>

      {/* KPI tiles */}
      <div className={cn('grid gap-2.5 grid-cols-2 sm:grid-cols-3 xl:grid-cols-6')}>
        <StatTile icon="activity" label="Active missions" value={active} sub={reviewing ? `${reviewing} in review` : undefined} tone="info" />
        <StatTile icon="eye" label="Pending reviews" value={reviewing} tone="attention" />
        <StatTile icon="check" label="Completed" value={completed} tone="positive" />
        <StatTile icon="bug" label="Failed missions" value={failed} tone={failed ? 'critical' : 'neutral'} />
        <StatTile icon="bug" label="Diagnoses pending" value={d.pendingDiagnoses} tone={d.pendingDiagnoses ? 'attention' : 'neutral'} />
        <StatTile icon="note" label="Debt markers" value={debt} sub={d.signals?.verification != null ? `verification ${Math.round(d.signals.verification)}%` : undefined} tone={debt ? 'attention' : 'neutral'} />
      </div>

      <div className={cn('mt-2.5 grid gap-2.5 grid-cols-1 lg:grid-cols-3')}>
        {/* left: health + architecture */}
        <div className="space-y-2.5">
          <OverviewCard icon="cpu" title="Runtime & index" tone={healthTone}>
            <div className="space-y-2.5">
              <MetricRow label="Backend" value={d.health == null ? 'offline' : d.health.ok ? `ok · ${d.health.latencyMs}ms` : 'degraded'} tone={healthTone} />
              <MetricRow
                label="Index"
                value={d.index ? (d.index.phase === 'ready' ? `ready · ${d.index.coding.chunks} chunks` : d.index.phase === 'indexing' ? `indexing · ${d.index.coding.processed}/${d.index.coding.total}` : d.index.phase) : 'unknown'}
                tone={d.index?.phase === 'ready' ? 'positive' : d.index?.phase === 'indexing' ? 'attention' : 'neutral'}
              />
              <MetricRow label="Knowledge fabric" value={d.fabric ? `${d.fabric.nodes} nodes · ${d.fabric.edges} edges` : 'unavailable'} tone={d.fabric ? 'info' : 'neutral'} />
              {d.signals?.healthOverall != null && <Meter label="Project health" value={d.signals.healthOverall} tone={d.signals.healthOverall >= 70 ? 'positive' : 'attention'} />}
            </div>
          </OverviewCard>
          <OverviewCard icon="architecture" title="Architecture" tone={d.signals ? 'info' : 'neutral'}>
            <div className="space-y-2.5">
              <MetricRow label="Layers mapped" value={d.signals?.architectureLayers ?? 0} tone={d.signals?.architectureLayers ? 'positive' : 'neutral'} />
              <MetricRow label="Verification score" value={d.signals?.verification != null ? `${Math.round(d.signals.verification)}%` : 'n/a'} tone={d.signals?.verification != null && d.signals.verification >= 70 ? 'positive' : 'attention'} />
              <div className="flex flex-wrap gap-1">
                {d.byCategory.slice(0, 6).map((c) => (
                  <Badge key={c.category} tone="info">{CATEGORY_LABEL[c.category]}: {c.count}</Badge>
                ))}
              </div>
            </div>
          </OverviewCard>
        </div>

        {/* middle: mission flow + risk */}
        <div className="space-y-2.5">
          <OverviewCard icon="deploy" title="Mission flow" tone="info">
            {d.tasks ? (
              <div className="space-y-2.5">
                <Meter label="Task completion" value={d.tasks.completion} tone={d.tasks.completion >= 70 ? 'positive' : 'info'} />
                <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                  <MetricRow label="Completed" value={d.tasks.completed} tone="positive" />
                  <MetricRow label="Running" value={d.tasks.running} tone="info" />
                  <MetricRow label="In review" value={d.tasks.review} tone="attention" />
                  <MetricRow label="Blocked / failed" value={`${d.tasks.blocked} / ${d.tasks.failed}`} tone={d.tasks.failed || d.tasks.blocked ? 'critical' : 'neutral'} />
                </div>
              </div>
            ) : (
              <p className="text-[12px] text-text-muted">No execution data yet.</p>
            )}
          </OverviewCard>
          <OverviewCard icon="shield" title="Risk distribution" tone="neutral">
            <div className="space-y-2.5">
              <RiskBar label="Low" pct={d.risk.low / riskTotal} tone="positive" />
              <RiskBar label="Medium" pct={d.risk.medium / riskTotal} tone="attention" />
              <RiskBar label="High" pct={d.risk.high / riskTotal} tone="critical" />
            </div>
          </OverviewCard>
        </div>

        {/* right: recent missions / feed */}
        <div className="space-y-2.5">
          <OverviewCard icon="activity" title="Engineering feed" tone="info">
            <div className="space-y-1">
              {d.recent.length === 0 && <p className="text-[12px] text-text-muted">No recent activity.</p>}
              {d.recent.slice(0, 5).map((m) => (
                <button
                  key={m.id}
                  onClick={() => {
                    useLayoutStore.getState().setFocused({ projectId: m.projectId, missionId: m.id });
                    openPanel('mission-detail');
                  }}
                  className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-surface-hover"
                >
                  <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md bg-surface-active text-text-muted">
                    <Icon name="deploy" size={12} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] font-medium text-text">{m.text}</span>
                    <span className="block text-[10px] text-text-subtle">{relTime(m.createdAt)}</span>
                  </span>
                  <Badge tone={EXECUTION_STATUS_TONE[m.execution?.status ?? 'idle']}>{m.execution?.status ?? 'plan'}</Badge>
                </button>
              ))}
            </div>
          </OverviewCard>
        </div>
      </div>
    </div>
  );
}

function OverviewCard({ icon, title, tone, children }: { icon: IconName; title: string; tone: 'positive' | 'attention' | 'critical' | 'info' | 'neutral'; children: ReactNode }) {
  const iconColor = {
    positive: 'text-positive',
    attention: 'text-attention',
    critical: 'text-danger',
    info: 'text-accent',
    neutral: 'text-text-subtle',
  }[tone];
  return (
    <div className="rounded-2xl border border-line bg-surface p-3.5">
      <div className="mb-3 flex items-center gap-2">
        <span className={cn('grid h-7 w-7 place-items-center rounded-lg bg-surface-active', iconColor)}>
          <Icon name={icon} size={15} />
        </span>
        <span className="text-[12.5px] font-semibold text-text">{title}</span>
      </div>
      {children}
    </div>
  );
}

function MetricRow({ label, value, tone }: { label: string; value: ReactNode; tone: 'positive' | 'attention' | 'critical' | 'info' | 'neutral' }) {
  const color = {
    positive: 'text-positive',
    attention: 'text-attention',
    critical: 'text-danger',
    info: 'text-accent',
    neutral: 'text-text-muted',
  }[tone];
  return (
    <div className="flex items-center justify-between text-[12px]">
      <span className="text-text-muted">{label}</span>
      <span className={cn('font-medium tabular-nums', color)}>{value}</span>
    </div>
  );
}

function RiskBar({ label, pct, tone }: { label: string; pct: number; tone: 'positive' | 'attention' | 'critical' }) {
  const color = { positive: 'bg-positive', attention: 'bg-attention', critical: 'bg-danger' }[tone];
  return (
    <div className="flex items-center gap-2.5">
      <span className="w-12 shrink-0 text-[11px] text-text-muted">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-active">
        <div className={cn('h-full rounded-full', color)} style={{ width: `${Math.round(pct * 100)}%` }} />
      </div>
      <span className="w-8 shrink-0 text-right text-[11px] tabular-nums text-text-subtle">{Math.round(pct * 100)}%</span>
    </div>
  );
}
