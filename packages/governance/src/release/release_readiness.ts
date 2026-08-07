/**
 * Release Readiness
 * ==================================================================
 * Real readiness assessment across six dimensions:
 *   • build        — actual `tsc --noEmit` runs per package
 *   • testing      — real test file coverage + test scripts
 *   • security     — security engine findings
 *   • documentation — documentation engine coverage
 *   • deployment   — CI pipelines, build scripts, packaging config
 *   • architecture — architecture engine score
 * Produces a weighted Release Readiness Score with per-dimension
 * status, blockers and recommendations.
 */

import path from 'node:path';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { scanWorkspace, findPackages } from '../core/scan';
import { makeScore, countToPart } from '../core/score';
import { getArchitectureHealth } from '../architecture/architecture_governance';
import { getSecurityReport } from '../security/security_review';
import { getDocumentationHealth } from '../docs/documentation_governance';
import type { ReportMeta } from '../core/types';

export type ReadinessDimension = 'build' | 'testing' | 'security' | 'documentation' | 'deployment' | 'architecture';

export interface ReadinessDimensionResult {
  dimension: ReadinessDimension;
  status: 'pass' | 'warn' | 'fail' | 'unknown';
  score: number; // 0..100
  evidence: string[];
}

export interface ReleaseReadinessReport {
  overallScore: number;
  grade: string;
  dimensions: ReadinessDimensionResult[];
  blockers: string[];
  recommendations: string[];
  build: {
    stable: boolean;
    packagesChecked: number;
    failures: { package: string; error: string }[];
    runs: { package: string; ok: boolean; ms: number }[];
  };
  meta: ReportMeta;
}

export interface ReleaseInput {
  projectPath: string;
  /** Max packages to typecheck (slow). 0 = skip builds. */
  maxBuilds?: number;
  runNpmAudit?: boolean;
}

export async function getReleaseReadiness(input: ReleaseInput): Promise<ReleaseReadinessReport> {
  const t0 = Date.now();
  const maxBuilds = input.maxBuilds ?? 6;
  const ws = await scanWorkspace(input.projectPath);
  const packages = findPackages(ws);
  const unavailable: string[] = [];

  // ── Build stability (real tsc runs) ───────────────────────────────
  const tscCandidates = [
    path.posix.join(input.projectPath, 'node_modules', '.bin', 'tsc.cmd'),
    path.posix.join(input.projectPath, 'node_modules', 'typescript', 'bin', 'tsc'),
  ];
  const tscBin = tscCandidates.find((c) => existsSync(c));
  const buildRuns: ReleaseReadinessReport['build']['runs'] = [];
  const buildFailures: ReleaseReadinessReport['build']['failures'] = [];
  let buildStable = true;

  if (!tscBin) {
    unavailable.push('typescript not installed — build checks skipped');
    buildStable = false;
  } else {
    const buildable = packages.filter((p) => p.hasTsconfig).slice(0, maxBuilds);
    for (const p of buildable) {
      const tsconfig = path.posix.join(p.dir, 'tsconfig.json');
      const result = await runTsc(tscBin, tsconfig);
      buildRuns.push({ package: p.name, ok: result.ok, ms: result.ms });
      if (!result.ok) {
        buildStable = false;
        buildFailures.push({ package: p.name, error: result.error.slice(0, 400) });
      }
    }
    if (buildable.length === 0) unavailable.push('no tsconfig.json found to build');
  }

  // ── Testing readiness ─────────────────────────────────────────────
  const sourceFiles = ws.files.filter((f) => f.isSource && !f.isTest);
  const testFiles = ws.files.filter((f) => f.isTest);
  const testRatio = sourceFiles.length > 0 ? testFiles.length / sourceFiles.length : 0;
  const testedPackages = packages.filter((p) => p.hasTests || p.scripts.test).length;
  const packageRatio = packages.length > 0 ? testedPackages / packages.length : 0;

  // ── Security / docs / architecture ────────────────────────────────
  const sec = await getSecurityReport({ projectPath: input.projectPath, runNpmAudit: input.runNpmAudit });
  unavailable.push(...sec.meta.unavailable);
  const docs = await getDocumentationHealth({ projectPath: input.projectPath });
  const arch = await getArchitectureHealth({ projectPath: input.projectPath });

  // ── Deployment readiness ──────────────────────────────────────────
  const ciFiles = ws.files.filter((f) => /\.github\/workflows\/.*\.(yml|yaml)$/.test(f.relPath) || /(dockerfile|docker-compose|\.tauri\.conf|\.github)/i.test(f.relPath));
  const hasBuildScript = packages.some((p) => p.scripts.build) || existsSync(path.posix.join(input.projectPath, 'vite.config.ts'));
  const hasCi = ciFiles.length > 0;
  const hasPackageManagerFile = existsSync(path.posix.join(input.projectPath, 'package-lock.json')) || existsSync(path.posix.join(input.projectPath, 'pnpm-lock.yaml')) || existsSync(path.posix.join(input.projectPath, 'yarn.lock'));

  // ── Dimension scoring ─────────────────────────────────────────────
  const buildScore = buildRuns.length > 0 ? Math.round((buildRuns.filter((r) => r.ok).length / buildRuns.length) * 100) : buildStable ? 100 : 40;
  const testingScore = makeScore([
    { label: 'Test file ratio', weight: 0.6, value: Math.min(1, testRatio), evidence: [`${testFiles.length} tests / ${sourceFiles.length} sources`] },
    { label: 'Packages tested', weight: 0.4, value: packageRatio, evidence: [`${testedPackages}/${packages.length} packages`] },
  ], 'Real test file inventory.');
  const securityScore = makeScore([
    countToPart('No critical/high findings', 0.6, sec.bySeverity.critical + sec.bySeverity.high, 1, [`${sec.bySeverity.critical + sec.bySeverity.high} critical/high`]),
    countToPart('No secrets', 0.4, sec.secretsCount, 1, [`${sec.secretsCount} secrets`]),
  ], 'Security engine output.');
  const docsCoverage = docs.coverage.packagesTotal > 0 ? docs.coverage.packagesWithReadme / docs.coverage.packagesTotal : 1;
  const documentationScore = makeScore([
    { label: 'README coverage', weight: 0.5, value: docsCoverage, evidence: [`${docs.coverage.packagesWithReadme}/${docs.coverage.packagesTotal} packages`] },
    countToPart('No doc issues', 0.5, docs.issues.length, 5, [`${docs.issues.length} doc issues`]),
  ], 'Documentation engine output.');
  const deploymentScore = makeScore([
    { label: 'CI pipeline', weight: 0.4, value: hasCi ? 1 : 0, evidence: hasCi ? [`${ciFiles.length} CI workflow files`] : ['no .github/workflows'] },
    { label: 'Build script', weight: 0.3, value: hasBuildScript ? 1 : 0, evidence: ['package.json build script or vite.config present'] },
    { label: 'Lockfile', weight: 0.3, value: hasPackageManagerFile ? 1 : 0, evidence: ['package lockfile present'] },
  ], 'Deployment artifacts on disk.');
  const architectureScore = makeScore(
    [
      { label: 'Architecture health', weight: 1, value: arch.overall.value / 100, evidence: [`architecture ${arch.overall.grade} (${arch.overall.value}/100)`] },
    ],
    'Architecture engine output.',
  );

  const dimensions: ReadinessDimensionResult[] = [
    {
      dimension: 'build',
      status: buildStable && buildRuns.length > 0 ? 'pass' : buildRuns.length === 0 ? 'unknown' : 'fail',
      score: buildScore,
      evidence: buildRuns.map((r) => `${r.package}: ${r.ok ? 'pass' : 'fail'} (${r.ms}ms)`) ,
    },
    { dimension: 'testing', status: testingScore.value >= 60 ? 'pass' : testingScore.value >= 35 ? 'warn' : 'fail', score: testingScore.value, evidence: testingScore.parts.map((p) => `${p.label}: ${p.evidence.join('; ')}`) },
    { dimension: 'security', status: securityScore.value >= 60 ? 'pass' : securityScore.value >= 35 ? 'warn' : 'fail', score: securityScore.value, evidence: securityScore.parts.map((p) => p.evidence.join('; ')) },
    { dimension: 'documentation', status: documentationScore.value >= 60 ? 'pass' : documentationScore.value >= 35 ? 'warn' : 'fail', score: documentationScore.value, evidence: documentationScore.parts.map((p) => p.evidence.join('; ')) },
    { dimension: 'deployment', status: deploymentScore.value >= 60 ? 'pass' : deploymentScore.value >= 35 ? 'warn' : 'fail', score: deploymentScore.value, evidence: deploymentScore.parts.map((p) => p.evidence.join('; ')) },
    { dimension: 'architecture', status: architectureScore.value >= 60 ? 'pass' : architectureScore.value >= 35 ? 'warn' : 'fail', score: architectureScore.value, evidence: architectureScore.parts.map((p) => p.evidence.join('; ')) },
  ];

  const overallScore = Math.round(
    dimensions.reduce((s, d) => s + d.score * dimensionWeight(d.dimension), 0) / dimensions.reduce((s, d) => s + dimensionWeight(d.dimension), 0),
  );

  const blockers = dimensions
    .filter((d) => d.status === 'fail')
    .map((d) => `${d.dimension} is failing (${d.score}/100)`)
    .concat(buildFailures.map((f) => `package ${f.package} does not typecheck: ${f.error.split('\n')[0]}`))
    .slice(0, 8);

  const recommendations = dimensions
    .filter((d) => d.status !== 'pass')
    .map((d) => `Improve ${d.dimension} readiness before release (${d.score}/100).`);

  return {
    overallScore,
    grade: overallScore >= 85 ? 'A' : overallScore >= 70 ? 'B' : overallScore >= 50 ? 'C' : overallScore >= 30 ? 'D' : 'F',
    dimensions,
    blockers,
    recommendations,
    build: {
      stable: buildStable,
      packagesChecked: buildRuns.length,
      failures: buildFailures,
      runs: buildRuns,
    },
    meta: {
      root: ws.root,
      analyzedFiles: ws.files.length,
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - t0,
      unavailable,
    },
  };
}

function dimensionWeight(d: ReadinessDimension): number {
  switch (d) {
    case 'build': return 0.25;
    case 'security': return 0.25;
    case 'testing': return 0.15;
    case 'architecture': return 0.15;
    case 'deployment': return 0.1;
    case 'documentation': return 0.1;
  }
}

function runTsc(tscBin: string, tsconfig: string): Promise<{ ok: boolean; ms: number; error: string }> {
  return new Promise((resolve) => {
    const t = Date.now();
    execFile(tscBin, ['-p', tsconfig, '--noEmit'], { timeout: 120000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const ms = Date.now() - t;
      if (err) {
        resolve({ ok: false, ms, error: stderr || stdout || err.message });
      } else {
        resolve({ ok: true, ms, error: '' });
      }
    });
  });
}
