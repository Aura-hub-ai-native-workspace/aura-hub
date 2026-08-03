/**
 * Predictive Engineering Platform — E2E verification.
 * ==================================================================
 * Runs the FULL deterministic pipeline against the real aura-hub
 * workspace and asserts the sealed contract holds:
 *
 *   1. evidence is real + serializable (JSON round-trip)
 *   2. report is deterministic (same evidence → same report)
 *   3. all nine prediction kinds are exercised over real signals
 *   4. hotspots / regressions / architectureRisks are ranked
 *   5. preventive actions are deduplicated + sorted
 *   6. mission-failure + proposal-success live predictors work
 *   7. impact + simulation are reproducible
 *   8. feature matrix is ML-ready (rows + binary labels)
 *
 * Run:  node scripts/run-ts.mjs scripts/verify-predictive.ts   (from the repository root)
 */

import { collectPredictiveEvidence, missionContextFrom, candidateContextFrom } from '@aura/ai-service/predictive';
import { PredictiveEngine } from '@aura/predictive';
import type { CandidateContext, MissionContext, Prediction, PredictionReport } from '@aura/predictive';
import { MissionStore } from '@aura/ai-service/mission/store';
import { DiagnosisStore } from '@aura/ai-service/diagnosis/store';

const ROOT = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const PROJECT_ID = 'aura-hub';

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = ''): void => {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

console.log('Collecting real predictive evidence from', ROOT, '…');

const t0 = Date.now();
const evidence = await collectPredictiveEvidence({ projectId: PROJECT_ID, projectPath: ROOT });
console.log(`  evidence collected in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

/* 1. evidence shape + serializability */
ok('evidence files>0', evidence.files.length > 0, `got ${evidence.files.length}`);
ok('evidence has git', 'available' in evidence.git);
ok('evidence has architecture', evidence.architecture.sourceFiles > 0, `sourceFiles=${evidence.architecture.sourceFiles}`);
ok('evidence has dependencies', evidence.dependencies.length > 0, `got ${evidence.dependencies.length}`);
const roundTrip = JSON.parse(JSON.stringify(evidence));
ok('evidence JSON round-trip', roundTrip.files.length === evidence.files.length);

/* sample files: pick the file with the most dependents (blast radius) */
const hot = [...evidence.files].sort((a, b) => b.dependents.length - a.dependents.length || b.churn - a.churn).find((f) => !f.isTest);
console.log(`  git available: ${evidence.git.available} — hottest/highest-blast file: ${hot?.relPath ?? 'none'} (${hot?.dependents.length ?? 0} dependents)`);
ok('git-unavailable sets honest fallback', !evidence.git.available === (evidence.git.totalCommits === 0));

/* 2. determinism */
const engine = new PredictiveEngine(evidence);
const reportA: PredictionReport = engine.report();
const reportB: PredictionReport = engine.report();
ok('report deterministic', JSON.stringify(reportA) === JSON.stringify(reportB));

/* 3. risk profile */
ok('risk overall in [0,1]', reportA.risk.overall >= 0 && reportA.risk.overall <= 1, `=${reportA.risk.overall}`);
ok('risk has 6 dimensions', reportA.risk.dimensions.length === 6, `got ${reportA.risk.dimensions.length}`);
ok('risk level is deterministic grade', ['low', 'medium', 'high', 'critical'].includes(reportA.risk.level), reportA.risk.level);
console.log('  risk dimensions:', reportA.risk.dimensions.map((d) => `${d.label}=${d.score}`).join(' '));

/* 4. prediction kinds present */
const kinds = new Set(reportA.predictions.map((p) => p.kind));
console.log('  prediction kinds produced:', [...kinds].join(', '));
ok('file-failure predicted', kinds.has('file-failure'));
ok('module-instability predicted', kinds.has('module-instability'));
ok('dependency-conflict predicted', kinds.has('dependency-conflict'));
ok('future-tech-debt predicted', kinds.has('future-tech-debt'));
ok('diagnosis-likelihood predicted', kinds.has('diagnosis-likelihood'));
ok('architecture-drift predicted', kinds.has('architecture-drift'));
ok('workflow-bottleneck predicted', kinds.has('workflow-bottleneck'));
ok('mission-failure project predicted only with history', kinds.has('mission-failure') === (evidence.missions.length > 0), `missions=${evidence.missions.length}`);
ok('proposal-success NOT predicted without candidate ctx', !reportA.predictions.some((p) => p.kind === 'proposal-success'));

/* 5. rankings + preventive actions */
ok('hotspots ranked desc', reportA.hotspots.every((p, i, a) => i === 0 || a[i - 1].probability >= p.probability), `count=${reportA.hotspots.length}`);
ok('regressions ranked desc', reportA.regressions.every((p, i, a) => i === 0 || a[i - 1].probability >= p.probability));
ok('architectureRisks ranked desc', reportA.architectureRisks.every((p, i, a) => i === 0 || a[i - 1].probability >= p.probability));
const sortedActions = reportA.preventiveActions.every((s, i, a) => i === 0 || a[i - 1] <= s);
const uniqueActions = new Set(reportA.preventiveActions).size === reportA.preventiveActions.length;
ok('preventive actions sorted + deduped', sortedActions && uniqueActions, `count=${reportA.preventiveActions.length}`);
ok('every prediction has an id', reportA.predictions.every((p) => typeof p.id === 'string' && p.id.startsWith('pred-')));
ok('every prediction confidence in [0,1]', reportA.predictions.every((p) => p.confidence.score >= 0 && p.confidence.score <= 1));
ok('report source is deterministic', reportA.source === 'deterministic');

/* 6. live-context predictors (Mission Control + Diagnosis consumers) */
const syntheticMission: MissionContext = {
  id: 'mission-verify',
  text: 'Add a cache to the retrieval layer and wire tests',
  category: 'feature',
  riskOverall: 0.7,
  qualityOverall: 0.4,
  taskAcceptanceRate: 0.6,
  tasks: [],
};
const mf = engine.missionFailure(syntheticMission);
ok('mission-failure prediction produced', mf.kind === 'mission-failure' && mf.target === 'mission-verify', `${mf.target}`);
ok('mission-failure probability in [0,1]', mf.probability >= 0 && mf.probability <= 1, `=${mf.probability}`);
ok('mission-failure has drivers', mf.drivers.length >= 1, `drivers=${mf.drivers.length}`);

const syntheticCandidate: CandidateContext = {
  id: 'diag-verify:A',
  strategy: 'minimal-fix',
  targetFile: hot?.relPath ?? 'src/index.ts',
  confidenceOverall: 0.8,
  limiter: null,
  dependencies: [],
};
const ps = engine.proposalSuccess(syntheticCandidate);
ok('proposal-success prediction produced', ps.kind === 'proposal-success' && ps.target === 'diag-verify:A', `${ps.target}`);
ok('proposal-success probability in [0,1]', ps.probability >= 0 && ps.probability <= 1, `=${ps.probability}`);

/* real mission context, if present on disk */
const realMissions = new MissionStore().list(PROJECT_ID);
const realMission = realMissions[0] ? missionContextFrom(PROJECT_ID, realMissions[0].id) : null;
if (realMission) {
  ok('real mission context loads', realMission.text.length > 0, `mission=${realMission.id}`);
  const realMF = engine.missionFailure(realMission);
  ok('real mission-failure prediction', realMF.kind === 'mission-failure' && realMF.probability >= 0 && realMF.probability <= 1, `p=${realMF.probability}`);
}
const realDiags = new DiagnosisStore().list(PROJECT_ID);
let realCandidate: ReturnType<typeof candidateContextFrom> = null;
for (const d of realDiags) {
  const rec = new DiagnosisStore().get(PROJECT_ID, d.id);
  const c = rec?.candidates[0];
  if (c) {
    realCandidate = candidateContextFrom(PROJECT_ID, d.id, c.id);
    if (realCandidate) break;
  }
}
if (realCandidate) {
  ok('real candidate context loads', realCandidate.strategy.length > 0, `candidate=${realCandidate.id}`);
  const realPS = engine.proposalSuccess(realCandidate);
  ok('real proposal-success prediction', realPS.kind === 'proposal-success' && realPS.probability >= 0 && realPS.probability <= 1, `p=${realPS.probability}`);
}

/* 7. impact + simulation */
if (hot) {
  const impact = engine.impact(hot.relPath);
  ok('impact lists direct dependents', Array.isArray(impact.directDependents), `dependents=${impact.directDependents.length}`);
  ok('impact riskScore in [0,1]', impact.riskScore >= 0 && impact.riskScore <= 1, `=${impact.riskScore}`);
  const sim = engine.simulate(hot.relPath, 'modify');
  ok('simulation has projection', sim.projection.withoutAction !== undefined && sim.projection.withPreventive !== undefined);
  ok('simulation deterministic', JSON.stringify(sim) === JSON.stringify(engine.simulate(hot.relPath, 'modify')));
  if (impact.relationCount > 0) {
    ok('simulation riskDelta signed (modify raises risk)', sim.riskDelta > 0, `=${sim.riskDelta}`);
    const simRemove = engine.simulate(hot.relPath, 'remove');
    ok('simulation riskDelta signed (remove lowers risk)', simRemove.riskDelta < 0, `=${simRemove.riskDelta}`);
  }
  console.log(`  impact ${hot.relPath}: ${impact.relationCount} relations, simulation riskDelta ${sim.riskDelta}`);
}

/* 8. ML-ready matrix */
const matrix = engine.features();
ok('feature matrix has rows', matrix.rows.length === evidence.files.length, `rows=${matrix.rows.length}`);
ok('feature matrix has columns', matrix.featureColumns.length >= 8, `cols=${matrix.featureColumns.join(',')}`);
ok('feature matrix labels binary', matrix.labels.every((l) => l === 0 || l === 1));

/* 9. explain (AI Chat surface) — deterministic text */
const explain = (() => {
  const r = reportA;
  return [
    `Overall risk: ${r.risk.level} (${Math.round(r.risk.overall * 100)}%).`,
    `Top hotspots: ${r.hotspots.slice(0, 3).map((p) => p.target).join(', ')}.`,
    `Actions: ${r.preventiveActions.slice(0, 3).join('; ')}.`,
  ].join('\n');
})();
ok('explain text produced', explain.length > 20, `len=${explain.length}`);

console.log(`\nRESULT: ${pass} passed, ${fail} failed (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
if (fail > 0) process.exit(1);

/* keep types referenced for typecheck of unused-name cases */
void ([] as Prediction[]);
