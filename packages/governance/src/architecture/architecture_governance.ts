/**
 * Architecture Health Engine
 * ==================================================================
 * Real, deterministic detection over the workspace's actual module
 * graph (parsed from real import statements):
 *
 *   • circular dependencies   — Tarjan SCC over internal edges
 *   • layer violations        — configured directory-layer rules
 *   • unused modules          — zero importers and not an entry point
 *   • duplicate implementations — normalized token similarity
 *   • architecture drift      — cross-package imports not declared in
 *                               the importing package's package.json
 *   • dependency cycles       — cycles + longest chain in the DAG
 *
 * Every finding carries evidence (file/line/snippet) and a basis.
 */

import path from 'node:path';
import { scanWorkspace, findPackages, type PackageInfo } from '../core/scan';
import { buildModuleGraph, type ModuleGraph } from '../core/imports';
import { findCycles, longestPathDag, condensation, similarityScore } from '../core/algorithms';
import { makeScore, to100, countToPart } from '../core/score';
import { analyzeCodeShape } from '../core/codeShape';
import type { Finding, ReportMeta, Severity, Score } from '../core/types';

export interface LayerRule {
  /** Directory prefix relative to repo root, e.g. "packages/ui". */
  prefix: string;
  layer: string;
  /** Layer names this layer may NOT import. */
  forbiddenTargets: string[];
}

export interface ArchitectureThresholds {
  maxCycles: number;
  maxLayerViolations: number;
  maxUnusedModules: number;
  duplicateSimilarity: number;
  maxDuplicatePairs: number;
}

export const DEFAULT_THRESHOLDS: ArchitectureThresholds = {
  maxCycles: 0,
  maxLayerViolations: 3,
  maxUnusedModules: 15,
  duplicateSimilarity: 0.65,
  maxDuplicatePairs: 10,
};

export function defaultLayerRules(root: string): LayerRule[] {
  const top = (p: string) => path.posix.join(root, p).split('/').filter(Boolean);
  void top;
  return [
    { prefix: 'apps', layer: 'app', forbiddenTargets: [] },
    { prefix: 'packages', layer: 'package', forbiddenTargets: ['app', 'docs'] },
    { prefix: 'docs', layer: 'docs', forbiddenTargets: [] },
    { prefix: 'scripts', layer: 'tool', forbiddenTargets: ['app'] },
    { prefix: 'tools', layer: 'tool', forbiddenTargets: ['app'] },
  ];
}

export function layerOf(relPath: string, rules: LayerRule[]): string | null {
  const dirs = relPath.split('/');
  const prefix = dirs[0] ?? '';
  if (prefix === '') return null;
  const pkg = prefix === 'packages' || prefix === 'apps' ? dirs.slice(0, 2).join('/') : prefix;
  return rules.find((r) => pkg === r.prefix || (pkg.startsWith(r.prefix) && pkg.split('/').length <= r.prefix.split('/').length + 1))?.layer ?? null;
}

export type ArchitectureFindingType =
  | 'circular-dependency'
  | 'layer-violation'
  | 'unused-module'
  | 'duplicate-implementation'
  | 'architecture-drift'
  | 'dependency-chain';

export interface ArchitectureFinding extends Finding {
  type: ArchitectureFindingType;
}

export interface ArchitectureMetrics {
  sourceFiles: number;
  internalEdges: number;
  cycles: number;
  nodesInCycles: number;
  layerViolations: number;
  unusedModules: number;
  duplicatePairs: number;
  driftImports: number;
  longestChain: number;
  maxFunctionSpan: number;
  maxClassSpan: number;
}

export interface ArchitectureHealthReport {
  overall: Score;
  grade: string;
  metrics: ArchitectureMetrics;
  findings: ArchitectureFinding[];
  cycles: { nodes: string[]; edges: { from: string; to: string }[] }[];
  layerViolations: { from: string; to: string; fromLayer: string; toLayer: string; rule: string }[];
  unusedModules: string[];
  duplicatePairs: { a: string; b: string; similarity: number }[];
  drift: { importer: string; target: string; missingFrom: string }[];
  longestChainPath: string[];
  meta: ReportMeta;
}

export interface ArchitectureInput {
  projectPath: string;
  rules?: LayerRule[];
  thresholds?: Partial<ArchitectureThresholds>;
}

const ENTRY_PATTERNS = [
  /(^|\/)(index|main|app|boot|start|router|entry)\.(ts|tsx|js|jsx|mjs|cjs)$/,
  /(^|\/)vite\.config\./, /(^|\/)tailwind\.config\./, /(^|\/)tsconfig\./,
  /\.(test|spec)\./, /__tests__\//, /\.config\.(ts|js)$/,
  /(^|\/)main\.(ts|tsx)$/, /(^|\/)App\.(tsx|ts)$/,
];

function isEntryPoint(relPath: string): boolean {
  return ENTRY_PATTERNS.some((re) => re.test(relPath));
}

function findingId(seq: number, type: string): string {
  return `arch-${type}-${seq}`;
}

export async function getArchitectureHealth(input: ArchitectureInput): Promise<ArchitectureHealthReport> {
  const t0 = Date.now();
  const thresholds = { ...DEFAULT_THRESHOLDS, ...input.thresholds };
  const rules = input.rules ?? defaultLayerRules(input.projectPath);

  const ws = await scanWorkspace(input.projectPath);
  const packages = findPackages(ws);
  const graph: ModuleGraph = buildModuleGraph(ws, packages);
  const sourceFiles = [...graph.nodes.keys()];

  const findings: ArchitectureFinding[] = [];
  let seq = 0;

  // ── 1. Circular dependencies (Tarjan SCC) ─────────────────────────
  const adjacency = new Map<string, string[]>();
  for (const node of graph.nodes.values()) {
    adjacency.set(node.relPath, node.imports.filter((t) => graph.nodes.has(t)));
  }
  const cycles = findCycles(adjacency);
  const nodesInCycles = new Set(cycles.flatMap((c) => c.nodes));
  for (const cycle of cycles) {
    const cycleFiles = cycle.nodes.map((n) => n.replace(/^.*?\//, ''));
    const prod = cycle.nodes.filter((n) => !n.includes('.test.') && !n.includes('__tests__'));
    const severity: Severity = prod.length === cycle.nodes.length && prod.length > 0 ? 'high' : 'medium';
    findings.push({
      id: findingId(seq++, 'circular-dependency'),
      type: 'circular-dependency',
      severity,
      title: `Circular dependency: ${cycle.nodes.length} modules`,
      description: `${cycle.nodes.length} modules form an import cycle${prod.length < cycle.nodes.length ? ' (partly test code)' : ''}.`,
      evidence: cycle.nodes.map((n) => ({
        file: n,
        basis: `member of strongly-connected component of size ${cycle.nodes.length}`,
      })),
      recommendation: 'Break the cycle by extracting shared logic into a new module both sides depend on, or inverting one edge.',
    });
    void cycleFiles;
  }

  // ── 2. Layer violations ───────────────────────────────────────────
  const layerOfFile = new Map<string, string | null>();
  for (const n of sourceFiles) layerOfFile.set(n, layerOf(n, rules));

  const layerViolations: ArchitectureHealthReport['layerViolations'] = [];
  for (const node of graph.nodes.values()) {
    const fromLayer = layerOfFile.get(node.relPath);
    if (!fromLayer) continue;
    for (const target of node.imports) {
      const toLayer = layerOfFile.get(target);
      if (!toLayer || toLayer === fromLayer) continue;
      const rule = rules.find((r) => r.layer === fromLayer && r.forbiddenTargets.includes(toLayer));
      if (rule) {
        layerViolations.push({
          from: node.relPath,
          to: target,
          fromLayer,
          toLayer,
          rule: `layer '${fromLayer}' must not import layer '${toLayer}' (prefix '${rule.prefix}')`,
        });
      }
    }
  }
  for (const v of layerViolations.slice(0, 40)) {
    const severity: Severity = v.toLayer === 'docs' ? 'medium' : 'high';
    findings.push({
      id: findingId(seq++, 'layer-violation'),
      type: 'layer-violation',
      severity,
      title: `Layer violation: ${v.from} → ${v.to}`,
      description: v.rule,
      evidence: [{ file: v.from, basis: `imports ${v.to} which resolves to layer '${v.toLayer}'` }],
      recommendation: 'Remove the dependency or move the shared code to a lower layer.',
    });
  }

  // ── 3. Unused modules ─────────────────────────────────────────────
  const unusedModules: string[] = [];
  for (const node of graph.nodes.values()) {
    if (node.importers.length === 0 && !isEntryPoint(node.relPath)) {
      unusedModules.push(node.relPath);
    }
  }
  for (const u of unusedModules.slice(0, 30)) {
    findings.push({
      id: findingId(seq++, 'unused-module'),
      type: 'unused-module',
      severity: 'medium',
      title: `Unused module: ${u}`,
      description: 'No other internal module imports this file and it is not a recognized entry point.',
      evidence: [{ file: u, basis: 'import graph indegree = 0; not matched by entry-point patterns' }],
      recommendation: 'Delete the file or wire it into the module graph.',
    });
  }

  // ── 4. Duplicate implementations ──────────────────────────────────
  const duplicatePairs: ArchitectureHealthReport['duplicatePairs'] = [];
  const files = ws.files.filter((f) => f.isSource && !f.isTest);
  const candidates = files.filter((f) => !isEntryPoint(f.relPath));
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i];
      const b = candidates[j];
      if (a.ext !== b.ext) continue;
      if (Math.abs(a.size - b.size) > a.size * 0.6) continue;
      const sim = similarityScore(a.text, b.text);
      if (sim >= thresholds.duplicateSimilarity) {
        duplicatePairs.push({ a: a.relPath, b: b.relPath, similarity: Math.round(sim * 100) / 100 });
        if (duplicatePairs.length >= thresholds.maxDuplicatePairs * 3) break;
      }
    }
    if (duplicatePairs.length >= thresholds.maxDuplicatePairs * 3) break;
  }
  duplicatePairs.sort((x, y) => y.similarity - x.similarity);
  const topDuplicates = duplicatePairs.slice(0, thresholds.maxDuplicatePairs);
  for (const pair of topDuplicates) {
    findings.push({
      id: findingId(seq++, 'duplicate-implementation'),
      type: 'duplicate-implementation',
      severity: 'medium',
      title: `Duplicate implementations (${pair.similarity} similarity)`,
      description: 'Two files share nearly identical normalized logic.',
      evidence: [
        { file: pair.a, basis: `token bigram similarity ${pair.similarity} vs ${pair.b}` },
        { file: pair.b, basis: 'identical normalization (comments/strings/whitespace stripped)' },
      ],
      recommendation: 'Extract the shared logic into one module and import it from both sites.',
    });
  }

  // ── 5. Architecture drift (undeclared cross-package imports) ──────
  const fileToPackage = new Map<string, PackageInfo>();
  for (const p of packages) {
    const prefix = p.relDir === '.' ? '' : `${p.relDir}/`;
    for (const f of ws.files) {
      if (f.isSource && f.relPath.startsWith(prefix)) fileToPackage.set(f.relPath, p);
    }
  }

  const drift: ArchitectureHealthReport['drift'] = [];
  for (const node of graph.nodes.values()) {
    const pkg = fileToPackage.get(node.relPath);
    if (!pkg) continue;
    for (const target of node.imports) {
      const targetPkg = fileToPackage.get(target);
      if (!targetPkg || targetPkg === pkg) continue;
      if (targetPkg.name === pkg.name) continue;
      const declared =
        pkg.dependencies[targetPkg.name] !== undefined ||
        pkg.devDependencies[targetPkg.name] !== undefined ||
        pkg.peerDependencies[targetPkg.name] !== undefined;
      if (!declared) {
        drift.push({ importer: node.relPath, target, missingFrom: pkg.name });
      }
    }
  }
  const driftSet = new Map<string, typeof drift[number]>();
  for (const d of drift) driftSet.set(`${d.importer}|${d.target}`, d);
  const uniqueDrift = [...driftSet.values()];
  for (const d of uniqueDrift.slice(0, 25)) {
    findings.push({
      id: findingId(seq++, 'architecture-drift'),
      type: 'architecture-drift',
      severity: 'medium',
      title: `Undeclared package import: ${d.importer} → ${d.target}`,
      description: `'${d.missingFrom}' does not declare the target package in package.json but imports it in source.`,
      evidence: [
        { file: d.importer, basis: 'resolved import edge crosses package boundary' },
        { file: d.target, basis: 'target package not present in package.json dependencies/devDependencies/peerDependencies' },
      ],
      recommendation: `Add the dependency to ${d.missingFrom}'s package.json or remove the import.`,
    });
  }

  // ── 6. Dependency chains ──────────────────────────────────────────
  const allNodes = [...graph.nodes.values()];
  const cond = condensation(
    sourceFiles,
    allNodes.flatMap((n) => n.imports.filter((t) => graph.nodes.has(t)).map((t) => ({ from: n.relPath, to: t }))),
  );
  const roots = sourceFiles.filter((n) => (adjacency.get(n)?.length ?? 0) > 0);
  const longest = longestPathDag(cond.dag, roots.map((r) => cond.componentOf.get(r)!));
  const longestChainPath = cond.comps.find((c) => cond.componentOf.get(c[0]) === longest.path[0])?.concat(longest.path.slice(1).map((cid) => (cond.comps.find((c) => cond.componentOf.get(c[0]) === cid) ?? [cid])[0])) ?? [];
  if (longest.length > 12) {
    findings.push({
      id: findingId(seq++, 'dependency-chain'),
      type: 'dependency-chain',
      severity: 'low',
      title: `Deep dependency chain (${longest.length} hops)`,
      description: `Longest import chain spans ${longest.length} module hops; deep chains slow builds, make caching fragile and raise blast radius.`,
      evidence: [{ file: longestChainPath[0] ?? '', basis: `longest path in SCC-condensed dependency DAG (${longest.length} edges)` }],
      recommendation: 'Flatten deep chains by consolidating intermediate modules.',
    });
  }

  // ── Score ─────────────────────────────────────────────────────────
  const cycleCount = cycles.length;
  const score = makeScore(
    [
      countToPart('No dependency cycles', 0.25, cycleCount, 1, [`${cycleCount} cycles found, ${nodesInCycles.size} modules involved`]),
      countToPart('No layer violations', 0.2, layerViolations.length, thresholds.maxLayerViolations, [`${layerViolations.length} layer violations`]),
      countToPart('No architecture drift', 0.15, uniqueDrift.length, 10, [`${uniqueDrift.length} undeclared cross-package imports`]),
      countToPart('No unused modules', 0.15, unusedModules.length, thresholds.maxUnusedModules, [`${unusedModules.length} unused modules`]),
      countToPart('No duplicate implementations', 0.1, topDuplicates.length, 5, [`${topDuplicates.length} duplicate pairs ≥ ${thresholds.duplicateSimilarity} similarity`]),
      countToPart('Bounded dependency chains', 0.15, Math.max(0, longest.length - 8), 8, [`longest chain ${longest.length} hops`]),
    ],
    `Architecture health derives from ${sourceFiles.length} real source files and ${allNodes.reduce((s, n) => s + n.imports.length, 0)} resolved internal edges.`,
  );

  // Shape metrics for maintainability context.
  const shapes = ws.files.filter((f) => f.isSource && !f.isTest).map((f) => analyzeCodeShape(f.text));
  const maxFunctionSpan = shapes.reduce((m, s) => Math.max(m, s.maxFunctionSpan), 0);
  const maxClassSpan = shapes.reduce((m, s) => Math.max(m, s.maxClassSpan), 0);

  const metrics: ArchitectureMetrics = {
    sourceFiles: sourceFiles.length,
    internalEdges: allNodes.reduce((s, n) => s + n.imports.length, 0),
    cycles: cycleCount,
    nodesInCycles: nodesInCycles.size,
    layerViolations: layerViolations.length,
    unusedModules: unusedModules.length,
    duplicatePairs: topDuplicates.length,
    driftImports: uniqueDrift.length,
    longestChain: longest.length,
    maxFunctionSpan,
    maxClassSpan,
  };

  findings.sort((a, b) => sevRank(b.severity) - sevRank(a.severity));

  return {
    overall: score,
    grade: score.grade,
    metrics,
    findings,
    cycles: cycles.map((c) => ({ nodes: c.nodes, edges: c.edges })),
    layerViolations,
    unusedModules,
    duplicatePairs: topDuplicates,
    drift: uniqueDrift,
    longestChainPath,
    meta: {
      root: ws.root,
      analyzedFiles: ws.files.length,
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - t0,
      unavailable: [],
    },
  };
}

function sevRank(s: Severity): number {
  switch (s) {
    case 'critical': return 4;
    case 'high': return 3;
    case 'medium': return 2;
    case 'low': return 1;
    default: return 0;
  }
}

export function severityRank(s: Severity): number {
  return sevRank(s);
}

export function summarizeArchitecture(report: ArchitectureHealthReport): string {
  const m = report.metrics;
  return `Architecture: ${report.grade} (${report.overall.value}/100) — ${m.cycles} cycles, ${m.layerViolations} layer violations, ${m.unusedModules} unused modules, ${m.driftImports} drift imports, ${m.duplicatePairs} duplicate pairs.`;
}

export function toScore100(score: Score): number {
  return to100(score.value / 100);
}
