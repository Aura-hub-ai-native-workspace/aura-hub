/**
 * Engineering Scorecard
 * ==================================================================
 * Eight explainable dimensions, each a weighted mean of measurable
 * parts with real evidence:
 *   architecture · security · testing · performance · documentation ·
 *   knowledge · maintainability · technical debt
 * Composed from the real engine outputs (architecture, security, debt,
 * docs) plus measured code-shape and test-coverage signals. No score
 * exists without an explanation traceable to analysis data.
 */

import { scanWorkspace, findPackages } from '../core/scan';
import { analyzeCodeShape, complexityStats } from '../core/codeShape';
import { makeScore, countToPart } from '../core/score';
import { getArchitectureHealth } from '../architecture/architecture_governance';
import { getSecurityReport } from '../security/security_review';
import { getTechnicalDebt } from '../debt/technical_debt_engine';
import { getDocumentationHealth } from '../docs/documentation_governance';
import { FullStackKnowledgeEngine } from '@aura/knowledge-fullstack';
import type { Score } from '../core/types';

export type ScoreDimension = 'architecture' | 'security' | 'testing' | 'performance' | 'documentation' | 'knowledge' | 'maintainability' | 'technical-debt';

export interface ScorecardDimension {
  dimension: ScoreDimension;
  score: Score;
  summary: string;
}

export interface EngineeringScorecard {
  overall: Score;
  dimensions: ScorecardDimension[];
  meta: {
    root: string;
    generatedAt: string;
    durationMs: number;
    analyzedFiles: number;
    unavailable: string[];
  };
}

export interface ScorecardInput {
  projectPath: string;
  runNpmAudit?: boolean;
}

export async function getEngineeringScorecard(input: ScorecardInput): Promise<EngineeringScorecard> {
  const t0 = Date.now();
  const ws = await scanWorkspace(input.projectPath);
  const packages = findPackages(ws);
  const sourceFiles = ws.files.filter((f) => f.isSource && !f.isTest);
  const testFiles = ws.files.filter((f) => f.isTest && (f.isSource || /\.(ts|tsx|js|jsx)$/.test(f.ext)));

  const unavailable: string[] = [];

  // ── Architecture ──────────────────────────────────────────────────
  const arch = await getArchitectureHealth({ projectPath: input.projectPath });
  const architectureScore = arch.overall;
  const architectureSummary = `Derived from ${arch.metrics.sourceFiles} modules: ${arch.metrics.cycles} cycles, ${arch.metrics.layerViolations} layer violations, ${arch.metrics.unusedModules} unused, ${arch.metrics.driftImports} drift imports, ${arch.metrics.longestChain}-hop longest chain.`;

  // ── Security ──────────────────────────────────────────────────────
  const sec = await getSecurityReport({ projectPath: input.projectPath, runNpmAudit: input.runNpmAudit });
  unavailable.push(...sec.meta.unavailable);
  const severityWeight = (f: typeof sec.findings[number]): number =>
    f.severity === 'critical' ? 5 : f.severity === 'high' ? 3 : f.severity === 'medium' ? 1.5 : 0.5;
  const sevSum = sec.findings.reduce((s, f) => s + severityWeight(f), 0);
  const securityScore = makeScore(
    [
      countToPart('No critical/high findings', 0.45, sec.bySeverity.critical + sec.bySeverity.high, 2, [`${sec.bySeverity.critical} critical, ${sec.bySeverity.high} high findings`]),
      countToPart('No secrets', 0.3, sec.secretsCount, 1, [`${sec.secretsCount} secrets found`]),
      countToPart('No dependency issues', 0.25, sec.byType['dependency-vulnerability'], 3, [`${sec.byType['dependency-vulnerability']} deprecated/vulnerable deps`]),
    ],
    `Security derives from real pattern scans of ${sec.meta.analyzedFiles} files (severity-weighted sum ${Math.round(sevSum)}).`,
  );

  // ── Testing ───────────────────────────────────────────────────────
  const testRatio = sourceFiles.length > 0 ? testFiles.length / sourceFiles.length : 0;
  const packagesWithTests = packages.filter((p) => p.hasTests).length;
  const packageTestRatio = packages.length > 0 ? packagesWithTests / packages.length : 0;
  const testingScore = makeScore(
    [
      { label: 'Test file ratio', weight: 0.5, value: Math.min(1, testRatio), evidence: [`${testFiles.length} test files vs ${sourceFiles.length} source files`] },
      { label: 'Packages with tests', weight: 0.3, value: packageTestRatio, evidence: [`${packagesWithTests}/${packages.length} packages have test files`] },
      { label: 'Test tooling present', weight: 0.2, value: packages.some((p) => p.scripts.test || p.scripts['test:unit']) ? 1 : 0, evidence: [`test script found in ${packages.filter((p) => p.scripts.test || p.scripts['test:unit']).map((p) => p.name).join(', ') || 'no package'}`] },
    ],
    `Testing derives from real files: ${testFiles.length} test files, ${packagesWithTests}/${packages.length} tested packages.`,
  );

  // ── Performance ───────────────────────────────────────────────────
  const shapes = sourceFiles.map((f) => analyzeCodeShape(f.text));
  const largeFunctions = shapes.reduce((s, x) => s + x.functionsOverLines, 0);
  const complexFunctions = shapes.reduce((s, x) => s + complexityStats(x).complexFunctions, 0);
  const bigFiles = sourceFiles.filter((f) => f.lines > 600).length;
  const avgFileLines = sourceFiles.length > 0 ? sourceFiles.reduce((s, f) => s + f.lines, 0) / sourceFiles.length : 0;
  const performanceScore = makeScore(
    [
      countToPart('No oversized functions', 0.35, largeFunctions, 5, [`${largeFunctions} functions over 80 lines`]),
      countToPart('No high-complexity functions', 0.3, complexFunctions, 5, [`${complexFunctions} functions with complexity > 10`]),
      countToPart('No oversized files', 0.2, bigFiles, 8, [`${bigFiles} files over 600 lines`]),
      { label: 'Bounded file sizes', weight: 0.15, value: avgFileLines <= 400 ? 1 : 400 / Math.max(1, avgFileLines), evidence: [`average source file is ${Math.round(avgFileLines)} lines`] },
    ],
    `Performance derives from measured code shape: ${largeFunctions} oversized functions, ${complexFunctions} complex functions, avg ${Math.round(avgFileLines)} lines/file.`,
  );

  // ── Documentation ─────────────────────────────────────────────────
  const docs = await getDocumentationHealth({ projectPath: input.projectPath });
  const readmeCoverage = docs.coverage.packagesTotal > 0 ? docs.coverage.packagesWithReadme / docs.coverage.packagesTotal : 1;
  const docIssues = docs.issues.length;
  const documentationScore = makeScore(
    [
      { label: 'Package README coverage', weight: 0.35, value: readmeCoverage, evidence: [`${docs.coverage.packagesWithReadme}/${docs.coverage.packagesTotal} packages documented`] },
      countToPart('No doc issues', 0.35, docIssues, 10, [`${docIssues} documentation issues (broken refs, missing docs, drift)`]),
      { label: 'Architecture docs exist', weight: 0.3, value: docs.coverage.architectureDocs >= 1 ? Math.min(1, docs.coverage.architectureDocs / 3) : 0, evidence: [`${docs.coverage.architectureDocs} architecture documents in docs/architecture`] },
    ],
    `Documentation derives from real file tree: ${docs.coverage.architectureDocs} architecture docs, ${docs.coverage.packagesWithReadme}/${docs.coverage.packagesTotal} READMEs, ${docIssues} issues.`,
  );

  // ── Knowledge ─────────────────────────────────────────────────────
  let knowledge = { available: false, entities: 0, relations: 0, files: 0, ratio: 0 };
  try {
    const engine = new FullStackKnowledgeEngine(input.projectPath, { projectName: 'governance-scorecard' });
    const loaded = await engine.load();
    if (loaded) {
      const stats = engine.stats();
      knowledge = {
        available: true,
        entities: stats.entities,
        relations: stats.relations,
        files: stats.files,
        ratio: stats.files > 0 ? stats.entities / stats.files : 0,
      };
    }
  } catch {
    knowledge = { available: false, entities: 0, relations: 0, files: 0, ratio: 0 };
  }
  if (!knowledge.available) unavailable.push('knowledge graph not indexed — run the FullStack Knowledge Engine first');
  const commentLines = sourceFiles.reduce((s, f) => s + (f.text.match(/\/\*\*|\/\/\s/g) ?? []).length, 0);
  const commentRatio = sourceFiles.length > 0 ? commentLines / sourceFiles.length : 0;
  const knowledgeScore = makeScore(
    [
      { label: 'Knowledge graph coverage', weight: 0.4, value: knowledge.available ? Math.min(1, knowledge.ratio / 4) : 0.3, evidence: knowledge.available ? [`${knowledge.entities} entities from ${knowledge.files} files (${Math.round(knowledge.ratio * 100) / 100} entities/file)`] : ['graph unavailable'] },
      { label: 'Doc-comment density', weight: 0.3, value: Math.min(1, commentRatio / 10), evidence: [`${commentLines} comment markers across ${sourceFiles.length} files`] },
      { label: 'Docs coverage', weight: 0.3, value: readmeCoverage, evidence: [`${docs.coverage.modulesWithDocs}/${docs.coverage.modulesTotal} modules referenced by docs`] },
    ],
    `Knowledge derives from the real knowledge graph (${knowledge.available ? `${knowledge.entities} entities` : 'not indexed'}) and doc-comment density (${commentLines} markers).`,
  );

  // ── Maintainability ───────────────────────────────────────────────
  const allFunctions = shapes.flatMap((s) => s.functions);
  const maxFunctionSpan = shapes.reduce((m, s) => Math.max(m, s.maxFunctionSpan), 0);
  const totalFunctions = allFunctions.length;
  const avgSpan = totalFunctions > 0 ? allFunctions.reduce((s, f) => s + f.span, 0) / totalFunctions : 0;
  const maintainabilityScore = makeScore(
    [
      countToPart('No repeated logic', 0.3, arch.metrics.duplicatePairs, 4, [`${arch.metrics.duplicatePairs} duplicate implementations`]),
      { label: 'Bounded function sizes', weight: 0.3, value: maxFunctionSpan <= 60 ? 1 : 60 / Math.max(1, maxFunctionSpan), evidence: [`longest function ${maxFunctionSpan} lines, avg ${Math.round(avgSpan)} lines`] },
      countToPart('No unused modules', 0.2, arch.metrics.unusedModules, 10, [`${arch.metrics.unusedModules} unused modules`]),
      { label: 'Module size balance', weight: 0.2, value: avgFileLines <= 400 ? 1 : 400 / Math.max(1, avgFileLines), evidence: [`average source file ${Math.round(avgFileLines)} lines`] },
    ],
    `Maintainability derives from measured shape and architecture output: ${totalFunctions} functions (max ${maxFunctionSpan} lines), ${arch.metrics.duplicatePairs} duplicates, ${arch.metrics.unusedModules} unused modules.`,
  );

  // ── Technical debt ────────────────────────────────────────────────
  const debt = await getTechnicalDebt({ projectPath: input.projectPath });
  const debtCount = debt.totalItems;
  const criticalDebt = debt.bySeverity.high + debt.bySeverity.critical;
  const technicalDebtScore = makeScore(
    [
      countToPart('No critical debt', 0.3, criticalDebt, 3, [`${criticalDebt} high/critical debt items`]),
      countToPart('Low marker debt', 0.3, debt.byCategory.todo + debt.byCategory.fixme, 20, [`${debt.byCategory.todo} TODOs, ${debt.byCategory.fixme} FIXMEs`]),
      countToPart('No deprecated APIs', 0.2, debt.byCategory['deprecated-api'], 5, [`${debt.byCategory['deprecated-api']} deprecated API usages`]),
      countToPart('No structural debt', 0.2, debt.byCategory['large-function'] + debt.byCategory['large-class'] + debt.byCategory['repeated-logic'], 10, [`${debt.byCategory['large-function']} large functions, ${debt.byCategory['large-class']} large classes, ${debt.byCategory['repeated-logic']} repeated logic`]),
    ],
    `Technical debt derives from ${debt.totalItems} real findings across ${debt.meta.analyzedFiles} files (ratio ${debt.debtRatio}/1k LOC).`,
  );

  // ── Overall ───────────────────────────────────────────────────────
  const dimensions: ScorecardDimension[] = [
    { dimension: 'architecture', score: architectureScore, summary: architectureSummary },
    { dimension: 'security', score: securityScore, summary: `Security findings: ${sec.findings.length} (${sec.bySeverity.high + sec.bySeverity.critical} critical/high).` },
    { dimension: 'testing', score: testingScore, summary: `${testFiles.length} test files for ${sourceFiles.length} source files.` },
    { dimension: 'performance', score: performanceScore, summary: `${largeFunctions} oversized functions, ${complexFunctions} complex functions.` },
    { dimension: 'documentation', score: documentationScore, summary: `${docIssues} documentation issues across ${docs.coverage.packagesWithReadme}/${docs.coverage.packagesTotal} documented packages.` },
    { dimension: 'knowledge', score: knowledgeScore, summary: knowledge.available ? `${knowledge.entities} entities in knowledge graph.` : 'Knowledge graph not indexed.' },
    { dimension: 'maintainability', score: maintainabilityScore, summary: `${totalFunctions} functions, avg ${Math.round(avgSpan)} lines, ${arch.metrics.unusedModules} unused modules.` },
    { dimension: 'technical-debt', score: technicalDebtScore, summary: `${debtCount} debt items (${criticalDebt} high/critical).` },
  ];

  const overall = makeScore(
    dimensions.map((d) => ({
      label: d.dimension,
      weight: d.dimension === 'architecture' || d.dimension === 'security' ? 0.18 : 0.14,
      value: d.score.value / 100,
      evidence: [d.summary],
    })),
    `Overall = weighted mean of the ${dimensions.length} real dimension scores above.`,
  );

  return {
    overall,
    dimensions,
    meta: {
      root: ws.root,
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - t0,
      analyzedFiles: ws.files.length,
      unavailable: [...new Set(unavailable)],
    },
  };
}

export function summarizeScorecard(scorecard: EngineeringScorecard): string {
  const top = [...scorecard.dimensions].sort((a, b) => a.score.value - b.score.value).slice(0, 2);
  return `Health: ${scorecard.overall.grade} (${scorecard.overall.value}/100). Weakest: ${top.map((d) => `${d.dimension} (${d.score.value})`).join(', ')}.`;
}
