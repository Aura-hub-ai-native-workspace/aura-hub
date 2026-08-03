/**
 * learningEngine — the Engineering Learning Engine.
 * ==================================================================
 * The layer that consumes Engineering Memory and turns raw event
 * records into engineering knowledge. Given the persisted memory list
 * it derives, deterministically and with no machine learning:
 *
 *   • patterns   — repeated bugs, hot modules, unstable files, AI
 *                  proposal acceptance, architecture hotspots, mission
 *                  bottlenecks, workflow habits, reliable modules
 *   • insights   — the headline statistics behind those patterns
 *   • predictions — files likely to break, modules needing refactor,
 *                  growing debt, architecture risk, dependency churn,
 *                  regression risk (each with confidence + rationale)
 *   • trends     — time-series of activity, diagnosis rate, AI
 *                  acceptance, mission failures and knowledge growth
 *   • health     — Project / Architecture / Knowledge / Mission /
 *                  Memory / Learning-confidence scores
 *
 * Everything is rule-based statistics over REAL memory records — no
 * fabricated numbers, no placeholders. The API is shaped so a future
 * ML model can replace `analyzeMemories` behind the same types.
 */
import { useMemo } from 'react';
import { useMemoryStore, type EngineeringMemory } from './memoryStore';

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

const MIN_SAMPLES = 2;
const DAY_MS = 86400000;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

function nameOf(file: string): string {
  return file.split('/').pop() ?? file;
}

function toneOfScore(score: number): LearningTone {
  if (score >= 75) return 'positive';
  if (score >= 55) return 'info';
  if (score >= 40) return 'attention';
  return 'critical';
}

/* ── time bucketing ────────────────────────────────────────────────── */

interface Bucket { at: string; items: EngineeringMemory[] }

function dailyBuckets(memories: EngineeringMemory[], max = 14): Bucket[] {
  const now = Date.now();
  const out: Bucket[] = [];
  for (let i = max - 1; i >= 0; i--) {
    const end = now - i * DAY_MS;
    const start = end - DAY_MS;
    out.push({
      at: new Date(end).toISOString(),
      items: memories.filter((m) => {
        const t = new Date(m.at).getTime();
        return t >= start && t < end;
      }),
    });
  }
  return out;
}

function avg(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function toTrend(
  key: string,
  label: string,
  buckets: Bucket[],
  metric: (b: Bucket) => number,
  goodUp: boolean,
  unit = '',
): LearningTrend {
  const points: TrendPoint[] = buckets.map((b) => ({
    at: b.at,
    label: `${new Date(b.at).getUTCMonth() + 1}/${new Date(b.at).getUTCDate()}`,
    value: metric(b),
  }));
  const half = Math.max(1, Math.floor(points.length / 2));
  const first = avg(points.slice(0, half).map((p) => p.value));
  const second = avg(points.slice(half).map((p) => p.value));
  let delta: number;
  if (first === 0 && second === 0) delta = 0;
  else if (first === 0) delta = 100;
  else delta = Math.round(((second - first) / Math.abs(first)) * 100);
  const direction: LearningTrend['direction'] = delta > 10 ? 'up' : delta < -10 ? 'down' : 'flat';
  const tone: LearningTone = direction === 'flat' ? 'neutral' : goodUp === (direction === 'up') ? 'positive' : 'attention';
  return { key, label, points, delta, direction, tone, unit };
}

/* ── per-file statistics ───────────────────────────────────────────── */

interface FileStats {
  file: string;
  name: string;
  edits: number;
  touches: number;
  diagnoses: number;
  recentDiagnoses: number;
  aiAccepted: number;
  aiDeclined: number;
  critical: number;
  high: number;
  recent: number;
}

function buildFileStats(memories: EngineeringMemory[]): Map<string, FileStats> {
  const map = new Map<string, FileStats>();
  const now = Date.now();
  const ensure = (file: string): FileStats => {
    let s = map.get(file);
    if (!s) {
      s = {
        file,
        name: nameOf(file),
        edits: 0,
        touches: 0,
        diagnoses: 0,
        recentDiagnoses: 0,
        aiAccepted: 0,
        aiDeclined: 0,
        critical: 0,
        high: 0,
        recent: 0,
      };
      map.set(file, s);
    }
    return s;
  };

  for (const m of memories) {
    const t = new Date(m.at).getTime();
    const recent = now - t <= 7 * DAY_MS;
    if (m.category === 'code' && m.source === 'editor') {
      for (const f of m.files) {
        const s = ensure(f);
        s.edits += 1;
        s.touches += 1;
        if (recent) s.recent += 1;
      }
    } else if (m.category === 'diagnosis') {
      for (const f of m.files) {
        const s = ensure(f);
        s.diagnoses += 1;
        if (recent) s.recentDiagnoses += 1;
        s.touches += 1;
        if (recent) s.recent += 1;
      }
    } else {
      for (const f of m.files) {
        const s = ensure(f);
        s.touches += 1;
        if (recent) s.recent += 1;
        if (m.source === 'ai-action' && m.category === 'code') s.aiAccepted += 1;
        if (m.source === 'ai-action' && m.category === 'review') s.aiDeclined += 1;
      }
    }
    if (m.importance === 'critical') for (const f of m.files) ensure(f).critical += 1;
    if (m.importance === 'high') for (const f of m.files) ensure(f).high += 1;
  }
  return map;
}

/* ── main analysis ─────────────────────────────────────────────────── */

export function analyzeMemories(all: EngineeringMemory[]): EngineAnalysis {
  const records = all.length;
  const generatedAt = new Date().toISOString();
  const now = Date.now();
  const files = buildFileStats(all);

  /* ---- patterns ---- */
  const patterns: LearningPattern[] = [];

  // Repeated bugs by file (diagnosis events per file).
  const buggy = [...files.values()]
    .filter((s) => s.diagnoses >= MIN_SAMPLES)
    .sort((a, b) => b.diagnoses - a.diagnoses || a.name.localeCompare(b.name))
    .slice(0, 4);
  for (const s of buggy) {
    patterns.push({
      id: `pattern-repeated-bug-${s.file}`,
      kind: 'repeated-bug',
      title: `${s.name} has failed diagnosis ${s.diagnoses} times`,
      detail: `${s.recentDiagnoses} of those in the last 7 days — the most repeatedly diagnosed file.`,
      count: s.diagnoses,
      tone: s.diagnoses >= 4 ? 'critical' : 'attention',
      evidence: evidenceFor(all, (m) => m.category === 'diagnosis' && m.files.includes(s.file)),
    });
  }

  // Frequently edited modules.
  const edited = [...files.values()]
    .filter((s) => s.edits >= MIN_SAMPLES)
    .sort((a, b) => b.edits - a.edits || a.name.localeCompare(b.name))
    .slice(0, 4);
  for (const s of edited) {
    patterns.push({
      id: `pattern-hot-module-${s.file}`,
      kind: 'hot-module',
      title: `${s.name} is the most frequently edited module`,
      detail: `${s.edits} editor saves — the busiest file in the project.`,
      count: s.edits,
      tone: 'info',
      evidence: evidenceFor(all, (m) => m.source === 'editor' && m.files.includes(s.file)),
    });
  }

  // Most unstable files (high diagnosis + rejection ratio).
  const unstable = [...files.values()]
    .filter((s) => s.touches >= MIN_SAMPLES && s.diagnoses + s.aiDeclined >= 2)
    .map((s) => ({ s, ratio: (s.diagnoses + s.aiDeclined) / s.touches }))
    .sort((a, b) => b.ratio - a.ratio || b.s.touches - a.s.touches)
    .slice(0, 4);
  for (const { s, ratio } of unstable) {
    const pct = Math.round(ratio * 100);
    patterns.push({
      id: `pattern-unstable-module-${s.file}`,
      kind: 'unstable-module',
      title: `${s.name} is the most unstable module`,
      detail: `${pct}% of its records are bugs or declined AI proposals (${s.diagnoses} diagnoses, ${s.aiDeclined} rejections).`,
      count: s.diagnoses + s.aiDeclined,
      tone: pct >= 50 ? 'critical' : 'attention',
      evidence: evidenceFor(all, (m) => m.files.includes(s.file)),
    });
  }

  // Most reliable modules (high edit count, zero problems).
  const reliable = [...files.values()]
    .filter((s) => s.edits >= 3 && s.diagnoses === 0 && s.aiDeclined === 0)
    .sort((a, b) => b.edits - a.edits)
    .slice(0, 3);
  for (const s of reliable) {
    patterns.push({
      id: `pattern-reliable-module-${s.file}`,
      kind: 'reliable-module',
      title: `${s.name} is the most reliable module`,
      detail: `${s.edits} edits with zero diagnoses and zero declined AI proposals — a stable core.`,
      count: s.edits,
      tone: 'positive',
      evidence: evidenceFor(all, (m) => m.source === 'editor' && m.files.includes(s.file)),
    });
  }

  // AI proposal rejection hotspots.
  const rejections = [...files.values()]
    .filter((s) => s.aiAccepted + s.aiDeclined >= MIN_SAMPLES)
    .map((s) => ({ s, rate: s.aiAccepted / (s.aiAccepted + s.aiDeclined) }))
    .filter(({ rate }) => rate < 0.4)
    .sort((a, b) => a.rate - b.rate)
    .slice(0, 3);
  for (const { s, rate } of rejections) {
    const pct = Math.round(rate * 100);
    patterns.push({
      id: `pattern-ai-rejection-${s.file}`,
      kind: 'ai-rejection',
      title: `AI proposals touching ${s.name} are accepted only ${pct}% of the time`,
      detail: `${s.aiAccepted} accepted vs ${s.aiDeclined} declined — the user rejects most AI changes here.`,
      count: s.aiDeclined,
      tone: 'attention',
      evidence: evidenceFor(all, (m) => m.source === 'ai-action' && m.files.includes(s.file)),
    });
  }

  // Architecture hotspots (layers with heavy churn / problem share).
  const layerStats = new Map<string, { touches: number; critical: number; high: number; diagnosis: number }>();
  for (const m of all) {
    if (!m.layer) continue;
    let s = layerStats.get(m.layer);
    if (!s) { s = { touches: 0, critical: 0, high: 0, diagnosis: 0 }; layerStats.set(m.layer, s); }
    s.touches += 1;
    if (m.importance === 'critical') s.critical += 1;
    if (m.importance === 'high') s.high += 1;
    if (m.category === 'diagnosis') s.diagnosis += 1;
  }
  const hotspots = [...layerStats.entries()]
    .map(([layer, s]) => ({ layer, s, problem: s.critical + s.high + s.diagnosis, ratio: (s.critical + s.high + s.diagnosis) / s.touches }))
    .filter((h) => h.s.touches >= MIN_SAMPLES && h.problem >= 2)
    .sort((a, b) => b.problem - a.problem)
    .slice(0, 3);
  for (const h of hotspots) {
    patterns.push({
      id: `pattern-hotspot-${h.layer}`,
      kind: 'architecture-hotspot',
      title: `${h.layer} is an architecture hotspot`,
      detail: `${h.s.touches} events, ${h.s.critical} critical and ${h.s.diagnosis} diagnoses — ${Math.round(h.ratio * 100)}% of its records signal trouble.`,
      count: h.problem,
      tone: h.s.critical > 0 ? 'critical' : 'attention',
      evidence: evidenceFor(all, (m) => m.layer === h.layer),
    });
  }

  // Mission bottlenecks (missions with failures / task failures).
  const missionFails = new Map<string, { id: string; fails: number; total: number }>();
  for (const m of all) {
    if (!m.missionId) continue;
    let s = missionFails.get(m.missionId);
    if (!s) { s = { id: m.missionId, fails: 0, total: 0 }; missionFails.set(m.missionId, s); }
    s.total += 1;
    if ((m.category === 'mission' && m.importance === 'critical') || (m.category === 'learning' && /task failed/i.test(m.title))) s.fails += 1;
  }
  const bottlenecks = [...missionFails.values()]
    .filter((s) => s.fails >= 1)
    .sort((a, b) => b.fails - a.fails)
    .slice(0, 3);
  for (const b of bottlenecks) {
    patterns.push({
      id: `pattern-mission-bottleneck-${b.id}`,
      kind: 'mission-bottleneck',
      title: `A mission is a recurring bottleneck`,
      detail: `${b.fails} failed task(s) or failed execution across ${b.total} recorded events for this mission.`,
      count: b.fails,
      tone: b.fails >= 2 ? 'critical' : 'attention',
      evidence: evidenceFor(all, (m) => m.missionId === b.id),
    });
  }

  // Workflow habits (most active hour + bursts).
  const hourCounts = new Array(24).fill(0) as number[];
  let bursts = 0;
  const hourBurst = new Map<string, number>();
  for (const m of all) {
    const d = new Date(m.at);
    hourCounts[d.getHours()] += 1;
    const key = `${m.projectId ?? 'ws'}:${d.toISOString().slice(0, 13)}`;
    hourBurst.set(key, (hourBurst.get(key) ?? 0) + 1);
  }
  for (const c of hourBurst.values()) if (c >= 3) bursts += 1;
  let peakHour = -1;
  let peakCount = 0;
  hourCounts.forEach((c, h) => {
    if (c > peakCount) { peakCount = c; peakHour = h; }
  });
  if (peakHour >= 0 && peakCount >= MIN_SAMPLES) {
    patterns.push({
      id: 'pattern-workflow-habit',
      kind: 'workflow-habit',
      title: `Most engineering activity happens at ${String(peakHour).padStart(2, '0')}:00`,
      detail: `${peakCount} recorded events — and ${bursts} concentrated editing burst(s) of 3+ events in a single hour.`,
      count: peakCount,
      tone: 'info',
      evidence: evidenceFor(all, (m) => new Date(m.at).getHours() === peakHour).slice(0, 3),
    });
  }

  /* ---- insights (headline statistics) ---- */
  const insights: LearningInsight[] = [];
  const acceptedAi = all.filter((m) => m.source === 'ai-action' && m.category === 'code').length;
  const declinedAi = all.filter((m) => m.source === 'ai-action' && m.category === 'review').length;
  const aiTotal = acceptedAi + declinedAi;
  const diagnoses = all.filter((m) => m.category === 'diagnosis').length;
  const missionCompleted = all.filter((m) => m.category === 'mission' && /completed/i.test(m.title)).length;
  const missionFailed = all.filter((m) => m.category === 'mission' && /failed/i.test(m.title)).length;
  const critical = all.filter((m) => m.importance === 'critical').length;
  const knowledgeItems = all.filter((m) => m.category === 'learning' || m.category === 'documentation' || m.source === 'conversation').length;
  const editsTotal = all.filter((m) => m.source === 'editor').length;

  if (aiTotal > 0) {
    const pct = Math.round((acceptedAi / aiTotal) * 100);
    insights.push({
      id: 'insight-ai-acceptance', kind: 'ai-acceptance',
      title: `AI proposals are accepted ${pct}% of the time`,
      detail: `${acceptedAi} accepted, ${declinedAi} declined across the workspace.`,
      metric: pct, unit: '%', tone: pct >= 60 ? 'positive' : pct >= 40 ? 'info' : 'attention',
    });
  }
  if (records > 0) {
    const pct = Math.round((diagnoses / records) * 100);
    insights.push({
      id: 'insight-diagnosis-rate', kind: 'diagnosis-rate',
      title: `${diagnoses} diagnosis event(s), ${pct}% of all records`,
      detail: `Diagnoses are the highest-signal signal for unstable code.`,
      metric: pct, unit: '%', tone: pct <= 15 ? 'positive' : pct <= 30 ? 'info' : 'attention',
    });
  }
  if (missionCompleted + missionFailed > 0) {
    const pct = Math.round((missionCompleted / (missionCompleted + missionFailed)) * 100);
    insights.push({
      id: 'insight-mission-completion', kind: 'mission-completion',
      title: `Missions complete ${pct}% of the time`,
      detail: `${missionCompleted} completed vs ${missionFailed} failed.`,
      metric: pct, unit: '%', tone: pct >= 75 ? 'positive' : pct >= 50 ? 'info' : 'attention',
    });
  }
  const catCounts = new Map<string, number>();
  for (const m of all) if (m.category === 'diagnosis') {
    const cat = m.summary.split(':')[0]?.trim() ?? 'diagnosis';
    catCounts.set(cat, (catCounts.get(cat) ?? 0) + 1);
  }
  const topCat = [...catCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (topCat && topCat[1] >= MIN_SAMPLES) {
    insights.push({
      id: 'insight-top-diagnosis-category', kind: 'top-diagnosis-category',
      title: `Most common diagnosis category: ${topCat[0]}`,
      detail: `${topCat[1]} occurrence(s) of ${topCat[0]}.`,
      metric: topCat[1], unit: '', tone: 'info',
    });
  }
  if (peakHour >= 0 && records > 0) {
    insights.push({
      id: 'insight-activity-hour', kind: 'activity-hour',
      title: `Peak activity hour: ${String(peakHour).padStart(2, '0')}:00`,
      detail: `${peakCount} events in that single hour.`,
      metric: peakHour, unit: 'h', tone: 'info',
    });
  }
  const spanDays = Math.max(1, Math.ceil((now - earliest(all)) / DAY_MS));
  const velocity = Math.round((editsTotal / spanDays) * 10) / 10;
  insights.push({
    id: 'insight-edit-velocity', kind: 'edit-velocity',
    title: `Editing velocity: ${velocity} saves/day`,
    detail: `${editsTotal} editor saves across ${spanDays} day(s).`,
    metric: velocity, unit: '/day', tone: 'neutral',
  });
  if (knowledgeItems > 0) {
    insights.push({
      id: 'insight-knowledge-count', kind: 'knowledge-count',
      title: `${knowledgeItems} knowledge item(s) captured`,
      detail: `Learning, documentation and conversations recorded by the platform.`,
      metric: knowledgeItems, unit: '', tone: 'positive',
    });
  }
  if (missionFailed > 0) {
    insights.push({
      id: 'insight-mission-failures', kind: 'mission-failures',
      title: `${missionFailed} failed mission(s) recorded`,
      detail: `Failures are the strongest predictor of fragile areas.`,
      metric: missionFailed, unit: '', tone: 'critical',
    });
  }
  if (declinedAi > 0) {
    insights.push({
      id: 'insight-rejected-proposals', kind: 'rejected-proposals',
      title: `${declinedAi} AI proposal(s) declined`,
      detail: `Each decline is a signal the AI did not yet understand that area.`,
      metric: declinedAi, unit: '', tone: 'attention',
    });
  }
  if (critical > 0) {
    insights.push({
      id: 'insight-critical-events', kind: 'critical-events',
      title: `${critical} critical event(s) in memory`,
      detail: `Critical memories represent failed missions and severe instability.`,
      metric: critical, unit: '', tone: 'critical',
    });
  }

  /* ---- predictions (statistical, evidence-based) ---- */
  const predictions: LearningPrediction[] = [];

  const fileBreaks = [...files.values()]
    .filter((s) => s.diagnoses >= 1)
    .map((s) => ({ s, score: s.diagnoses * 3 + s.recentDiagnoses * 5 + s.aiDeclined }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  for (const { s, score } of fileBreaks) {
    const confidence = Math.round(clamp(40 + score * 4 + (s.recentDiagnoses > 0 ? 15 : 0), 40, 92));
    predictions.push({
      id: `predict-break-${s.file}`,
      kind: 'file-break',
      target: s.name,
      risk: s.recentDiagnoses > 0 || s.diagnoses >= 3 ? 'high' : 'medium',
      confidence,
      detail: `${s.diagnoses} diagnoses (${s.recentDiagnoses} recent) on this file — the strongest break-risk signal in memory.`,
      evidenceCount: s.diagnoses,
      actions: ['Run a diagnosis on this file', 'Add regression tests', 'Review recent changes'],
    });
  }

  const refactors = [...files.values()]
    .filter((s) => s.edits >= 3 && (s.aiDeclined >= 1 || s.diagnoses >= 1))
    .map((s) => ({ s, score: s.edits + (s.aiDeclined + s.diagnoses) * 4 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  for (const { s, score } of refactors) {
    const confidence = Math.round(clamp(35 + score * 3, 35, 88));
    predictions.push({
      id: `predict-refactor-${s.file}`,
      kind: 'refactor',
      target: s.name,
      risk: s.aiDeclined + s.diagnoses >= 3 ? 'high' : 'medium',
      confidence,
      detail: `Heavy churn (${s.edits} edits) combined with ${s.diagnoses} diagnoses and ${s.aiDeclined} declined AI proposals suggests this module needs structural work.`,
      evidenceCount: s.edits + s.aiDeclined + s.diagnoses,
      actions: ['Open a refactoring mission', 'Extract the failing sub-module', 'Document the module contract'],
    });
  }

  // Debt growth: files whose edit rate is rising in the second half of the window.
  const buckets = dailyBuckets(all);
  const half = Math.max(1, Math.floor(buckets.length / 2));
  const debtPerFile = new Map<string, { first: number; second: number }>();
  buckets.forEach((b, i) => {
    const phase = i < half ? 'first' : 'second';
    for (const m of b.items) {
      if (m.source !== 'editor') continue;
      for (const f of m.files) {
        let e = debtPerFile.get(f);
        if (!e) { e = { first: 0, second: 0 }; debtPerFile.set(f, e); }
        e[phase] += 1;
      }
    }
  });
  const growing = [...debtPerFile.entries()]
    .filter(([, e]) => e.first + e.second >= 2 && e.second > e.first)
    .sort((a, b) => b[1].second - b[1].first - (a[1].second - a[1].first))
    .slice(0, 3);
  for (const [file, e] of growing) {
    const confidence = Math.round(clamp(40 + (e.second - e.first) * 8, 40, 90));
    predictions.push({
      id: `predict-debt-${file}`,
      kind: 'debt-growth',
      target: nameOf(file),
      risk: e.second >= 3 ? 'medium' : 'low',
      confidence,
      detail: `Edits are accelerating: ${e.first} saves in the earlier period vs ${e.second} now — rising churn usually precedes debt.`,
      evidenceCount: e.first + e.second,
      actions: ['Schedule a maintenance mission', 'Audit the dependency graph', 'Run verification'],
    });
  }

  const archRisks = [...layerStats.entries()]
    .filter(([, s]) => s.touches >= MIN_SAMPLES && s.critical + s.high >= 2)
    .map(([layer, s]) => ({ layer, s, ratio: (s.critical + s.high) / s.touches }))
    .filter((r) => r.ratio >= 0.5)
    .sort((a, b) => b.ratio - a.ratio)
    .slice(0, 2);
  for (const r of archRisks) {
    predictions.push({
      id: `predict-arch-${r.layer}`,
      kind: 'architecture-risk',
      target: r.layer,
      risk: r.s.critical > 0 ? 'high' : 'medium',
      confidence: Math.round(clamp(40 + r.ratio * 40, 40, 88)),
      detail: `${Math.round(r.ratio * 100)}% of ${r.layer} events carry critical/high importance (${r.s.critical} critical) — an architectural pressure point.`,
      evidenceCount: r.s.critical + r.s.high,
      actions: ['Open the architecture layer view', 'Review critical events in this layer'],
    });
  }

  const churn = [...files.values()]
    .filter((s) => s.touches >= 4)
    .sort((a, b) => b.recent - a.recent || b.touches - a.touches)
    .slice(0, 2);
  for (const s of churn) {
    predictions.push({
      id: `predict-churn-${s.file}`,
      kind: 'dependency-churn',
      target: s.name,
      risk: s.recent >= 2 ? 'medium' : 'low',
      confidence: Math.round(clamp(35 + s.recent * 10, 35, 82)),
      detail: `${s.touches} total touches, ${s.recent} in the last 7 days — repeated nearby edits signal unstable dependencies.`,
      evidenceCount: s.touches,
      actions: ['Inspect dependents in the knowledge graph', 'Stabilize the module interface'],
    });
  }

  // Regression: an accepted AI change followed by a diagnosis on the same file within 7 days.
  const acceptedChanges = all.filter((m) => m.source === 'ai-action' && m.category === 'code');
  const regressions: { file: string; at: string; count: number }[] = [];
  for (const ac of acceptedChanges) {
    const acTime = new Date(ac.at).getTime();
    for (const f of ac.files) {
      const follow = all.filter((m) => m.category === 'diagnosis' && m.files.includes(f) && new Date(m.at).getTime() >= acTime && new Date(m.at).getTime() - acTime <= 7 * DAY_MS);
      if (follow.length > 0) regressions.push({ file: f, at: ac.at, count: follow.length });
    }
  }
  const uniqueReg = new Map<string, { file: string; count: number }>();
  for (const r of regressions) {
    const cur = uniqueReg.get(r.file);
    uniqueReg.set(r.file, cur ? { file: r.file, count: cur.count + r.count } : { file: r.file, count: r.count });
  }
  for (const [file, r] of [...uniqueReg.entries()].slice(0, 3)) {
    predictions.push({
      id: `predict-regression-${file}`,
      kind: 'regression',
      target: nameOf(file),
      risk: r.count >= 2 ? 'high' : 'medium',
      confidence: Math.round(clamp(45 + r.count * 12, 45, 90)),
      detail: `A diagnosis followed an accepted AI change on this file within 7 days (${r.count} time(s)) — a likely regression.`,
      evidenceCount: r.count,
      actions: ['Re-run the diagnosis', 'Roll back the last AI change', 'Add a targeted test'],
    });
  }

  /* ---- trends ---- */
  const trends: LearningTrend[] = [
    toTrend('activity', 'Daily activity', buckets, (b) => b.items.length, false, 'events'),
    toTrend('diagnosis-rate', 'Diagnosis rate', buckets, (b) => Math.round((b.items.filter((m) => m.category === 'diagnosis').length / Math.max(1, b.items.length)) * 100), false, '%'),
    toTrend('ai-acceptance', 'AI acceptance', buckets, (b) => {
      const acc = b.items.filter((m) => m.source === 'ai-action' && m.category === 'code').length;
      const dec = b.items.filter((m) => m.source === 'ai-action' && m.category === 'review').length;
      const total = acc + dec;
      return total === 0 ? 0 : Math.round((acc / total) * 100);
    }, true, '%'),
    toTrend('mission-failures', 'Mission failures', buckets, (b) => b.items.filter((m) => m.category === 'mission' && /failed/i.test(m.title)).length, false, ''),
    toTrend('knowledge-growth', 'Knowledge growth', buckets, (b) => b.items.filter((m) => m.category === 'learning' || m.category === 'documentation' || m.source === 'conversation').length, true, ''),
    toTrend('edits', 'Code changes', buckets, (b) => b.items.filter((m) => m.source === 'editor').length, false, ''),
  ];

  /* ---- health ---- */
  const health = computeHealth(all, { diagnoses, missionCompleted, missionFailed, knowledgeItems, critical, records });

  return { generatedAt, records, patterns, predictions, insights, health, trends };
}

/* ── health score ──────────────────────────────────────────────────── */

function computeHealth(
  all: EngineeringMemory[],
  counts: { diagnoses: number; missionCompleted: number; missionFailed: number; knowledgeItems: number; critical: number; records: number },
): EngineeringHealth {
  const { diagnoses, missionCompleted, missionFailed, knowledgeItems, critical, records } = counts;
  const now = Date.now();
  const spanMs = now - earliest(all);
  const rangeDays = Math.max(1, Math.ceil(spanMs / DAY_MS));
  const fresh = all.filter((m) => now - new Date(m.at).getTime() <= 14 * DAY_MS).length;
  const freshness = records ? fresh / records : 0;

  const diagnosisRatio = records ? diagnoses / records : 0;
  const criticalRatio = records ? critical / records : 0;
  const projectScore = Math.round(clamp(100 - diagnosisRatio * 160 - criticalRatio * 90, 0, 100));

  const archMemories = all.filter((m) => m.category === 'architecture' || m.layer);
  const archRatio = archMemories.length ? archMemories.filter((m) => m.importance === 'critical' || m.importance === 'high').length / archMemories.length : diagnosisRatio;
  const architectureScore = Math.round(clamp(100 - archRatio * 120, 0, 100));

  const knowledgeScore = Math.round(clamp(knowledgeItems * 6 + freshness * 40, 0, 100));

  const missionDone = missionCompleted + missionFailed;
  const missionScore = missionDone ? Math.round(clamp((missionCompleted / missionDone) * 100, 0, 100)) : Math.round(clamp(50 - criticalRatio * 100, 0, 100));

  const capUse = Math.min(1, records / 3600);
  const memoryScore = Math.round(clamp(freshness * 60 + Math.min(1, records / 60) * 40 - capUse * 20, 0, 100));

  const confidenceScore = Math.round(clamp(Math.min(1, records / 40) * 55 + freshness * 45, 0, 100));

  const components: HealthComponent[] = [
    { key: 'project', label: 'Project', score: projectScore, detail: `Based on ${diagnoses} diagnoses and ${critical} critical events across ${records} records.`, tone: toneOfScore(projectScore) },
    { key: 'architecture', label: 'Architecture', score: architectureScore, detail: `Derived from ${archMemories.length} architecture/layer records.`, tone: toneOfScore(architectureScore) },
    { key: 'knowledge', label: 'Knowledge', score: knowledgeScore, detail: `${knowledgeItems} knowledge items captured; ${Math.round(freshness * 100)}% of records recent.`, tone: toneOfScore(knowledgeScore) },
    { key: 'mission', label: 'Mission', score: missionScore, detail: missionDone ? `${missionCompleted} completed vs ${missionFailed} failed missions.` : 'No completed or failed missions recorded yet.', tone: toneOfScore(missionScore) },
    { key: 'memory', label: 'Memory', score: memoryScore, detail: `${records} records, ${Math.round(freshness * 100)}% within the last 14 days.`, tone: toneOfScore(memoryScore) },
    { key: 'confidence', label: 'Learning confidence', score: confidenceScore, detail: `Confidence in these findings grows with record count and freshness.`, tone: toneOfScore(confidenceScore) },
  ];

  const overall = Math.round(
    components[0].score * 0.25 +
    components[1].score * 0.2 +
    components[2].score * 0.15 +
    components[3].score * 0.2 +
    components[4].score * 0.1 +
    components[5].score * 0.1,
  );

  return { overall, components, sampledRecords: records, sampledRangeDays: rangeDays, insufficient: records < 5 };
}

function earliest(all: EngineeringMemory[]): number {
  if (!all.length) return Date.now();
  return Math.min(...all.map((m) => new Date(m.at).getTime()));
}

function evidenceFor(all: EngineeringMemory[], match: (m: EngineeringMemory) => boolean): LearningEvidence[] {
  return all
    .filter(match)
    .slice()
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 3)
    .map((m) => ({ memoryId: m.id, title: m.title, at: m.at, file: m.files[0] }));
}

/* ── React hook ────────────────────────────────────────────────────── */

/**
 * Recompute the full learning analysis whenever memory changes.
 * `projectId` scopes to one project; `null` analyzes the whole
 * workspace. Pure `useMemo` over the persisted store — cheap enough to
 * run on every record (≤ a few thousand items).
 */
export function useLearningEngine(projectId?: string | null): EngineAnalysis {
  const memories = useMemoryStore((s) => s.memories);
  return useMemo(() => {
    const scoped = projectId ? memories.filter((m) => m.projectId === projectId) : memories;
    return analyzeMemories(scoped);
  }, [memories, projectId]);
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
 */
export function answerLearningQuestion(text: string, projectId: string | null, scopeLabel: string): string | null {
  const lower = text.toLowerCase();
  for (const intent of INTENTS) {
    if (intent.keys.some((k) => lower.includes(k))) {
      const analysis = analyzeMemories(useMemoryStore.getState().memories.filter((m) => (projectId ? m.projectId === projectId : true)));
      return intent.render(analysis, scopeLabel);
    }
  }
  return null;
}
