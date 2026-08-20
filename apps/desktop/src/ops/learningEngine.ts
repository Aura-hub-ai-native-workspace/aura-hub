/**
 * learningEngine — the renderer's READER of the Learning Engine.
 * ==================================================================
 * The engine itself moved to `packages/ai-service/src/engineering/learning.ts`.
 * Its rules did not change — repeated bugs, hot and unstable modules,
 * AI-rejection hotspots, architecture hotspots, mission bottlenecks,
 * workflow habits, and the six deterministic predictions are the same
 * rules over the same evidence. What changed is WHERE they run.
 *
 * They had to move because the autonomous agent reasons over this
 * analysis, and the agent now runs in the service so that it survives the
 * window closing. Leaving a copy here would have meant two engines
 * deriving two answers from two stores — so this file keeps the types
 * (the wire contract, restated as every client type in this app is), the
 * React hook, and the chat-answer rendering, and fetches the analysis.
 */

import { useEffect, useState } from 'react';
import { subscribeToSpine } from '../events/spineClient';

const ENV = import.meta.env as unknown as Record<string, string | undefined>;
const BASE = ENV.VITE_AI_URL?.replace(/\/$/, '') ?? 'http://127.0.0.1:4319';

export type LearningTone = 'positive' | 'attention' | 'critical' | 'info' | 'neutral';

export interface LearningEvidence {
  memoryId: string;
  title: string;
  at: string;
  file?: string;
}

export type PatternKind =
  | 'repeated-bug'
  | 'hot-module'
  | 'unstable-module'
  | 'reliable-module'
  | 'ai-rejection'
  | 'architecture-hotspot'
  | 'mission-bottleneck'
  | 'workflow-habit';

export interface LearningPattern {
  id: string;
  kind: PatternKind;
  title: string;
  detail: string;
  count: number;
  tone: LearningTone;
  evidence: LearningEvidence[];
}

export type PredictionKind =
  | 'file-break'
  | 'refactor'
  | 'debt-growth'
  | 'architecture-risk'
  | 'dependency-churn'
  | 'regression';

export interface LearningPrediction {
  id: string;
  kind: PredictionKind;
  target: string;
  risk: 'low' | 'medium' | 'high';
  confidence: number;
  detail: string;
  evidenceCount: number;
  actions: string[];
}

export type InsightKind =
  | 'ai-acceptance'
  | 'diagnosis-rate'
  | 'mission-completion'
  | 'top-diagnosis-category'
  | 'activity-hour'
  | 'edit-velocity'
  | 'knowledge-count'
  | 'mission-failures'
  | 'rejected-proposals'
  | 'critical-events';

export interface LearningInsight {
  id: string;
  kind: InsightKind;
  title: string;
  detail: string;
  metric: number;
  unit: string;
  tone: LearningTone;
}

export interface HealthComponent {
  key: 'project' | 'architecture' | 'knowledge' | 'mission' | 'memory' | 'confidence';
  label: string;
  score: number;
  detail: string;
  tone: LearningTone;
}

export interface EngineeringHealth {
  overall: number;
  components: HealthComponent[];
  sampledRecords: number;
  sampledRangeDays: number;
  /** true when too few records exist for the score to be meaningful. */
  insufficient: boolean;
}

export interface TrendPoint { at: string; label: string; value: number }

export interface LearningTrend {
  key: string;
  label: string;
  points: TrendPoint[];
  delta: number;
  direction: 'up' | 'down' | 'flat';
  tone: LearningTone;
  unit: string;
}

export interface EngineAnalysis {
  generatedAt: string;
  records: number;
  patterns: LearningPattern[];
  predictions: LearningPrediction[];
  insights: LearningInsight[];
  health: EngineeringHealth;
  trends: LearningTrend[];
}

/** An analysis with nothing in it — what a screen shows before the first fetch. */
export const EMPTY_ANALYSIS: EngineAnalysis = {
  generatedAt: new Date(0).toISOString(),
  records: 0,
  patterns: [],
  predictions: [],
  insights: [],
  health: { overall: 0, components: [], sampledRecords: 0, sampledRangeDays: 0, insufficient: true },
  trends: [],
};

/** Fetch the analysis for one project, or the whole workspace with `null`. */
export async function fetchAnalysis(projectId?: string | null): Promise<EngineAnalysis> {
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
  const res = await fetch(`${BASE}/learning${query}`);
  if (!res.ok) throw new Error(`learning analysis failed: HTTP ${res.status}`);
  return res.json() as Promise<EngineAnalysis>;
}

/**
 * The analysis, kept current.
 *
 * Refetched when the project changes and when a new engineering event
 * lands on the Event Spine — which is every real recompute trigger, and
 * no timer. The old implementation recomputed on every store change with
 * `useMemo`; this recomputes when the evidence actually changed.
 */
export function useLearningEngine(projectId?: string | null): EngineAnalysis {
  const [analysis, setAnalysis] = useState<EngineAnalysis>(EMPTY_ANALYSIS);

  useEffect(() => {
    let live = true;
    const load = () => {
      fetchAnalysis(projectId).then(
        (next) => { if (live) setAnalysis(next); },
        // A failed fetch keeps the last good analysis rather than
        // replacing real findings with zeros, which would read as "your
        // project is fine" when it means "AURA could not be reached".
        () => undefined,
      );
    };
    load();
    const unsub = subscribeToSpine(['workspace', 'agent'], (e) => {
      if (e.type === 'workspace.engineering-event' || e.type === 'workspace.engineering-purged') load();
    });
    return () => { live = false; unsub(); };
  }, [projectId]);

  return analysis;
}

/* ── AI chat answers ───────────────────────────────────────────────── */

interface LearningIntent {
  keys: string[];
  render: (a: EngineAnalysis, scope: string) => string;
}

const INTENTS: LearningIntent[] = [
  {
    keys: ['most bugs', 'caused the most bugs', 'buggiest', 'what module', 'which module', 'most diagnosis'],
    render: (a, scope) => {
      const bugs = a.patterns.filter((p) => p.kind === 'repeated-bug');
      const lines = bugs.length
        ? bugs.map((p) => `- **${p.title}** — ${p.detail}`).join('\n')
        : `No repeated-bug pattern recorded yet for ${scope}. Diagnoses appear here as they happen.`;
      const cat = a.insights.find((i) => i.kind === 'top-diagnosis-category');
      return (
        `## Module causing the most bugs — ${scope}\n\n` +
        (cat ? `Most common diagnosis category: **${cat.title.split(':')[1]?.trim() ?? cat.title}** (${cat.metric}).\n\n` : '') +
        lines +
        `\n\n_Answer derived deterministically from the Engineering Learning Engine (${a.records} memory records)._\n`
      );
    },
  },
  {
    keys: ['unstable', 'become more stable', 'most stable', 'reliable', 'stability'],
    render: (a, scope) => {
      const unstable = a.patterns.filter((p) => p.kind === 'unstable-module');
      const reliable = a.patterns.filter((p) => p.kind === 'reliable-module');
      const arch = a.patterns.filter((p) => p.kind === 'architecture-hotspot');
      const lines: string[] = [];
      if (unstable.length) lines.push('**Unstable modules:**\n' + unstable.map((p) => `- ${p.title} — ${p.detail}`).join('\n'));
      if (reliable.length) lines.push('**Most reliable modules:**\n' + reliable.map((p) => `- ${p.title} — ${p.detail}`).join('\n'));
      if (arch.length) lines.push('**Architecture hotspots:**\n' + arch.map((p) => `- ${p.title} — ${p.detail}`).join('\n'));
      if (!lines.length) return `No stability pattern found for ${scope} yet — the engine needs more engineering events to compare.\n`;
      return `## Stability analysis — ${scope}\n\n${lines.join('\n\n')}\n\n_Answer derived deterministically from the Engineering Learning Engine (${a.records} memory records)._`;
    },
  },
  {
    keys: ['patterns have you learned', 'what patterns', 'learned', 'repeat', 'repeating'],
    render: (a, scope) => {
      const list = a.patterns.slice(0, 6);
      if (!list.length) return `No patterns learned yet for ${scope} — patterns emerge from real engineering events (missions, diagnoses, AI actions).\n`;
      return (
        `## Patterns learned — ${scope}\n\n` +
        list.map((p) => `- **${p.title}** — ${p.detail}`).join('\n') +
        `\n\n_Answer derived deterministically from the Engineering Learning Engine over ${a.records} memory records._`
      );
    },
  },
  {
    keys: ['engineering decisions repeat', 'decisions', 'what decisions'],
    render: (a, scope) => {
      const decisions = a.insights.filter((i) => i.kind === 'ai-acceptance' || i.kind === 'rejected-proposals');
      if (!decisions.length) return `No repeated decisions recorded for ${scope} yet.\n`;
      return (
        `## Repeating engineering decisions — ${scope}\n\n` +
        decisions.map((i) => `- **${i.title}** — ${i.detail}`).join('\n') +
        `\n\n_Answer derived deterministically from the Engineering Learning Engine (${a.records} memory records)._`
      );
    },
  },
  {
    keys: ['health', 'healthy', 'health score', 'score'],
    render: (a, scope) => {
      const h = a.health;
      const comps = h.components.map((c) => `- **${c.label}**: ${c.score}/100`).join('\n');
      const note = h.insufficient
        ? `\n\n⚠ Only ${h.sampledRecords} records — this score is not yet statistically meaningful.`
        : `\n\n_Scored from ${h.sampledRecords} real records over ~${h.sampledRangeDays} day(s)._`;
      return `## Engineering Health — ${scope}\n\n**Overall: ${h.overall}/100**\n\n${comps}\n${note}\n`;
    },
  },
  {
    keys: ['likely to break', 'will break', 'risk', 'risky', 'predict', 'prediction', 'regress', 'refactor', 'debt', 'complexity'],
    render: (a, scope) => {
      const preds = a.predictions.slice(0, 5);
      if (!preds.length) return `No risk predictions for ${scope} yet — predictions need evidence (diagnoses, failures, churn) to become meaningful.\n`;
      return (
        `## Risk predictions — ${scope}\n\n` +
        preds.map((p) => `- **${p.target}** (${p.risk} risk, ${p.confidence}% confidence) — ${p.detail}\n  Mitigations: ${p.actions.join('; ')}.`).join('\n\n') +
        `\n\n_Answer derived deterministically from the Engineering Learning Engine (${a.records} memory records)._`
      );
    },
  },
  {
    keys: ['trend', 'trending', 'over time'],
    render: (a, scope) => {
      const t = a.trends.slice(0, 4);
      if (!t.length) return `No trends for ${scope} yet — trends need time-series data.\n`;
      return (
        `## Engineering trends — ${scope}\n\n` +
        t.map((tr) => `- **${tr.label}**: ${tr.direction === 'flat' ? 'stable' : tr.direction} (${tr.delta > 0 ? '+' : ''}${tr.delta}%${tr.unit})`).join('\n') +
        `\n\n_Answer derived deterministically from the Engineering Learning Engine (${a.records} memory records)._\n`
      );
    },
  },
];

/**
 * Try to answer a user question from the Learning Engine. Returns
 * markdown when the question matches a learning intent, else null so
 * the normal AI pipeline can handle it.
 *
 * Asynchronous now: the analysis comes from the service, which is the
 * only place it exists.
 */
export async function answerLearningQuestion(text: string, projectId: string | null, scopeLabel: string): Promise<string | null> {
  const lower = text.toLowerCase();
  const intent = INTENTS.find((i) => i.keys.some((k) => lower.includes(k)));
  if (!intent) return null;
  try {
    return intent.render(await fetchAnalysis(projectId), scopeLabel);
  } catch {
    // The service is the authority on these numbers. If it cannot be
    // reached, this is not a learning answer — fall through to the normal
    // AI pipeline rather than rendering an analysis of nothing.
    return null;
  }
}
