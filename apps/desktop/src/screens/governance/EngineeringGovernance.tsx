/**
 * Engineering Governance Dashboard
 * ==================================================================
 * Real-time governance overview: health scorecard, top risks, recent
 * audit findings, and subsystem council reviews — every metric derived
 * from the actual workspace analysis via the Governance Platform.
 */

import { useEffect, useState } from 'react';
import { Badge, Button, Icon, Skeleton } from '@aura/ui';
import { governanceClient } from '../../ai/governanceClient';
import { useWorkspace } from '../../data/useWorkspace';
import { ErrorState } from '../../components/ErrorState';
import type { StatusTone } from '@aura/core';
import type {
  EngineeringScorecard,
  EngineeringAuditReport,
  ProjectInsightsReport,
  ArchitectureCouncilReport,
} from '@aura/governance';

function Stat({ label, value, sub, color }: { label: string; value: string | number; sub?: string; color?: string }) {
  return (
    <div className="rounded-xl border border-line bg-canvas p-4">
      <span className="text-[11px] font-semibold text-text-muted">{label}</span>
      <div className="mt-1 text-[18px] font-semibold text-text">{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-text-muted">{sub}</div>}
      {color && <div className="mt-2 h-1 w-8 rounded-full" style={{ backgroundColor: `var(--${color})` }} />}
    </div>
  );
}

function GradeBadge({ grade }: { grade: string }) {
  const tone: StatusTone = grade === 'A' ? 'positive' : grade === 'B' ? 'info' : grade === 'C' ? 'attention' : 'critical';
  return <Badge tone={tone}>{grade}</Badge>;
}

export function EngineeringGovernanceDashboard() {
  const { projects, openId } = useWorkspace();
  const projectPath = projects.find((p) => p.id === openId)?.path ?? null;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [scorecard, setScorecard] = useState<EngineeringScorecard | null>(null);
  const [audit, setAudit] = useState<EngineeringAuditReport | null>(null);
  const [insights, setInsights] = useState<ProjectInsightsReport | null>(null);
  const [council, setCouncil] = useState<ArchitectureCouncilReport | null>(null);

  const load = async () => {
    if (!projectPath) return;
    setLoading(true);
    setError(null);
    try {
      const [sc, au, in_, co] = await Promise.all([
        governanceClient.scorecard(projectPath),
        governanceClient.audit(projectPath, 'daily'),
        governanceClient.insights(projectPath),
        governanceClient.council(projectPath),
      ]);
      setScorecard(sc);
      setAudit(au);
      setInsights(in_);
      setCouncil(co);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [projectPath]);

  if (error) {
    return (
      <div className="mx-auto max-w-[1080px] px-8 py-10">
        <ErrorState
          icon="bug"
          title="Couldn't analyze the workspace"
          description={error}
          action={<Button size="sm" variant="secondary" icon="refresh" onClick={() => void load()}>Retry</Button>}
        />
      </div>
    );
  }

  if (loading || !scorecard) {
    return (
      <div className="mx-auto max-w-[1080px] space-y-5 px-8 py-8">
        <div className="flex items-center gap-3">
          <Skeleton variant="circle" className="h-10 w-10" />
          <Skeleton variant="line" className="w-56" />
        </div>
        <Skeleton className="h-24" />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
          {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-20" />)}
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1080px] space-y-5 px-8 py-8">
      {/* header */}
      <div className="flex flex-wrap items-center gap-3">
        <span className="grid h-10 w-10 place-items-center rounded-xl border border-line bg-canvas">
          <Icon name="shield" size={18} className="text-accent" />
        </span>
        <div className="mr-auto">
          <h1 className="text-[17px] font-semibold text-text">Engineering Governance</h1>
          <p className="text-[11.5px] text-text-muted">Real-time health, debt, security, docs, audits, insights, and council reviews.</p>
        </div>
        <Button size="sm" variant="secondary" icon="refresh" loading={loading} onClick={() => void load()}>Refresh</Button>
      </div>

      {/* Overall health */}
      <div className="rounded-xl border border-line bg-canvas p-4">
        <div className="flex items-center justify-between">
          <span className="text-[12px] font-semibold text-text">Overall Health</span>
          <GradeBadge grade={scorecard.overall.grade} />
        </div>
        <div className="mt-2 text-[24px] font-bold text-text">{scorecard.overall.value}/100</div>
        <p className="mt-1 text-[11px] text-text-muted">{scorecard.overall.explanation}</p>
      </div>

      {/* Dimension scores */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
        {scorecard.dimensions.map((d) => (
          <Stat key={d.dimension} label={d.dimension.replace('-', ' ')} value={d.score.value} sub={d.score.grade} color={d.score.grade === 'A' ? 'positive' : d.score.grade === 'B' ? 'accent' : d.score.grade === 'C' ? 'attention' : 'danger'} />
        ))}
      </div>

      {/* Top risks */}
      {audit && audit.topRisks.length > 0 && (
        <section className="rounded-xl border border-line bg-canvas p-4">
          <div className="flex items-center justify-between">
            <span className="text-[12px] font-semibold text-text">Top Risks ({audit.topRisks.length})</span>
          </div>
          <div className="mt-3 space-y-2">
            {audit.topRisks.slice(0, 5).map((r, i) => (
              <div key={i} className="flex items-start gap-2 text-[12px]">
                <span className="mt-0.5 text-text-muted">{i + 1}.</span>
                <span className="font-medium text-text">{r.title}</span>
                <span className="ml-auto text-text-muted">{r.source}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Subsystem council */}
      {council && (
        <section className="rounded-xl border border-line bg-canvas p-4">
          <div className="flex items-center justify-between">
            <span className="text-[12px] font-semibold text-text">Architecture Council</span>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-5">
            {council.reviews.map((r) => (
              <div key={r.subsystem} className="text-center">
                <div className="text-[11px] font-medium text-text">{r.subsystem}</div>
                <div className="text-[18px] font-bold text-text">{r.score.value}</div>
                <GradeBadge grade={r.score.grade} />
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Insights */}
      {insights && insights.insights.length > 0 && (
        <section className="rounded-xl border border-line bg-canvas p-4">
          <div className="flex items-center justify-between">
            <span className="text-[12px] font-semibold text-text">Insights</span>
          </div>
          <div className="mt-3 space-y-2">
            {insights.insights.slice(0, 5).map((i, idx) => (
              <div key={idx} className="flex items-start gap-2 text-[12px]">
                <span className="mt-0.5 text-text-muted">{idx + 1}.</span>
                <span className="text-text">{i.title}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      <p className="text-center text-[11px] text-text-muted">All data derived from real workspace analysis</p>
    </div>
  );
}
