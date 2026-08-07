/**
 * Prediction Engine — nine deterministic predictors.
 * ==================================================================
 * Each predictor is a pure `evidence (+ optional live context) → Prediction[]`
 * function with a documented formula, explicit drivers (EvidencePoint)
 * and an honest Confidence. A prediction is ALWAYS one of:
 *
 *   file-failure          churn × complexity × connectivity
 *   module-instability    max file risk × module churn
 *   future-tech-debt      debt markers on churny/complex files
 *   dependency-conflict   loose/vulnerable/deprecated/changed ranges
 *   architecture-drift    drift imports + cycle participation per module
 *   mission-failure       history + live mission risk/quality/acceptance
 *   proposal-success      strategy history + candidate confidence/limiter
 *   diagnosis-likelihood  churn × complexity × markers × coverage gap
 *   workflow-bottleneck   heavy/sequential workflows + failing actions
 *
 * Per-kind REQUIRED_SIGNALS keeps confidence honest: the count of
 * signals the predictor wanted vs. actually available vs. firing.
 */

import type {
  CandidateContext,
  Confidence,
  EvidencePoint,
  MissionContext,
  Prediction,
  PredictiveEvidence,
} from './types';
import { computeConfidence } from './confidence';
import { normalize, severityOf, horizonOf, sortByScoreDesc, weighted } from './score';
import { fileRisk } from './risk';
import { genPredictionId } from './types';
/* ── Confidence helper ────────────────────────────────────────────── */

function conf(required: number, available: number, positive: number, caveats: string[] = []): Confidence {
  return computeConfidence({ required, available, positive, caveats });
}

const GIT_NOTE = (e: PredictiveEvidence) => (e.git.available ? [] : ['Git history unavailable — churn-based signals reduced.']);

/* ── 1. file-failure ──────────────────────────────────────────────── */

export function predictFileFailures(e: PredictiveEvidence): Prediction[] {
  const out: Prediction[] = [];
  const caveats = GIT_NOTE(e);
  const candidates = e.files.filter((f) => !f.isTest);
  for (const f of candidates) {
    const r = fileRisk(f);
    if (r.risk < 0.2) continue;
    const positive = r.drivers.length + (f.hasTests ? 0 : 1);
    const drivers: EvidencePoint[] = [
      { label: 'change frequency', value: f.churn, source: 'git-churn', weight: 0.3 },
      { label: 'structural complexity', value: f.complexity, source: 'scorecard', weight: 0.2 },
      { label: 'debt markers', value: f.markers, source: 'technical-debt', weight: 0.15 },
      { label: 'dependents', value: f.dependents.length, source: 'knowledge-graph', weight: 0.15 },
      { label: 'prior diagnosis hits', value: f.diagnosisFired, source: 'diagnosis-store', weight: 0.1 },
      { label: 'security findings', value: f.securityFindings, source: 'security-review', weight: 0.1 },
    ].filter((d) => d.weight > 0 && (Number(d.value) > 0 || f.dependents.length > 0));
    out.push({
      id: genPredictionId('file-failure', f.relPath),
      kind: 'file-failure',
      target: f.relPath,
      targetType: 'file',
      severity: severityOf(r.risk),
      probability: Math.round(r.risk * 1000) / 1000,
      confidence: conf(5, drivers.length + (f.hasTests ? 1 : 0), positive, caveats),
      horizon: horizonOf(r.risk),
      drivers,
      preventiveActions: [
        f.hasTests ? 'none' : `Add tests for ${f.relPath}`,
        f.markers > 0 ? `Resolve ${f.markers} debt marker(s) in ${f.relPath}` : 'none',
        f.complexity >= 0.7 ? `Refactor ${f.relPath} to reduce complexity` : 'none',
      ].filter((a) => a !== 'none'),
      summary: `${f.relPath} has ${f.churn} change(s), complexity ${f.complexity.toFixed(2)}${f.hasTests ? '' : ', no tests'}, and ${f.dependents.length} dependents — highest-risk source files fail here first.`,
    });
  }
  return sortByScoreDesc(out, (p) => p.probability, (p) => p.target);
}

/* ── 2. module-instability ────────────────────────────────────────── */

export function predictModuleInstability(e: PredictiveEvidence): Prediction[] {
  const out: Prediction[] = [];
  const caveats = GIT_NOTE(e);
  const byModule = new Map<string, { files: number; risk: number; churn: number; name: string }>();
  for (const f of e.files) {
    if (f.isTest) continue;
    const name = f.module ?? '(root)';
    const r = fileRisk(f).risk;
    const ms = e.modules.find((m) => m.name === name);
    const churn = ms?.churn ?? e.git.byModule[name]?.changes ?? 0;
    const cur = byModule.get(name);
    if (cur) {
      cur.files += 1;
      cur.risk = Math.max(cur.risk, r);
      cur.churn = Math.max(cur.churn, churn);
    } else {
      byModule.set(name, { files: 1, risk: r, churn, name });
    }
  }
  for (const m of [...byModule.values()]) {
    const churnScore = normalize(m.churn, 40);
    const prob = weighted([{ value: m.risk, weight: 0.6 }, { value: churnScore, weight: 0.25 }, { value: normalize(m.files, 25), weight: 0.15 }]);
    if (prob < 0.2) continue;
    const drivers: EvidencePoint[] = [
      { label: 'worst-file risk', value: m.risk, source: 'risk-engine', weight: 0.6 },
      { label: 'module churn', value: m.churn, source: 'git-churn', weight: 0.25 },
      { label: 'files in module', value: m.files, source: 'scan', weight: 0.15 },
    ];
    out.push({
      id: genPredictionId('module-instability', m.name),
      kind: 'module-instability',
      target: m.name,
      targetType: 'module',
      severity: severityOf(prob),
      probability: Math.round(prob * 1000) / 1000,
      confidence: conf(3, drivers.length, drivers.filter((d) => Number(d.value) > 0).length, caveats),
      horizon: horizonOf(prob),
      drivers,
      preventiveActions: [m.risk >= 0.5 ? `Stabilize the riskiest files in ${m.name} before new missions touch them` : 'none'].filter((a) => a !== 'none'),
      summary: `${m.name} is destabilizing — ${m.files} files, ${m.churn} changes, worst-file risk ${m.risk.toFixed(2)}.`,
    });
  }
  return sortByScoreDesc(out, (p) => p.probability, (p) => p.target);
}

/* ── 3. future-tech-debt ──────────────────────────────────────────── */

export function predictFutureDebt(e: PredictiveEvidence): Prediction[] {
  const out: Prediction[] = [];
  const caveats = GIT_NOTE(e);
  for (const f of e.files) {
    if (f.isTest || f.markers === 0) continue;
    const prob = weighted([
      { value: normalize(f.markers, 8), weight: 0.4 },
      { value: normalize(f.churn, 30), weight: 0.3 },
      { value: f.complexity, weight: 0.3 },
    ]);
    if (prob < 0.2) continue;
    const drivers: EvidencePoint[] = [
      { label: 'debt markers', value: f.markers, source: 'technical-debt', weight: 0.4 },
      { label: 'change frequency', value: f.churn, source: 'git-churn', weight: 0.3 },
      { label: 'structural complexity', value: f.complexity, source: 'scorecard', weight: 0.3 },
    ];
    out.push({
      id: genPredictionId('future-tech-debt', f.relPath),
      kind: 'future-tech-debt',
      target: f.relPath,
      targetType: 'file',
      severity: severityOf(prob),
      probability: Math.round(prob * 1000) / 1000,
      confidence: conf(3, drivers.length, drivers.filter((d) => Number(d.value) > 0).length, caveats),
      horizon: horizonOf(prob),
      drivers,
      preventiveActions: [`Convert TODO/FIXME markers in ${f.relPath} into tracked work items`],
      summary: `${f.markers} debt marker(s) on a file with ${f.churn} recent changes — will harden into maintenance debt.`,
    });
  }
  return sortByScoreDesc(out, (p) => p.probability, (p) => p.target);
}

/* ── 4. dependency-conflict ───────────────────────────────────────── */

export function predictDependencyConflicts(e: PredictiveEvidence): Prediction[] {
  const out: Prediction[] = [];
  const caveats = GIT_NOTE(e);
  for (const d of e.dependencies) {
    const prob = weighted([
      { value: d.vulnerable ? 1 : 0, weight: 0.4 },
      { value: d.deprecated ? 1 : 0, weight: 0.2 },
      { value: d.loose ? 1 : 0, weight: 0.25 },
      { value: d.changed ? 1 : 0, weight: 0.15 },
    ]);
    if (prob < 0.15) continue;
    const drivers: EvidencePoint[] = [
      { label: 'vulnerable', value: d.vulnerable, source: 'security-review', weight: 0.4 },
      { label: 'deprecated', value: d.deprecated, source: 'technical-debt', weight: 0.2 },
      { label: 'loose range', value: d.loose, source: 'manifest', weight: 0.25 },
      { label: 'manifest changed', value: d.changed, source: 'git-churn', weight: 0.15 },
    ].filter((x) => x.value === true);
    out.push({
      id: genPredictionId('dependency-conflict', `${d.name}@${d.range}`),
      kind: 'dependency-conflict',
      target: d.name,
      targetType: 'dependency',
      severity: severityOf(prob),
      probability: Math.round(prob * 1000) / 1000,
      confidence: conf(4, 4, drivers.length, caveats),
      horizon: horizonOf(prob),
      drivers,
      preventiveActions: [
        d.loose ? `Pin ${d.name} to an exact version in ${d.declaredIn}` : 'none',
        d.deprecated ? `Plan migration away from deprecated ${d.name}` : 'none',
        d.vulnerable ? `Upgrade vulnerable ${d.name} to a fixed version` : 'none',
      ].filter((a) => a !== 'none'),
      summary: `${d.name} (${d.range} in ${d.declaredIn})${d.vulnerable ? ' is vulnerable' : ''}${d.deprecated ? ' and deprecated' : ''}${d.loose ? ' with an unpinned range' : ''} — likely to conflict on next install.`,
    });
  }
  return sortByScoreDesc(out, (p) => p.probability, (p) => p.target);
}

/* ── 5. architecture-drift ────────────────────────────────────────── */

export function predictArchitectureDrift(e: PredictiveEvidence): Prediction[] {
  const out: Prediction[] = [];
  const a = e.architecture;
  const caveats: string[] = [];
  if (a.driftImports === 0 && a.cycles === 0 && a.layerViolations === 0) return out;

  const byModule = new Map<string, { drift: number; cycles: number }>();
  for (const f of a.driftFiles) {
    const m = e.files.find((x) => x.relPath === f)?.module ?? '(root)';
    const cur = byModule.get(m) ?? { drift: 0, cycles: 0 };
    cur.drift += 1;
    byModule.set(m, cur);
  }
  for (const f of a.cycleFiles) {
    const m = e.files.find((x) => x.relPath === f)?.module ?? '(root)';
    const cur = byModule.get(m) ?? { drift: 0, cycles: 0 };
    cur.cycles += 1;
    byModule.set(m, cur);
  }

  for (const [m, counts] of [...byModule.entries()].sort((x, y) => x[0].localeCompare(y[0]))) {
    const prob = weighted([
      { value: normalize(counts.drift, 6), weight: 0.5 },
      { value: normalize(counts.cycles, 6), weight: 0.5 },
    ]);
    const drivers: EvidencePoint[] = [
      { label: 'drift imports', value: counts.drift, source: 'architecture-health', weight: 0.5 },
      { label: 'cycle participants', value: counts.cycles, source: 'architecture-health', weight: 0.5 },
    ];
    out.push({
      id: genPredictionId('architecture-drift', m),
      kind: 'architecture-drift',
      target: m,
      targetType: 'module',
      severity: severityOf(prob),
      probability: Math.round(prob * 1000) / 1000,
      confidence: conf(2, 2, drivers.filter((d) => Number(d.value) > 0).length, caveats),
      horizon: horizonOf(prob),
      drivers,
      preventiveActions: [
        counts.drift > 0 ? `Gate cross-package imports in ${m} behind the architecture policy` : 'none',
        counts.cycles > 0 ? `Break the dependency cycle(s) involving ${m}` : 'none',
      ].filter((x) => x !== 'none'),
      summary: `${m} has ${counts.drift} drift import(s) and ${counts.cycles} cycle participant(s) — architecture is drifting.`,
    });
  }

  const projProb = weighted([
    { value: normalize(a.driftImports, 12), weight: 0.5 },
    { value: normalize(a.cycles, 4), weight: 0.3 },
    { value: normalize(a.layerViolations, 10), weight: 0.2 },
  ]);
  out.push({
    id: genPredictionId('architecture-drift', 'project'),
    kind: 'architecture-drift',
    target: 'project',
    targetType: 'project',
    severity: severityOf(projProb),
    probability: Math.round(projProb * 1000) / 1000,
    confidence: conf(3, 3, [a.driftImports, a.cycles, a.layerViolations].filter((v) => v > 0).length, caveats),
    horizon: horizonOf(projProb),
    drivers: [
      { label: 'drift imports', value: a.driftImports, source: 'architecture-health', weight: 0.5 },
      { label: 'dependency cycles', value: a.cycles, source: 'architecture-health', weight: 0.3 },
      { label: 'layer violations', value: a.layerViolations, source: 'architecture-health', weight: 0.2 },
    ],
    preventiveActions: a.driftImports > 0 ? ['Add drift-import detection to the CI architecture gate'] : [],
    summary: `Project-level architecture drift: ${a.driftImports} drift imports, ${a.cycles} cycles, ${a.layerViolations} layer violations.`,
  });
  return sortByScoreDesc(out, (p) => p.probability, (p) => p.target);
}

/* ── 6. mission-failure (history-level; live mission via predictor) ── */

export function predictMissionFailure(e: PredictiveEvidence, ctx?: MissionContext): Prediction[] {
  const caveats: string[] = [];
  const missions = e.missions;
  const histRate = missions.length > 0 ? missions.filter((m) => m.executionStatus === 'failed').length / missions.length : 0;
  const taskFailRate = missions.reduce((s, m) => s + m.failedTasks, 0) / Math.max(1, missions.reduce((s, m) => s + m.totalTasks, 0));

  const out: Prediction[] = [];

  if (ctx) {
    const risk = ctx.riskOverall ?? 0.5;
    const quality = ctx.qualityOverall ?? 0.5;
    const acceptance = ctx.taskAcceptanceRate ?? 1;
    const prob = weighted([
      { value: histRate, weight: 0.2 },
      { value: risk, weight: 0.35 },
      { value: 1 - quality, weight: 0.25 },
      { value: 1 - acceptance, weight: 0.2 },
    ]);
    const drivers: EvidencePoint[] = [
      { label: 'historical mission failure rate', value: Math.round(histRate * 1000) / 1000, source: 'mission-store', weight: 0.2 },
      ...(ctx.riskOverall !== null ? [{ label: 'mission risk', value: ctx.riskOverall, source: 'mission-store', weight: 0.35 }] : []),
      ...(ctx.qualityOverall !== null ? [{ label: 'mission quality', value: ctx.qualityOverall, source: 'mission-store', weight: 0.25 }] : []),
      ...(ctx.taskAcceptanceRate !== null ? [{ label: 'task acceptance rate', value: ctx.taskAcceptanceRate, source: 'mission-store', weight: 0.2 }] : []),
    ];
    const required = 4;
    const available = drivers.length;
    out.push({
      id: genPredictionId('mission-failure', ctx.id),
      kind: 'mission-failure',
      target: ctx.id,
      targetType: 'mission',
      severity: severityOf(prob),
      probability: Math.round(prob * 1000) / 1000,
      confidence: conf(required, available, drivers.filter((d) => (Number(d.value) ?? 0) > 0.5 || d.weight === 0.2).length, caveats),
      horizon: horizonOf(prob),
      drivers,
      preventiveActions: [acceptance < 1 ? `Review rejected task proposals for ${ctx.id}` : 'none', risk > 0.6 ? `Reduce mission scope: split ${ctx.id} into smaller missions` : 'none'].filter((x) => x !== 'none'),
      summary: `Mission "${ctx.text.slice(0, 60)}" has ${Math.round(prob * 100)}% projected failure probability (risk ${risk.toFixed(2)}, acceptance ${acceptance.toFixed(2)}).`,
    });
  } else if (missions.length > 0) {
    const prob = weighted([{ value: histRate, weight: 0.5 }, { value: taskFailRate, weight: 0.5 }]);
    if (prob >= 0.15) {
      out.push({
        id: genPredictionId('mission-failure', 'project'),
        kind: 'mission-failure',
        target: 'project',
        targetType: 'project',
        severity: severityOf(prob),
        probability: Math.round(prob * 1000) / 1000,
        confidence: conf(2, 2, missions.filter((m) => m.executionStatus === 'failed').length > 0 || missions.some((m) => m.failedTasks > 0) ? 2 : 0, caveats),
        horizon: horizonOf(prob),
        drivers: [
          { label: 'mission failure rate', value: Math.round(histRate * 1000) / 1000, source: 'mission-store', weight: 0.5 },
          { label: 'task failure rate', value: Math.round(taskFailRate * 1000) / 1000, source: 'mission-store', weight: 0.5 },
        ],
        preventiveActions: [histRate > 0.2 ? 'Tighten mission pre-planning: smaller scopes, earlier risk review' : 'none'].filter((x) => x !== 'none'),
        summary: `${Math.round(prob * 100)}% of recent missions fail (${Math.round(histRate * 100)}% of ${missions.length} missions failed, task failure ${Math.round(taskFailRate * 100)}%).`,
      });
    }
  }
  return out;
}

/* ── 7. proposal-success (live candidate) ─────────────────────────── */

export function predictProposalSuccess(e: PredictiveEvidence, ctx?: CandidateContext): Prediction[] {
  const candidates = e.diagnoses.flatMap((d) => d.candidates);
  const byStrategy = new Map<string, { accepted: number; total: number }>();
  for (const c of candidates) {
    const s = byStrategy.get(c.strategy) ?? { accepted: 0, total: 0 };
    s.total += 1;
    if (c.verdict === 'accepted') s.accepted += 1;
    byStrategy.set(c.strategy, s);
  }
  const out: Prediction[] = [];
  if (!ctx) return out;

  const strat = byStrategy.get(ctx.strategy);
  const stratRate = strat && strat.total > 0 ? strat.accepted / strat.total : 0.5;
  const confVal = ctx.confidenceOverall ?? 0.5;
  const limiterScore = ctx.limiter ? 0.05 : 0.2;
  const prob = weighted([
    { value: stratRate, weight: 0.4 },
    { value: confVal, weight: 0.4 },
    { value: limiterScore, weight: 0.2 },
  ]);
  const drivers: EvidencePoint[] = [
    { label: `historical acceptance for strategy '${ctx.strategy}'`, value: strat ? Math.round(stratRate * 1000) / 1000 : 0.5, source: 'diagnosis-store', weight: 0.4 },
    ...(ctx.confidenceOverall !== null ? [{ label: 'candidate confidence', value: ctx.confidenceOverall, source: 'diagnosis-store', weight: 0.4 }] : []),
    ...(ctx.limiter !== null ? [{ label: 'limiter', value: ctx.limiter, source: 'diagnosis-store', weight: 0.2 }] : []),
  ];

  out.push({
    id: genPredictionId('proposal-success', ctx.id),
    kind: 'proposal-success',
    target: ctx.id,
    targetType: 'candidate',
    severity: severityOf(1 - prob),
    probability: Math.round(prob * 1000) / 1000,
    confidence: conf(3, drivers.length, drivers.filter((d) => (Number(d.value) ?? 0) > 0).length, []),
    horizon: horizonOf(1 - prob),
    drivers,
    preventiveActions: ctx.limiter ? [`Resolve limiter before applying: ${ctx.limiter}`] : [],
    summary: `Proposal ${ctx.id} (${ctx.strategy}) has ${Math.round(prob * 100)}% projected success (strategy history ${stratRate.toFixed(2)}${ctx.limiter ? ', limited by ' + ctx.limiter : ''}).`,
  });
  return out;
}

/* ── 8. diagnosis-likelihood ──────────────────────────────────────── */

export function predictDiagnosisLikelihood(e: PredictiveEvidence): Prediction[] {
  const out: Prediction[] = [];
  const caveats = GIT_NOTE(e);
  for (const f of e.files) {
    if (f.isTest) continue;
    const prob = weighted([
      { value: normalize(f.churn, 30), weight: 0.35 },
      { value: f.complexity, weight: 0.25 },
      { value: normalize(f.markers, 8), weight: 0.2 },
      { value: f.hasTests ? 0 : 1, weight: 0.2 },
    ]);
    if (prob < 0.3) continue;
    const drivers: EvidencePoint[] = [
      { label: 'change frequency', value: f.churn, source: 'git-churn', weight: 0.35 },
      { label: 'structural complexity', value: f.complexity, source: 'scorecard', weight: 0.25 },
      { label: 'debt markers', value: f.markers, source: 'technical-debt', weight: 0.2 },
      { label: 'test coverage gap', value: f.hasTests ? 0 : 1, source: 'scorecard', weight: 0.2 },
    ];
    out.push({
      id: genPredictionId('diagnosis-likelihood', f.relPath),
      kind: 'diagnosis-likelihood',
      target: f.relPath,
      targetType: 'file',
      severity: severityOf(prob),
      probability: Math.round(prob * 1000) / 1000,
      confidence: conf(4, drivers.length, drivers.filter((d) => Number(d.value) > 0).length, caveats),
      horizon: horizonOf(prob),
      drivers,
      preventiveActions: [`Pre-scan ${f.relPath} with the diagnosis engine before the next change`],
      summary: `${f.relPath} is a likely diagnosis target — ${f.churn} changes, complexity ${f.complexity.toFixed(2)}, ${f.markers} markers${f.hasTests ? '' : ', no tests'}.`,
    });
  }
  return sortByScoreDesc(out, (p) => p.probability, (p) => p.target);
}

/* ── 9. workflow-bottleneck ───────────────────────────────────────── */

export function predictWorkflowBottlenecks(e: PredictiveEvidence): Prediction[] {
  const out: Prediction[] = [];
  const byAction = new Map<string, { total: number; failed: number; retries: number; ms: number }>();
  for (const r of e.runs) {
    const a = byAction.get(r.action) ?? { total: 0, failed: 0, retries: 0, ms: 0 };
    a.total += 1;
    if (r.actionStatus === 'failed') a.failed += 1;
    a.retries += r.retries;
    a.ms += r.ms;
    byAction.set(r.action, a);
  }

  for (const [action, s] of [...byAction.entries()].sort((x, y) => x[0].localeCompare(y[0]))) {
    const failRate = s.failed / s.total;
    const avgRetries = s.retries / s.total;
    const avgMs = s.ms / s.total;
    const prob = weighted([
      { value: failRate, weight: 0.4 },
      { value: normalize(avgRetries, 3), weight: 0.3 },
      { value: normalize(avgMs, 60000), weight: 0.3 },
    ]);
    if (prob < 0.2) continue;
    out.push({
      id: genPredictionId('workflow-bottleneck', action),
      kind: 'workflow-bottleneck',
      target: action,
      targetType: 'action',
      severity: severityOf(prob),
      probability: Math.round(prob * 1000) / 1000,
      confidence: conf(3, 3, [failRate, avgRetries, avgMs].filter((v) => v > 0).length, []),
      horizon: horizonOf(prob),
      drivers: [
        { label: 'failure rate', value: Math.round(failRate * 1000) / 1000, source: 'automation-runs', weight: 0.4 },
        { label: 'avg retries', value: Math.round(avgRetries * 100) / 100, source: 'automation-runs', weight: 0.3 },
        { label: 'avg ms', value: Math.round(avgMs), source: 'automation-runs', weight: 0.3 },
      ],
      preventiveActions: [failRate > 0.3 ? `Add retry/backoff or a preflight check to '${action}'` : 'none', avgMs > 30000 ? `Cached or parallelize '${action}' (avg ${Math.round(avgMs)}ms)` : 'none'].filter((x) => x !== 'none'),
      summary: `Action '${action}' is a bottleneck — ${Math.round(failRate * 100)}% failures, ${avgRetries.toFixed(1)} avg retries, ${Math.round(avgMs)}ms avg.`,
    });
  }

  for (const w of e.workflows) {
    const prob = weighted([
      { value: normalize(w.heavyNodes, 5), weight: 0.4 },
      { value: normalize(w.sequentialDepth, 10), weight: 0.3 },
      { value: normalize(w.nodeCount, 20), weight: 0.3 },
    ]);
    if (prob < 0.2) continue;
    out.push({
      id: genPredictionId('workflow-bottleneck', w.id),
      kind: 'workflow-bottleneck',
      target: w.id,
      targetType: 'rule',
      severity: severityOf(prob),
      probability: Math.round(prob * 1000) / 1000,
      confidence: conf(3, 3, [w.heavyNodes, w.sequentialDepth, w.nodeCount].filter((v) => v > 0).length, []),
      horizon: horizonOf(prob),
      drivers: [
        { label: 'heavy nodes', value: w.heavyNodes, source: 'workflow-shape', weight: 0.4 },
        { label: 'sequential depth', value: w.sequentialDepth, source: 'workflow-shape', weight: 0.3 },
        { label: 'node count', value: w.nodeCount, source: 'workflow-shape', weight: 0.3 },
      ],
      preventiveActions: [w.heavyNodes > 2 ? `Parallelize LLM/expensive nodes in workflow ${w.name}` : 'none'].filter((x) => x !== 'none'),
      summary: `Workflow ${w.name} (${w.id}) is ${w.nodeCount} nodes deep with ${w.sequentialDepth} sequential hops and ${w.heavyNodes} expensive nodes — will bottleneck at scale.`,
    });
  }
  return sortByScoreDesc(out, (p) => p.probability, (p) => p.target);
}

/* ── Aggregate ────────────────────────────────────────────────────── */

export function predictAll(e: PredictiveEvidence, missionCtx?: MissionContext, candidateCtx?: CandidateContext): Prediction[] {
  return [
    ...predictFileFailures(e),
    ...predictModuleInstability(e),
    ...predictFutureDebt(e),
    ...predictDependencyConflicts(e),
    ...predictArchitectureDrift(e),
    ...predictMissionFailure(e, missionCtx),
    ...predictProposalSuccess(e, candidateCtx),
    ...predictDiagnosisLikelihood(e),
    ...predictWorkflowBottlenecks(e),
  ];
}
