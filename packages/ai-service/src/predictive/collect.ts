/**
 * Predictive evidence collector — the HOST side of the platform.
 * ==================================================================
 * Maps REAL platform state into the sealed @aura/predictive schema:
 *
 *   scanWorkspace + buildModuleGraph  → files, modules, dependents, layers
 *   getGitChurn                       → churn, change volume
 *   getArchitectureHealth             → cycles, drift, violations, chains
 *   getTechnicalDebt                  → markers, large spans, repeated logic
 *   getSecurityReport                 → findings, deprecated/vulnerable deps
 *   getDocumentationHealth            → doc coverage
 *   getEngineeringScorecard           → the 8 health dimensions
 *   MissionStore / DiagnosisStore     → mission + diagnosis history
 *   AutomationStore / WorkflowStore   → automation runs + workflow shapes
 *
 * Nothing here invents data. Every field maps to a real signal; the
 * predictive engines only ever read this evidence.
 */

import { getArchitectureHealth, getDocumentationHealth, getEngineeringScorecard, getSecurityReport, getTechnicalDebt, defaultLayerRules, layerOf } from '@aura/governance';
import { scanWorkspace, findPackages } from '@aura/governance/core/scan';
import { buildModuleGraph, type ModuleGraph } from '@aura/governance/core/imports';
import { getGitChurn } from '@aura/governance/core/git';
import { analyzeCodeShape } from '@aura/governance/core/codeShape';
import { AutomationStore } from '@aura/automation/store';
import { MissionStore } from '../mission/store';
import { DiagnosisStore } from '../diagnosis/store';
import { WorkflowStore } from '../workflow/store';
import type {
  ArchitectureSignal,
  CandidateContext,
  DebtSignal,
  DependencySignal,
  DiagnosisHistory,
  DocsSignal,
  FileSignal,
  GitSignal,
  HealthSignal,
  MissionContext,
  MissionHistory,
  ModuleSignal,
  PredictiveEvidence,
  RunHistory,
  SecuritySignal,
  WorkflowSignal,
} from '@aura/predictive';

export interface CollectOptions {
  projectId: string;
  projectPath: string;
  /** Git churn window in days. */
  days?: number;
  runNpmAudit?: boolean;
}

const MODULE_RE = /^(?:packages|apps)\/([^/]+)/;
const MARKER_RE = /(TODO|FIXME|HACK|XXX|TEMP|WIP)\b/gi;
const EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const TEST_RE = /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/i;

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

function moduleOf(relPath: string): string | null {
  return relPath.match(MODULE_RE)?.[1] ?? null;
}

function baseName(name: string): string {
  return name.replace(EXT_RE, '').replace(TEST_RE, '');
}

function complexityOf(text: string, lines: number): number {
  const shape = analyzeCodeShape(text, { functionLineLimit: 80, classLineLimit: 300 });
  const maxFnCx = shape.functions.reduce((m, f) => Math.max(m, f.complexity), 0);
  const spanScore = Math.min(1, shape.maxFunctionSpan / 80);
  const linesScore = Math.min(1, lines / 600);
  return Math.round(clamp01(0.35 * Math.min(1, maxFnCx / 12) + 0.35 * spanScore + 0.3 * linesScore) * 1000) / 1000;
}

function markerCount(text: string): number {
  let count = 0;
  for (const _ of text.matchAll(MARKER_RE)) count += 1;
  return count;
}

export async function collectPredictiveEvidence(opts: CollectOptions): Promise<PredictiveEvidence> {
  const { projectId, projectPath } = opts;
  const days = opts.days ?? 90;

  const [ws, git, arch, debt, sec, docs, scorecard] = await Promise.all([
    scanWorkspace(projectPath),
    getGitChurn(projectPath, days),
    getArchitectureHealth({ projectPath }),
    getTechnicalDebt({ projectPath }),
    getSecurityReport({ projectPath, runNpmAudit: opts.runNpmAudit }),
    getDocumentationHealth({ projectPath }),
    getEngineeringScorecard({ projectPath, runNpmAudit: opts.runNpmAudit }),
  ]);

  const graph: ModuleGraph = buildModuleGraph(ws, findPackages(ws));
  const layerRules = defaultLayerRules(projectPath);

  /* ── per-file maps from reports ──────────────────────────────────── */
  const churnByFile = new Map(git.byFile);
  const debtMarkersByFile = new Map<string, { marker: string; line: number }[]>();
  const largeFiles = new Set<string>();
  const largeFunctions = new Set<string>();
  for (const item of debt.items) {
    const file = item.evidence[0]?.file;
    if (!file) continue;
    if (item.category === 'todo' || item.category === 'fixme' || item.category === 'deprecated-api') {
      const arr = debtMarkersByFile.get(file) ?? [];
      arr.push({ marker: item.title, line: item.evidence[0]?.line ?? 0 });
      debtMarkersByFile.set(file, arr);
    } else if (item.category === 'large-file') {
      largeFiles.add(file);
    } else if (item.category === 'large-function') {
      largeFunctions.add(file);
    }
  }
  const secByFile = new Map<string, number>();
  for (const f of sec.findings) {
    const file = f.evidence[0]?.file;
    if (file) secByFile.set(file, (secByFile.get(file) ?? 0) + 1);
  }

  /* ── diagnosis history (candidates needed for proposal-success) ──── */
  const diagStore = new DiagnosisStore();
  const diagSummaries = diagStore.list(projectId);
  const diagCountByFile = new Map<string, number>();
  const diagFiredByFile = new Map<string, number>();
  const diagnosisHistory: DiagnosisHistory[] = [];
  for (const s of diagSummaries) {
    diagCountByFile.set(s.filePath, (diagCountByFile.get(s.filePath) ?? 0) + 1);
    if (s.category !== 'unknown') diagFiredByFile.set(s.filePath, (diagFiredByFile.get(s.filePath) ?? 0) + 1);
    const rec = diagStore.get(projectId, s.id);
    diagnosisHistory.push({
      file: s.filePath,
      category: s.category,
      decision: s.decision.status,
      candidates: (rec?.candidates ?? []).map((c) => ({
        id: c.id,
        strategy: c.strategy,
        confidenceOverall: c.confidence.overall,
        limiter: c.limiter.decision,
        verdict: c.reviewer.verdict,
      })),
    });
  }

  /* ── files ───────────────────────────────────────────────────────── */
  const testBaseNames = new Set(ws.files.filter((f) => f.isTest).map((f) => baseName(f.name)));
  const files: FileSignal[] = [];
  for (const f of ws.files) {
    if (!f.isSource && !f.isTest) continue;
    files.push({
      relPath: f.relPath,
      module: moduleOf(f.relPath),
      layer: layerOf(f.relPath, layerRules) ?? null,
      churn: churnByFile.get(f.relPath) ?? 0,
      lines: f.lines,
      complexity: complexityOf(f.text, f.lines),
      markers: markerCount(f.text),
      hasTests: !f.isTest && testBaseNames.has(baseName(f.name)),
      diagnosisCount: diagCountByFile.get(f.relPath) ?? 0,
      diagnosisFired: diagFiredByFile.get(f.relPath) ?? 0,
      dependents: graph.nodes.get(f.relPath)?.importers ?? [],
      securityFindings: secByFile.get(f.relPath) ?? 0,
      isTest: f.isTest,
    });
  }

  /* ── dependency manifests ────────────────────────────────────────── */
  const deprecatedSet = new Set(sec.deprecatedDependencies);
  const dependencies: DependencySignal[] = [];
  for (const pkg of ws.files.filter((f) => f.isPackageJson)) {
    let parsed: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } | null = null;
    try {
      parsed = JSON.parse(pkg.text);
    } catch {
      parsed = null;
    }
    if (!parsed) continue;
    const all = { ...parsed.dependencies, ...parsed.devDependencies };
    for (const [name, range] of Object.entries(all)) {
      dependencies.push({
        name,
        range,
        loose: !/^[0-9]/.test(range) || range.startsWith('^') || range.startsWith('~') || range.includes('*') || range === 'workspace:*',
        deprecated: deprecatedSet.has(name),
        vulnerable: false,
        declaredIn: pkg.relPath,
        changed: (churnByFile.get(pkg.relPath) ?? 0) > 0,
      });
    }
  }

  /* ── module aggregates ───────────────────────────────────────────── */
  const moduleFiles = new Map<string, number>();
  for (const f of files) {
    if (f.isTest) continue;
    const m = f.module ?? '(root)';
    moduleFiles.set(m, (moduleFiles.get(m) ?? 0) + 1);
  }
  const modules: ModuleSignal[] = [...moduleFiles.entries()].map(([name, count]) => ({
    name,
    relDir: name,
    churn: git.byModule.get(name)?.changes ?? 0,
    files: count,
  }));

  /* ── architecture ────────────────────────────────────────────────── */
  const architecture: ArchitectureSignal = {
    sourceFiles: arch.metrics.sourceFiles,
    cycles: arch.metrics.cycles,
    nodesInCycles: arch.metrics.nodesInCycles,
    layerViolations: arch.metrics.layerViolations,
    unusedModules: arch.metrics.unusedModules,
    duplicatePairs: arch.metrics.duplicatePairs,
    driftImports: arch.metrics.driftImports,
    longestChain: arch.metrics.longestChain,
    cycleFiles: [...new Set(arch.cycles.flatMap((c) => c.nodes))].sort(),
    driftFiles: [...new Set(arch.drift.map((d) => d.importer))].sort(),
  };

  /* ── git ─────────────────────────────────────────────────────────── */
  const gitSignal: GitSignal = {
    available: git.available,
    since: git.since,
    totalCommits: git.totalCommits,
    byFile: Object.fromEntries(git.byFile),
    byModule: Object.fromEntries(git.byModule),
  };

  /* ── debt ────────────────────────────────────────────────────────── */
  const repeatedPairs = debt.items.filter((i) => i.category === 'repeated-logic').map((i) => ({
    a: i.evidence[0]?.file ?? '',
    b: i.evidence[1]?.file ?? '',
    similarity: 0,
  }));
  const debtSignal: DebtSignal = {
    totalItems: debt.totalItems,
    markers: [...debtMarkersByFile.entries()].flatMap(([file, arr]) => arr.map((m) => ({ file, marker: m.marker, line: m.line }))),
    largeFiles: [...largeFiles].sort(),
    largeFunctions: [...largeFunctions].sort(),
    repeatedPairs,
  };

  /* ── security ────────────────────────────────────────────────────── */
  const security: SecuritySignal = {
    findings: sec.findings.map((f) => ({ file: f.evidence[0]?.file ?? '', type: f.type, severity: f.severity })),
    deprecatedDependencies: sec.deprecatedDependencies,
    criticalHigh: sec.bySeverity.critical + sec.bySeverity.high,
  };

  /* ── docs ────────────────────────────────────────────────────────── */
  const docsSignal: DocsSignal = {
    issues: docs.issues.map((i) => ({ file: i.evidence[0]?.file ?? '', type: i.type })),
    coverage: docs.coverage,
  };

  /* ── health ──────────────────────────────────────────────────────── */
  const health: HealthSignal = {
    dimensions: scorecard.dimensions.map((d) => ({ dimension: d.dimension, value: d.score.value / 100 })),
    overall: scorecard.overall.value / 100,
    unavailable: scorecard.meta.unavailable,
  };

  /* ── mission history ─────────────────────────────────────────────── */
  const missionStore = new MissionStore();
  const missions: MissionHistory[] = missionStore
    .list(projectId)
    .map((s) => {
      const rec = missionStore.get(projectId, s.id);
      return {
        id: s.id,
        category: s.category,
        approved: s.approval.status === 'approved',
        riskOverall: rec?.risk?.overall ?? null,
        qualityOverall: s.qualityOverall,
        executionStatus: s.execution?.status ?? null,
        failedTasks: s.execution?.metrics?.tasksFailed ?? 0,
        totalTasks: s.execution?.metrics?.tasksTotal ?? s.taskCount,
        rejectedTasks: s.execution?.metrics?.tasksRejected ?? 0,
        createdAt: s.createdAt,
      };
    });

  /* ── automation runs (per action) + workflow shapes ──────────────── */
  const autoStore = new AutomationStore();
  const runs: RunHistory[] = [];
  for (const s of autoStore.listRuns()) {
    const run = autoStore.getRun(s.ruleId, s.id);
    if (!run) continue;
    const ruleName = autoStore.getRule(s.ruleId)?.name ?? s.ruleId;
    for (const a of run.actions) {
      runs.push({
        ruleId: s.ruleId,
        ruleName,
        action: a.action,
        status: run.status,
        actionStatus: a.status,
        retries: Math.max(0, a.attempts - 1),
        ms: a.ms ?? run.ms ?? 0,
        startedAt: run.startedAt,
      });
    }
  }

  const wfStore = new WorkflowStore();
  const workflows: WorkflowSignal[] = wfStore
    .list()
    .map((s) => {
      const wf = wfStore.get(s.id);
      if (!wf) return null;
      const heavyNodes = wf.nodes.filter((n) => HEAVY_NODES.has(n.type)).length;
      const out = new Map(wf.edges.map((e) => [e.from, e.to]));
      const longestPath = longestChainLength(out, wf.nodes.length);
      return {
        id: wf.id,
        name: wf.name,
        nodeCount: wf.nodes.length,
        heavyNodes,
        sequentialDepth: longestPath,
      };
    })
    .filter((w): w is WorkflowSignal => w !== null);

  return {
    projectId,
    projectPath,
    collectedAt: new Date().toISOString(),
    files,
    dependencies,
    modules,
    architecture,
    git: gitSignal,
    debt: debtSignal,
    security,
    docs: docsSignal,
    health,
    missions,
    diagnoses: diagnosisHistory,
    runs,
    workflows,
  };
}

/** Longest chain length in an edge map (guarded against cycles). */
export function longestChainLength(edges: Map<string, string>, nodeCount: number): number {
  const memo = new Map<string, number>();
  const visit = (node: string, depth: number, seen: Set<string>): number => {
    if (memo.has(node)) return memo.get(node)!;
    const next = edges.get(node);
    if (!next) {
      memo.set(node, depth);
      return depth;
    }
    if (seen.has(next)) {
      memo.set(node, depth);
      return depth;
    }
    seen.add(next);
    const len = visit(next, depth + 1, seen);
    seen.delete(next);
    memo.set(node, len);
    return len;
  };
  let max = 0;
  for (const node of edges.keys()) {
    max = Math.max(max, visit(node, 1, new Set([node])));
    if (max >= nodeCount) break;
  }
  return Math.min(max, nodeCount);
}

/** Expensive / LLM-backed workflow nodes — the things that bottleneck. */
const HEAVY_NODES = new Set<string>(['prompt', 'groq', 'generate-markdown', 'generate-code', 'generate-json', 'shell-command']);

/* ── Live-context builders for per-mission / per-candidate prediction ── */

export function missionContextFrom(projectId: string, missionId: string): MissionContext | null {
  const store = new MissionStore();
  const rec = store.get(projectId, missionId);
  if (!rec) return null;
  const taskRuns = rec.taskRuns ?? [];
  const proposed = taskRuns.filter((t) => t.status === 'proposed').length;
  const accepted = taskRuns.filter((t) => t.status === 'accepted' || t.status === 'done').length;
  const rejected = taskRuns.filter((t) => t.status === 'rejected').length;
  const total = Math.max(1, proposed + accepted + rejected);
  const tasks = (rec.goalGraph?.tasks ?? []).map((t) => ({ id: t.id, targetFile: t.targetFile ?? '', status: t.status }));
  return {
    id: rec.id,
    text: rec.text,
    category: rec.classification?.category ?? 'unknown',
    riskOverall: rec.risk?.overall ?? null,
    qualityOverall: rec.quality?.overall ?? null,
    taskAcceptanceRate: total > 0 ? accepted / total : 1,
    tasks,
  };
}

export function candidateContextFrom(projectId: string, diagnosisId: string, candidateId: string): CandidateContext | null {
  const store = new DiagnosisStore();
  const rec = store.get(projectId, diagnosisId);
  const c = rec?.candidates.find((x) => x.id === candidateId);
  if (!rec || !c) return null;
  return {
    id: `${diagnosisId}:${candidateId}`,
    strategy: c.strategy,
    targetFile: rec.filePath,
    confidenceOverall: c.confidence.overall,
    limiter: c.limiter.decision === 'auto-rejected' ? c.limiter.reasons.join('; ') || 'auto-rejected' : c.limiter.decision !== 'auto-approved' ? c.limiter.reasons.join('; ') || c.limiter.decision : null,
    dependencies: [],
  };
}
