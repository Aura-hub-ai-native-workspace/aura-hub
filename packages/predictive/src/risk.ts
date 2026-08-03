/**
 * Risk Engine — a normalized, explainable risk profile for the project.
 * ==================================================================
 * Aggregates six real dimensions into a 0..1 overall risk:
 *
 *   change-volume — git churn intensity (commits + changed-file count)
 *   structural    — architecture cycles / violations / drift / chains
 *   debt          — markers, large spans, repeated logic
 *   security      — critical + high findings, secrets, vulnerable deps
 *   coverage      — the inverse of test + doc coverage
 *   behavioral    — historical failure rate across missions, diagnoses,
 *                   and automation runs
 *
 * Every dimension carries its evidence so the score is traceable. Per-
 * file and per-module risk feed the file-failure / module-instability
 * predictors. All math is deterministic.
 */

import type {
  EvidencePoint,
  FileSignal,
  ModuleSignal,
  PredictiveEvidence,
  RiskDimension,
  RiskProfile,
} from './types';
import { clamp01, normalize, riskLevelOf, sortByScoreDesc, weighted } from './score';

/* ── Reference maxima (documented, fixed) ─────────────────────────── */

const MAX_CHANGES = 30;        // file change count considered "max churn"
const MAX_COMMITS = 500;       // commit volume ceiling for change-volume
const MAX_DEBT_ITEMS = 400;    // debt items ceiling
const MAX_SEC_FINDINGS = 20;   // critical/high findings ceiling

export function fileRisk(f: FileSignal, fileChurnMax = MAX_CHANGES): { risk: number; drivers: string[] } {
  const churn = normalize(f.churn, fileChurnMax);
  const drivers: string[] = [];
  if (f.churn > 0) drivers.push(`${f.churn} changes in churn window`);
  const parts: { value: number; weight: number }[] = [
    { value: churn, weight: 0.3 },
    { value: f.complexity, weight: 0.2 },
    { value: normalize(f.markers, 8), weight: 0.15 },
    { value: normalize(f.dependents.length, 20), weight: 0.15 },
    { value: normalize(f.diagnosisCount, 5), weight: 0.1 },
    { value: normalize(f.diagnosisFired, 5), weight: 0.1 },
    { value: normalize(f.securityFindings, 3), weight: 0.1 },
  ];
  const risk = weighted(parts);
  if (f.complexity >= 0.7) drivers.push('high structural complexity');
  if (f.markers > 0) drivers.push(`${f.markers} debt markers`);
  if (f.dependents.length >= 5) drivers.push(`${f.dependents.length} dependents`);
  if (f.diagnosisFired > 0) drivers.push(`${f.diagnosisFired} prior diagnosis hits`);
  if (f.securityFindings > 0) drivers.push(`${f.securityFindings} security findings`);
  if (!f.hasTests) drivers.push('no related tests');
  return { risk, drivers };
}

function changeVolume(evidence: PredictiveEvidence, points: EvidencePoint[]): number {
  const g = evidence.git;
  if (!g.available) {
    points.push({ label: 'git history unavailable', value: false, source: 'git-churn', weight: 1 });
    return 0.4; // unknown churn is a mild risk, not zero
  }
  const commits = normalize(g.totalCommits, MAX_COMMITS);
  const touched = Object.keys(g.byFile).length;
  const files = normalize(touched, 500);
  const score = weighted([{ value: commits, weight: 0.5 }, { value: files, weight: 0.5 }]);
  points.push({ label: `${g.totalCommits} commits, ${touched} files touched since ${g.since}`, value: Math.round(score * 100) / 100, source: 'git-churn', weight: 1 });
  return score;
}

function structural(evidence: PredictiveEvidence, points: EvidencePoint[]): number {
  const a = evidence.architecture;
  const score = weighted([
    { value: normalize(a.cycles, 4), weight: 0.25 },
    { value: normalize(a.nodesInCycles, 30), weight: 0.15 },
    { value: normalize(a.layerViolations, 10), weight: 0.2 },
    { value: normalize(a.driftImports, 12), weight: 0.2 },
    { value: normalize(Math.max(0, a.longestChain - 8), 12), weight: 0.1 },
    { value: normalize(a.unusedModules, 30), weight: 0.1 },
  ]);
  points.push({
    label: `${a.cycles} cycles, ${a.layerViolations} layer violations, ${a.driftImports} drift imports, ${a.longestChain}-hop chain`,
    value: Math.round(score * 100) / 100,
    source: 'architecture-health',
    weight: 1,
  });
  return score;
}

function debt(evidence: PredictiveEvidence, points: EvidencePoint[]): number {
  const d = evidence.debt;
  const score = normalize(d.totalItems, MAX_DEBT_ITEMS) * 0.6 + normalize(d.markers.length, 40) * 0.4;
  points.push({ label: `${d.totalItems} debt items, ${d.markers.length} markers`, value: Math.round(score * 100) / 100, source: 'technical-debt', weight: 1 });
  return score;
}

function security(evidence: PredictiveEvidence, points: EvidencePoint[]): number {
  const s = evidence.security;
  const score = weighted([
    { value: normalize(s.criticalHigh, MAX_SEC_FINDINGS), weight: 0.7 },
    { value: normalize(s.deprecatedDependencies.length, 10), weight: 0.3 },
  ]);
  points.push({ label: `${s.criticalHigh} critical/high findings, ${s.deprecatedDependencies.length} deprecated deps`, value: Math.round(score * 100) / 100, source: 'security-review', weight: 1 });
  return score;
}

function coverage(evidence: PredictiveEvidence, points: EvidencePoint[]): number {
  const src = evidence.files.filter((f) => !f.isTest);
  const tested = src.filter((f) => f.hasTests).length;
  const testCoverage = src.length > 0 ? tested / src.length : 0;
  const d = evidence.docs.coverage;
  const docCoverage = d.packagesTotal > 0 ? d.packagesWithReadme / d.packagesTotal : 1;
  const score = (1 - testCoverage) * 0.7 + (1 - docCoverage) * 0.3;
  points.push({
    label: `${tested}/${src.length} source files have related tests; ${d.packagesWithReadme}/${d.packagesTotal} packages have READMEs`,
    value: Math.round(score * 100) / 100,
    source: 'scorecard',
    weight: 1,
  });
  return clamp01(score);
}

function behavioral(evidence: PredictiveEvidence, points: EvidencePoint[]): number {
  const missions = evidence.missions;
  const missionFail = missions.length > 0 ? missions.filter((m) => m.executionStatus === 'failed').length / missions.length : 0;
  const missionTaskFail = missions.reduce((s, m) => s + m.failedTasks, 0) / Math.max(1, missions.reduce((s, m) => s + m.totalTasks, 0));
  const diagFired = evidence.diagnoses.length > 0 ? evidence.diagnoses.filter((d) => d.category !== 'unknown').length / evidence.diagnoses.length : 0;
  const runs = evidence.runs;
  const runFail = runs.length > 0 ? runs.filter((r) => r.status === 'failed').length / runs.length : 0;
  const score = weighted([
    { value: missionFail, weight: 0.3 },
    { value: missionTaskFail, weight: 0.3 },
    { value: diagFired, weight: 0.2 },
    { value: runFail, weight: 0.2 },
  ]);
  points.push({
    label: `${missions.length} missions (${Math.round(missionFail * 100)}% failed), ${evidence.diagnoses.length} diagnoses (${Math.round(diagFired * 100)}% fired), ${runs.length} automation runs (${Math.round(runFail * 100)}% failed)`,
    value: Math.round(score * 100) / 100,
    source: 'platform-history',
    weight: 1,
  });
  return score;
}

export function computeRiskProfile(evidence: PredictiveEvidence): RiskProfile {
  const dimensions: RiskDimension[] = [];

  const runDim = (key: string, label: string, fn: (e: PredictiveEvidence, p: EvidencePoint[]) => number): void => {
    const points: EvidencePoint[] = [];
    const score = fn(evidence, points);
    dimensions.push({ key, label, score: Math.round(clamp01(score) * 1000) / 1000, evidence: points });
  };

  runDim('change-volume', 'Change volume', changeVolume);
  runDim('structural', 'Architecture stability', structural);
  runDim('debt', 'Technical debt', debt);
  runDim('security', 'Security posture', security);
  runDim('coverage', 'Coverage gap', coverage);
  runDim('behavioral', 'Historical failures', behavioral);

  const overall = weighted(dimensions.map((d) => ({ value: d.score, weight: 1 })));
  const weightedDims = dimensions.map((d) => ({ ...d, score: d.score }));
  const topFiles = sortByScoreDesc(
    evidence.files.filter((f) => !f.isTest),
    (f) => fileRisk(f).risk,
    (f) => f.relPath,
  )
    .slice(0, 12)
    .map((f) => {
      const r = fileRisk(f);
      return { file: f.relPath, risk: Math.round(r.risk * 1000) / 1000, drivers: r.drivers.slice(0, 4) };
    });

  const moduleAgg = new Map<string, { module: ModuleSignal; risk: number; files: FileSignal[] }>();
  for (const f of evidence.files) {
    if (f.isTest) continue;
    const name = f.module ?? '(root)';
    const existing = moduleAgg.get(name);
    const ms = evidence.modules.find((m) => m.name === name);
    const risk = fileRisk(f).risk;
    if (existing) {
      existing.files.push(f);
      existing.risk = Math.max(existing.risk, risk);
    } else {
      moduleAgg.set(name, { module: ms ?? { name, relDir: name, churn: 0, files: 0 }, risk, files: [f] });
    }
  }
  const topModules = sortByScoreDesc(
    [...moduleAgg.entries()].map(([name, v]) => ({ module: name, risk: v.risk, churn: v.module.churn, files: v.files.length, drivers: v.files.slice(0, 3).map((f) => f.relPath) })),
    (m) => m.risk,
    (m) => m.module,
  )
    .slice(0, 8)
    .map((m) => ({ module: m.module, risk: Math.round(m.risk * 1000) / 1000, drivers: m.drivers }));

  return {
    overall: Math.round(clamp01(overall) * 1000) / 1000,
    level: riskLevelOf(overall),
    dimensions: weightedDims,
    topFiles,
    topModules,
  };
}
