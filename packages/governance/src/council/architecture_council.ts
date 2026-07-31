/**
 * Architecture Council
 * ==================================================================
 * Structured review of completed subsystems — Knowledge Fabric,
 * Diagnosis Engine, Mission Control, Engineering Memory, Workflow
 * Engine — based entirely on real measurements of their code:
 * complexity, cycles, tests, documentation, dependencies.
 */

import { scanWorkspace, findPackages } from '../core/scan';
import { buildModuleGraph } from '../core/imports';
import { analyzeCodeShape, complexityStats } from '../core/codeShape';
import { findCycles } from '../core/algorithms';
import { makeScore, countToPart } from '../core/score';
import type { ReportMeta } from '../core/types';

export interface CouncilMetrics {
  files: number;
  lines: number;
  functions: number;
  avgFunctionLines: number;
  maxFunctionLines: number;
  complexFunctions: number;
  cycles: number;
  testFiles: number;
  testRatio: number;
  hasReadme: boolean;
  externalDependencies: number;
  docFiles: number;
}

export interface CouncilReview {
  subsystem: string;
  paths: string[];
  metrics: CouncilMetrics;
  score: { value: number; grade: string };
  strengths: string[];
  weaknesses: string[];
  improvementSuggestions: string[];
  scalabilityRisks: string[];
  recommendations: string[];
}

export interface ArchitectureCouncilReport {
  reviews: CouncilReview[];
  meta: ReportMeta;
}

export interface CouncilInput {
  projectPath: string;
  subsystems?: { name: string; paths: string[] }[];
}

export const DEFAULT_SUBSYSTEMS: { name: string; paths: string[] }[] = [
  { name: 'Knowledge Fabric', paths: ['packages/knowledge-fullstack', 'packages/knowledge-coding'] },
  { name: 'Diagnosis Engine', paths: ['packages/ai-service/src/diagnosis'] },
  { name: 'Mission Control', paths: ['packages/ai-service/src/mission', 'apps/desktop/src/screens/missions'] },
  { name: 'Engineering Memory', paths: ['packages/ai-service/src/memory.ts'] },
  { name: 'Workflow Engine', paths: ['packages/ai-service/src/workflow'] },
];

export async function getArchitectureCouncil(input: CouncilInput): Promise<ArchitectureCouncilReport> {
  const t0 = Date.now();
  const ws = await scanWorkspace(input.projectPath);
  const packages = findPackages(ws);
  const graph = buildModuleGraph(ws, packages);
  const subsystems = input.subsystems ?? DEFAULT_SUBSYSTEMS;

  const reviews: CouncilReview[] = [];
  for (const sub of subsystems) {
    reviews.push(reviewSubsystem(ws, packages, graph, sub));
  }

  return {
    reviews,
    meta: {
      root: ws.root,
      analyzedFiles: ws.files.length,
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - t0,
      unavailable: [],
    },
  };
}

function reviewSubsystem(
  ws: Awaited<ReturnType<typeof scanWorkspace>>,
  packages: Awaited<ReturnType<typeof findPackages>>,
  graph: Awaited<ReturnType<typeof buildModuleGraph>>,
  sub: { name: string; paths: string[] },
): CouncilReview {
  const paths = sub.paths;
  const files = ws.files.filter((f) => f.isSource && paths.some((p) => f.relPath === p || f.relPath.startsWith(`${p}/`)));
  const testFiles = files.filter((f) => f.isTest);
  const prodFiles = files.filter((f) => !f.isTest);
  const lines = prodFiles.reduce((s, f) => s + f.lines, 0);

  const shapes = prodFiles.map((f) => analyzeCodeShape(f.text));
  const allFunctions = shapes.flatMap((s) => s.functions);
  const maxFunctionLines = shapes.reduce((m, s) => Math.max(m, s.maxFunctionSpan), 0);
  const avgFunctionLines = allFunctions.length > 0 ? allFunctions.reduce((s, f) => s + f.span, 0) / allFunctions.length : 0;
  const complexFunctions = shapes.reduce((s, x) => s + complexityStats(x).complexFunctions, 0);

  // cycles within subsystem boundaries (real import edges)
  const subNodes = new Set(files.map((f) => f.relPath));
  const adjacency = new Map<string, string[]>();
  for (const f of files) {
    const node = graph.nodes.get(f.relPath);
    adjacency.set(f.relPath, (node?.imports ?? []).filter((t) => subNodes.has(t)));
  }
  const cycles = findCycles(adjacency);

  const docFiles = ws.files.filter((f) => f.isMarkdown && paths.some((p) => f.relPath === p || f.relPath.startsWith(`${p}/`))).length;
  const relDir = paths[0].split('/')[1] ? paths[0] : '';
  const pkg = packages.find((p) => p.relDir === relDir);
  const externalDependencies = Object.keys(pkg?.dependencies ?? {}).length + Object.keys(pkg?.devDependencies ?? {}).length;
  const hasReadme = Boolean(pkg?.hasReadme) || docFiles > 0;

  const testRatio = prodFiles.length > 0 ? testFiles.length / prodFiles.length : 0;
  const metrics: CouncilMetrics = {
    files: prodFiles.length,
    lines,
    functions: allFunctions.length,
    avgFunctionLines: Math.round(avgFunctionLines * 10) / 10,
    maxFunctionLines,
    complexFunctions,
    cycles: cycles.length,
    testFiles: testFiles.length,
    testRatio: Math.round(testRatio * 100) / 100,
    hasReadme,
    externalDependencies,
    docFiles,
  };

  const score = makeScore(
    [
      countToPart('No internal cycles', 0.3, cycles.length, 1, [`${cycles.length} cycles within subsystem`]),
      { label: 'Function size bounded', weight: 0.25, value: maxFunctionLines <= 80 ? 1 : 80 / Math.max(1, maxFunctionLines), evidence: [`max function ${maxFunctionLines} lines`] },
      { label: 'Tests present', weight: 0.25, value: Math.min(1, testRatio), evidence: [`${testFiles.length} test files for ${prodFiles.length} source files`] },
      { label: 'Documented', weight: 0.2, value: hasReadme ? 1 : 0, evidence: [`README: ${hasReadme ? 'present' : 'missing'}, docs: ${docFiles}`] },
    ],
    `Council score derives from real measurements of ${prodFiles.length} files, ${allFunctions.length} functions and ${lines} lines.`,
  );

  const strengths: string[] = [];
  const weaknesses: string[] = [];
  const suggestions: string[] = [];
  const risks: string[] = [];
  const recommendations: string[] = [];

  if (metrics.files === 0) {
    weaknesses.push('Subsystem paths contain no source files — verify paths.');
  }
  if (metrics.files > 0) {
    strengths.push(`${metrics.files} source files, ${metrics.lines} lines of code, ${metrics.functions} functions.`);
  }
  if (metrics.cycles === 0) strengths.push('No internal import cycles.');
  else {
    weaknesses.push(`${metrics.cycles} internal import cycle(s) detected.`);
    suggestions.push('Break the cycle(s) with a shared dependency layer.');
  }
  if (metrics.maxFunctionLines <= 80) strengths.push(`Largest function is ${metrics.maxFunctionLines} lines — within the 80-line guardrail.`);
  else {
    weaknesses.push(`Largest function spans ${metrics.maxFunctionLines} lines (guardrail 80).`);
    suggestions.push('Split the oversized function(s) into focused helpers.');
    risks.push('Large functions grow blast radius and slow change velocity.');
  }
  if (metrics.complexFunctions > 0) {
    weaknesses.push(`${metrics.complexFunctions} function(s) exceed complexity 10.`);
    suggestions.push('Reduce decision points with early returns / guard clauses.');
  }
  if (metrics.testRatio >= 0.5) strengths.push(`Test coverage present: ${metrics.testFiles} test files (ratio ${metrics.testRatio}).`);
  else {
    weaknesses.push(`Testing is thin: ${metrics.testFiles} test files (ratio ${metrics.testRatio}).`);
    recommendations.push('Add test coverage for the public API and hot paths.');
    risks.push('Low test coverage makes regressions silent during scale-out.');
  }
  if (metrics.hasReadme) strengths.push('Documentation present (README/docs).');
  else {
    weaknesses.push('No README or docs found for this subsystem.');
    recommendations.push('Write a README covering purpose, architecture and extension points.');
  }
  if (metrics.externalDependencies > 0) strengths.push(`Well-scoped external dependencies (${metrics.externalDependencies} declared).`);
  risks.push(`Subsystem carries ${metrics.externalDependencies} external dependencies; audit each for maintenance status.`);

  if (metrics.files > 20 && metrics.functions > 150) {
    risks.push('Subsystem size is large — consider splitting into smaller modules as it grows.');
  }
  if (metrics.avgFunctionLines > 40) {
    suggestions.push(`Average function length ${metrics.avgFunctionLines} lines — aim below 40.`);
  }

  recommendations.push(`Hold a design review when this subsystem exceeds ${Math.max(25, metrics.files * 2)} files or ${Math.max(3000, metrics.lines * 2)} lines.`);

  return {
    subsystem: sub.name,
    paths,
    metrics,
    score: { value: score.value, grade: score.grade },
    strengths,
    weaknesses,
    improvementSuggestions: suggestions,
    scalabilityRisks: risks,
    recommendations,
  };
}

export function summarizeCouncil(report: ArchitectureCouncilReport): string {
  return report.reviews.map((r) => `${r.subsystem}: ${r.score.grade} (${r.score.value}/100) — ${r.weaknesses.length} weaknesses`).join(' · ');
}
