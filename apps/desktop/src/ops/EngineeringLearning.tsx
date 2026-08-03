/**
 * EngineeringLearning — the Engineering Learning panel.
 * ==================================================================
 * The consumer of the Learning Engine (ops/learningEngine.ts). Renders
 * the patterns, risk predictions, recommendations, trend charts and
 * the engineering health score — every number derived deterministically
 * from real Engineering Memory records. No placeholders, no fake data:
 * empty states read as "still learning".
 *
 * `variant="screen"` renders the full landing; `variant="panel"`
 * renders the compact workspace-panel form.
 */
import { useMemo, useState } from 'react';
import { Badge, Button, Icon } from '@aura/ui';
import type { IconName } from '@aura/ui';
import { cn } from '@aura/core';
import { useWorkspace } from '../data/useWorkspace';
import { relTime } from '../screens/missions/missionMeta';
import { useLayoutStore } from './layoutStore';
import { useMemoryStore } from './memoryStore';
import {
  useLearningEngine,
  type LearningPattern,
  type LearningPrediction,
  type LearningTone,
  type LearningTrend,
  type PatternKind,
  type PredictionKind,
} from './learningEngine';

type LearningView = 'patterns' | 'predictions' | 'trends' | 'health';

const VIEWS: { key: LearningView; label: string; icon: IconName }[] = [
  { key: 'patterns', label: 'Patterns', icon: 'research' },
  { key: 'predictions', label: 'Predictions', icon: 'activity' },
  { key: 'trends', label: 'Trends', icon: 'activity' },
  { key: 'health', label: 'Health', icon: 'shield' },
];

const PATTERN_ICON: Record<PatternKind, IconName> = {
  'repeated-bug': 'bug',
  'hot-module': 'code',
  'unstable-module': 'activity',
  'reliable-module': 'shield',
  'ai-rejection': 'eye-off',
  'architecture-hotspot': 'architecture',
  'mission-bottleneck': 'deploy',
  'workflow-habit': 'research',
};

const PREDICTION_ICON: Record<PredictionKind, IconName> = {
  'file-break': 'bug',
  refactor: 'code',
  'debt-growth': 'clipboard',
  'architecture-risk': 'architecture',
  'dependency-churn': 'link',
  regression: 'refresh',
};

const RISK_TONE: Record<LearningPrediction['risk'], LearningTone> = {
  low: 'neutral',
  medium: 'attention',
  high: 'critical',
};

function iconTone(tone: LearningTone): string {
  return {
    positive: 'text-positive',
    attention: 'text-attention',
    critical: 'text-danger',
    info: 'text-accent',
    neutral: 'text-text-muted',
  }[tone];
}

export function EngineeringLearning({ variant = 'screen' }: { variant?: 'screen' | 'panel' }) {
  const openId = useWorkspace((s) => s.openId);
  const analysis = useLearningEngine(openId);
  const openPanel = useLayoutStore((s) => s.openPanel);
  const selectMemory = useMemoryStore((s) => s.select);
  const [view, setView] = useState<LearningView>('patterns');

  const openMemory = (id: string) => {
    selectMemory(id);
    openPanel('engineering-memory');
  };

  const recommendations = useMemo(
    () => analysis.predictions.slice(0, 3).map((p) => ({ pred: p, action: p.actions[0] ?? '' })),
    [analysis.predictions],
  );

  return (
    <div className={cn('flex min-h-0 flex-col', variant === 'screen' ? 'mx-auto w-full max-w-[1360px] px-6 py-7 sm:px-10' : '')}>
      {/* header */}
      <div className={cn('flex flex-wrap items-end justify-between gap-3', variant === 'screen' ? 'mb-5' : 'px-3 pt-3')}>
        <div>
          <div className="flex items-center gap-2">
            <h2 className={cn('font-semibold tracking-[-0.01em] text-text', variant === 'screen' ? 'text-[19px]' : 'text-[13px]')}>
              Engineering Learning
            </h2>
            <Badge tone={analysis.health.insufficient ? 'neutral' : toneOfScoreBadge(analysis.health.overall)}>
              {analysis.records} records
            </Badge>
          </div>
          <p className="mt-1 text-[12.5px] text-text-muted">
            {analysis.health.insufficient
              ? `Collecting engineering history — health and predictions become meaningful at 5+ records (currently ${analysis.records}).`
              : `Health ${analysis.health.overall}/100 · ${analysis.patterns.length} patterns · ${analysis.predictions.length} predictions · learned from ${analysis.health.sampledRangeDays} days of real events.`}
          </p>
        </div>
        {variant === 'screen' && (
          <Button size="sm" variant="secondary" icon="memory" onClick={() => openPanel('engineering-memory')}>
            Open Memory
          </Button>
        )}
      </div>

      {/* view tabs */}
      <div className={cn('flex gap-1', variant === 'screen' ? 'mb-4' : 'px-3 pb-2')}>
        {VIEWS.map((v) => (
          <button
            key={v.key}
            onClick={() => setView(v.key)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] font-medium transition-colors',
              view === v.key ? 'bg-accent-50 text-accent-700 dark:bg-accent/15 dark:text-accent-200' : 'text-text-muted hover:bg-surface-hover hover:text-text',
            )}
          >
            <Icon name={v.icon} size={13} />
            {v.label}
            {v.key === 'patterns' && analysis.patterns.length > 0 && <Badge tone="info">{analysis.patterns.length}</Badge>}
            {v.key === 'predictions' && analysis.predictions.length > 0 && <Badge tone="info">{analysis.predictions.length}</Badge>}
          </button>
        ))}
      </div>

      <div className="space-y-3">
        {view === 'patterns' && (
          <PatternsView
            patterns={analysis.patterns}
            records={analysis.records}
            recommendations={recommendations.map((r) => r.action)}
            onOpenMemory={openMemory}
          />
        )}
        {view === 'predictions' && (
          <PredictionsView predictions={analysis.predictions} onRunDiagnosis={() => openPanel('diagnostics')} />
        )}
        {view === 'trends' && <TrendsView trends={analysis.trends} />}
        {view === 'health' && <HealthView analysis={analysis} />}
      </div>
    </div>
  );
}

function toneOfScoreBadge(score: number): LearningTone {
  if (score >= 75) return 'positive';
  if (score >= 55) return 'info';
  if (score >= 40) return 'attention';
  return 'critical';
}

/* ── Patterns ─────────────────────────────────────────────────────── */

function PatternsView({ patterns, records, recommendations, onOpenMemory }: {
  patterns: LearningPattern[];
  records: number;
  recommendations: string[];
  onOpenMemory: (id: string) => void;
}) {
  if (records === 0) {
    return <EmptyState icon="research" title="Nothing learned yet" detail="The Learning Engine discovers patterns from real engineering events — missions, diagnoses, AI actions, code saves. Open a project and let the platform record history." />;
  }
  return (
    <div className="grid gap-2.5 lg:grid-cols-2">
      {recommendations.length > 0 && (
        <div className="rounded-2xl border border-line bg-surface p-3.5 lg:col-span-2">
          <div className="mb-2 flex items-center gap-2">
            <span className="grid h-6 w-6 place-items-center rounded-lg bg-surface-active text-accent"><Icon name="clipboard" size={13} /></span>
            <span className="text-[12.5px] font-semibold text-text">Recommendations</span>
          </div>
          <ul className="space-y-1.5">
            {recommendations.map((r, i) => (
              <li key={i} className="flex items-start gap-2 text-[12px] text-text-muted">
                <Icon name="arrow-right" size={12} className="mt-0.5 shrink-0 text-accent" />
                <span>{r}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {patterns.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-line p-6 text-center text-[12.5px] text-text-subtle lg:col-span-2">
          Patterns emerge once real events repeat (diagnoses, edits, AI accept/reject decisions).
        </p>
      ) : (
        patterns.map((p) => (
          <PatternCard key={p.id} pattern={p} onOpenMemory={onOpenMemory} />
        ))
      )}
    </div>
  );
}

function PatternCard({ pattern, onOpenMemory }: { pattern: LearningPattern; onOpenMemory: (id: string) => void }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-3.5">
      <div className="flex items-start gap-2.5">
        <span className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-surface-active', iconTone(pattern.tone))}>
          <Icon name={PATTERN_ICON[pattern.kind]} size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[12.5px] font-semibold text-text">{pattern.title}</span>
            <Badge tone={pattern.tone}>{pattern.count}</Badge>
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-text-muted">{pattern.detail}</p>
          {pattern.evidence.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {pattern.evidence.map((e) => (
                <button
                  key={e.memoryId}
                  onClick={() => onOpenMemory(e.memoryId)}
                  className="inline-flex max-w-full items-center gap-1 rounded-md bg-surface-active px-2 py-0.5 text-[10.5px] text-text-subtle transition-colors hover:text-accent"
                  title={e.title}
                >
                  <Icon name="link" size={10} />
                  <span className="truncate">{e.file ?? e.title}</span>
                  <span className="shrink-0 text-text-muted/60">{relTime(e.at)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Predictions ───────────────────────────────────────────────────── */

function PredictionsView({ predictions, onRunDiagnosis }: {
  predictions: LearningPrediction[];
  onRunDiagnosis: () => void;
}) {
  if (predictions.length === 0) {
    return <EmptyState icon="activity" title="No predictions yet" detail="Predictions need evidence: diagnoses, failures, rejected AI proposals and file churn. They become available as engineering history accumulates." />;
  }
  return (
    <div className="grid gap-2.5 lg:grid-cols-2">
      {predictions.map((p) => (
        <div key={p.id} className="rounded-2xl border border-line bg-surface p-3.5">
          <div className="flex items-start gap-2.5">
            <span className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-surface-active', iconTone(RISK_TONE[p.risk]))}>
              <Icon name={PREDICTION_ICON[p.kind]} size={15} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[12.5px] font-semibold text-text">{p.target}</span>
                <Badge tone={RISK_TONE[p.risk]}>{p.risk} risk</Badge>
                <span className="text-[10.5px] tabular-nums text-text-subtle">{p.confidence}% confidence</span>
              </div>
              <p className="mt-1 text-[12px] leading-relaxed text-text-muted">{p.detail}</p>
              <div className="mt-2.5">
                <ConfidenceBar confidence={p.confidence} tone={RISK_TONE[p.risk]} />
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {p.actions.map((a, i) => (
                  <span key={i} className="inline-flex items-center gap-1 rounded-md bg-surface-active px-2 py-0.5 text-[10.5px] text-text-subtle">
                    <Icon name={i === 0 ? 'bug' : 'arrow-right'} size={10} />
                    {a}
                  </span>
                ))}
                <button
                  onClick={onRunDiagnosis}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10.5px] font-medium text-accent transition-colors hover:text-accent-600"
                >
                  Run a diagnosis
                </button>
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function ConfidenceBar({ confidence, tone }: { confidence: number; tone: LearningTone }) {
  const color = { positive: 'bg-positive', attention: 'bg-attention', critical: 'bg-danger', info: 'bg-accent', neutral: 'bg-text-muted' }[tone];
  return (
    <div className="flex items-center gap-2">
      <span className="w-16 shrink-0 text-[10px] text-text-subtle">confidence</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-active">
        <div className={cn('h-full rounded-full', color)} style={{ width: `${confidence}%` }} />
      </div>
      <span className="w-9 shrink-0 text-right text-[10.5px] tabular-nums text-text-subtle">{confidence}%</span>
    </div>
  );
}

/* ── Trends ────────────────────────────────────────────────────────── */

function TrendsView({ trends }: { trends: LearningTrend[] }) {
  if (trends.length === 0) {
    return <EmptyState icon="activity" title="No trends yet" detail="Trend lines need time-series data. They plot daily activity, diagnosis rate, AI acceptance, mission failures and knowledge growth." />;
  }
  return (
    <div className="grid gap-2.5 lg:grid-cols-2">
      {trends.map((t) => (
        <TrendCard key={t.key} trend={t} />
      ))}
    </div>
  );
}

function TrendCard({ trend }: { trend: LearningTrend }) {
  const values = trend.points.map((p) => p.value);
  const max = Math.max(...values, 1);
  const w = 260;
  const h = 56;
  const step = values.length > 1 ? w / (values.length - 1) : w;
  const pts = values
    .map((v, i) => `${(i * step).toFixed(1)},${(h - 4 - (v / max) * (h - 10)).toFixed(1)}`)
    .join(' ');
  const area = pts ? `0,${h - 2} ${pts} ${w},${h - 2}` : '';
  const toneColor = {
    positive: 'var(--positive)',
    attention: 'var(--attention)',
    critical: 'var(--danger)',
    info: 'var(--accent-600)',
    neutral: 'var(--text-muted)',
  }[trend.tone];

  return (
    <div className="rounded-2xl border border-line bg-surface p-3.5">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[12.5px] font-semibold text-text">{trend.label}</span>
        <span className={cn('inline-flex items-center gap-1 text-[11px] font-medium', iconTone(trend.tone))}>
          <Icon name={trend.direction === 'up' ? 'arrow-right' : trend.direction === 'down' ? 'arrow-right' : 'dot'} size={11} className={trend.direction === 'down' ? 'rotate-90' : trend.direction === 'up' ? '-rotate-90' : ''} />
          {trend.direction === 'flat' ? 'stable' : trend.direction} · {trend.delta > 0 ? '+' : ''}{trend.delta}%{trend.unit}
        </span>
      </div>
      {values.length > 1 ? (
        <svg viewBox={`0 0 ${w} ${h}`} className="w-full" preserveAspectRatio="none">
          {area && <polygon points={area} fill={toneColor} opacity={0.08} />}
          <polyline points={pts} fill="none" stroke={toneColor} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <p className="py-6 text-center text-[11.5px] text-text-subtle">Collecting data — needs at least two days.</p>
      )}
      <div className="mt-1 flex justify-between text-[9.5px] text-text-muted/70">
        <span>{trend.points[0]?.label}</span>
        <span>{trend.points[trend.points.length - 1]?.label}</span>
      </div>
    </div>
  );
}

/* ── Health ────────────────────────────────────────────────────────── */

function HealthView({ analysis }: { analysis: ReturnType<typeof useLearningEngine> }) {
  const { health } = analysis;
  return (
    <div className="grid gap-2.5 lg:grid-cols-3">
      <div className="rounded-2xl border border-line bg-surface p-4 lg:col-span-1">
        <div className="flex items-center gap-3">
          <HealthRing score={health.overall} />
          <div>
            <div className="text-[13px] font-semibold text-text">Engineering Health</div>
            <p className="mt-0.5 text-[11.5px] text-text-muted">
              {health.insufficient
                ? `Only ${health.sampledRecords} records so far — score is provisional.`
                : `Scored from ${health.sampledRecords} real records over ~${health.sampledRangeDays} day(s).`}
            </p>
          </div>
        </div>
      </div>
      <div className="space-y-2.5 lg:col-span-2">
        {health.components.map((c) => (
          <div key={c.key} className="rounded-2xl border border-line bg-surface p-3.5">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[12px] font-medium text-text">{c.label}</span>
              <span className={cn('text-[12px] font-semibold tabular-nums', iconTone(c.tone))}>{c.score}</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-surface-active">
              <div
                className={cn('h-full rounded-full transition-all', c.tone === 'positive' ? 'bg-positive' : c.tone === 'attention' ? 'bg-attention' : c.tone === 'critical' ? 'bg-danger' : c.tone === 'info' ? 'bg-accent' : 'bg-text-muted')}
                style={{ width: `${c.score}%` }}
              />
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-text-muted">{c.detail}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function HealthRing({ score }: { score: number }) {
  const r = 30;
  const c = 2 * Math.PI * r;
  const filled = (score / 100) * c;
  const tone = toneOfScoreBadge(score);
  const color = tone === 'positive' ? 'var(--positive)' : tone === 'attention' ? 'var(--attention)' : tone === 'critical' ? 'var(--danger)' : 'var(--accent-600)';
  return (
    <div className="relative grid h-[76px] w-[76px] shrink-0 place-items-center">
      <svg viewBox="0 0 76 76" className="h-full w-full -rotate-90">
        <circle cx="38" cy="38" r={r} fill="none" stroke="var(--surface-active)" strokeWidth={6} />
        <circle cx="38" cy="38" r={r} fill="none" stroke={color} strokeWidth={6} strokeLinecap="round" strokeDasharray={`${filled} ${c}`} />
      </svg>
      <span className="absolute text-[20px] font-semibold tabular-nums text-text">{score}</span>
    </div>
  );
}

/* ── shared ────────────────────────────────────────────────────────── */

function EmptyState({ icon, title, detail }: { icon: IconName; title: string; detail: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-line p-8 text-center">
      <span className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-xl bg-surface-active text-text-muted">
        <Icon name={icon} size={18} />
      </span>
      <div className="text-[13px] font-semibold text-text">{title}</div>
      <p className="mx-auto mt-1 max-w-md text-[12px] leading-relaxed text-text-muted">{detail}</p>
    </div>
  );
}

