/**
 * Project Insights
 * ==================================================================
 * Every insight is derived from real repository analysis:
 *   • highest change frequency — git log numstat per file/module
 *   • most unstable module     — churn × code complexity
 *   • least documented subsystem — markdown coverage per module
 *   • most reused component    — import graph in-degree
 *   • most fragile dependency  — npm-deprecated packages + deep chains
 */

import path from 'node:path';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { scanWorkspace, findPackages } from '../core/scan';
import { buildModuleGraph } from '../core/imports';
import { analyzeCodeShape } from '../core/codeShape';
import { getGitChurn } from '../core/git';
import { similarityScore } from '../core/algorithms';
import type { ReportMeta, Severity } from '../core/types';

export type InsightType = 'change-frequency' | 'instability' | 'documentation' | 'reuse' | 'fragile-dependency' | 'duplication';

export interface Insight {
  id: string;
  type: InsightType;
  severity: Severity;
  title: string;
  detail: string;
  evidence: { file?: string; value: string | number; basis: string }[];
  recommendation: string;
}

export interface ProjectInsightsReport {
  insights: Insight[];
  topChangedFiles: { file: string; changes: number }[];
  meta: ReportMeta;
}

export interface InsightsInput {
  projectPath: string;
  days?: number;
}

export async function getProjectInsights(input: InsightsInput): Promise<ProjectInsightsReport> {
  const t0 = Date.now();
  const root = path.resolve(input.projectPath);
  const ws = await scanWorkspace(root);
  const packages = findPackages(ws);
  const graph = buildModuleGraph(ws, packages);
  const churn = await getGitChurn(root, input.days ?? 90);
  const insights: Insight[] = [];
  let seq = 0;

  const push = (type: InsightType, severity: Severity, title: string, detail: string, evidence: Insight['evidence'], recommendation: string): void => {
    insights.push({ id: `insight-${type}-${seq++}`, type, severity, title, detail, evidence, recommendation });
  };

  // ── 1. Highest change frequency ───────────────────────────────────
  if (churn.available) {
    const topFiles = [...churn.byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    const topModules = [...churn.byModule.entries()].sort((a, b) => b[1].changes - a[1].changes).slice(0, 3);
    push(
      'change-frequency',
      'info',
      `Highest change frequency: ${topFiles[0]?.[0] ?? 'n/a'} (${topFiles[0]?.[1] ?? 0} changes)`,
      `Since ${churn.since}, ${churn.totalCommits} commits touched the top files below.`,
      topFiles.map(([file, n]) => ({ file, value: n, basis: `git log --numstat since ${churn.since}` })),
      'Hot files deserve extraction and tests before further growth.',
    );
    if (topModules.length > 0) {
      push(
        'change-frequency',
        'info',
        `Most active module: '${topModules[0][0]}' (${topModules[0][1].changes} changes)`,
        `Module churn since ${churn.since}: +${topModules[0][1].added}/-${topModules[0][1].deleted} lines.`,
        topModules.map(([mod, v]) => ({ value: `${mod}: ${v.changes} changes`, basis: 'git numstat aggregated by top-level module' })),
        'Review whether this module is too broad or changing too fast.',
      );
    }
  } else {
    push('change-frequency', 'info', 'Git history unavailable', 'Cannot measure change frequency — not a git repository or git binary missing.', [{ value: 'n/a', basis: 'git log failed' }], 'Initialize git to enable churn insights.');
  }

  // ── 2. Most unstable module (churn × complexity) ──────────────────
  if (churn.available && churn.byModule.size > 0) {
    const moduleFiles = new Map<string, { files: number; maxFunctionSpan: number; totalFunctions: number; testCount: number }>();
    for (const f of ws.files) {
      const m = f.relPath.match(/^(?:packages|apps)\/([^/]+)/);
      if (!m) continue;
      const mod = m[1];
      const rec = moduleFiles.get(mod) ?? { files: 0, maxFunctionSpan: 0, totalFunctions: 0, testCount: 0 };
      rec.files++;
      if (f.isTest) {
        rec.testCount++;
      } else if (f.isSource) {
        const shape = analyzeCodeShape(f.text);
        rec.maxFunctionSpan = Math.max(rec.maxFunctionSpan, shape.maxFunctionSpan);
        rec.totalFunctions += shape.totalFunctions;
      }
      moduleFiles.set(mod, rec);
    }
    const unstable = [...moduleFiles.entries()]
      .map(([mod, rec]) => {
        const ch = churn.byModule.get(mod);
        const churnScore = ch ? ch.changes / Math.max(1, rec.files) : 0;
        return { mod, score: churnScore * Math.max(1, rec.maxFunctionSpan / 40), churnScore, rec };
      })
      .sort((a, b) => b.score - a.score);
    const top = unstable[0];
    if (top && top.churnScore > 0) {
      push(
        'instability',
        top.score > 15 ? 'high' : 'medium',
        `Most unstable module: '${top.mod}' (instability ${Math.round(top.score * 10) / 10})`,
        `Churn per file ${Math.round(top.churnScore * 100) / 100} × max function span ${top.rec.maxFunctionSpan} lines.`,
        [{ value: Math.round(top.score * 10) / 10, basis: 'churn-per-file × largest function span in module' }],
        'Stabilize this module: add tests, split large functions, reduce churn surface.',
      );
    }
  }

  // ── 3. Least documented subsystem ─────────────────────────────────
  const modDocCoverage = new Map<string, { docs: number; codeFiles: number }>();
  for (const f of ws.files) {
    const m = f.relPath.match(/^(?:packages|apps)\/([^/]+)/);
    if (!m) continue;
    const mod = m[1];
    const rec = modDocCoverage.get(mod) ?? { docs: 0, codeFiles: 0 };
    if (f.isMarkdown || f.isPackageJson) rec.docs++;
    if (f.isSource) rec.codeFiles++;
    modDocCoverage.set(mod, rec);
  }
  const leastDoc = [...modDocCoverage.entries()]
    .map(([mod, rec]) => ({ mod, ratio: rec.docs / Math.max(1, rec.codeFiles + rec.docs), rec }))
    .sort((a, b) => a.ratio - b.ratio);
  const worst = leastDoc[0];
  if (worst && worst.rec.codeFiles > 3) {
    push(
      'documentation',
      'medium',
      `Least documented subsystem: '${worst.mod}' (${Math.round(worst.ratio * 100)}% docs)`,
      `${worst.rec.docs} doc/config files vs ${worst.rec.codeFiles} source files.`,
      [{ value: `${worst.rec.docs}/${worst.rec.codeFiles}`, basis: 'markdown+package.json vs source file counts in module' }],
      'Add README + architecture notes for this subsystem.',
    );
  }

  // ── 4. Most reused component ──────────────────────────────────────
  let mostReused: { file: string; importers: number } | null = null;
  for (const node of graph.nodes.values()) {
    const importers = node.importers.filter((i) => !i.includes('.test.'));
    if (importers.length > 0 && (!mostReused || importers.length > mostReused.importers)) {
      mostReused = { file: node.relPath, importers: importers.length };
    }
  }
  if (mostReused) {
    push(
      'reuse',
      'info',
      `Most reused component: ${mostReused.file} (${mostReused.importers} importers)`,
      'This module has the highest in-degree in the real import graph.',
      [{ file: mostReused.file, value: mostReused.importers, basis: 'import graph in-degree (excluding tests)' }],
      'Guard this component with tests and a stable public API.',
    );
  }

  // ── 5. Most fragile dependency ────────────────────────────────────
  const deprecated = findDeprecated(root);
  if (deprecated.length > 0) {
    push(
      'fragile-dependency',
      'high',
      `Deprecated dependencies: ${deprecated.slice(0, 4).join(', ')}${deprecated.length > 4 ? ` +${deprecated.length - 4}` : ''}`,
      'npm-deprecated packages found in installed node_modules metadata.',
      deprecated.slice(0, 5).map((d) => ({ value: d, basis: "real 'deprecated' field in node_modules/<pkg>/package.json" })),
      'Replace deprecated packages with maintained alternatives.',
    );
  }

  // ── 6. Duplication pressure ───────────────────────────────────────
  const candidates = ws.files.filter((f) => f.isSource && !f.isTest && f.lines >= 40).slice(0, 120);
  let topPair: { a: string; b: string; sim: number } | null = null;
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const sim = similarityScore(candidates[i].text, candidates[j].text);
      if (sim > 0.6 && (!topPair || sim > topPair.sim)) topPair = { a: candidates[i].relPath, b: candidates[j].relPath, sim };
    }
  }
  if (topPair) {
    push(
      'duplication',
      'medium',
      `Duplicate implementations: ${topPair.a} ≈ ${topPair.b} (${Math.round(topPair.sim * 100)}%)`,
      'Strongest copy-paste pair in the codebase.',
      [
        { file: topPair.a, value: Math.round(topPair.sim * 100) / 100, basis: 'normalized token similarity' },
        { file: topPair.b, value: Math.round(topPair.sim * 100) / 100, basis: 'normalized token similarity' },
      ],
      'Extract the shared logic into one module.',
    );
  }

  return {
    insights,
    topChangedFiles: churn.available ? [...churn.byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([file, changes]) => ({ file, changes })) : [],
    meta: {
      root,
      analyzedFiles: ws.files.length,
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - t0,
      unavailable: churn.available ? [] : ['git history unavailable'],
    },
  };
}

function findDeprecated(root: string): string[] {
  const out: string[] = [];
  const nm = path.posix.join(root, 'node_modules');
  try {
    statSync(nm);
  } catch {
    return out;
  }
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith('.')) continue;
      const full = path.posix.join(dir, name);
      const pkgJson = path.posix.join(full, 'package.json');
      let deprecated = '';
      try {
        const pkg = JSON.parse(readFileSync(pkgJson, 'utf8')) as { deprecated?: string };
        deprecated = pkg.deprecated ?? '';
      } catch {
        deprecated = '';
      }
      if (deprecated) out.push(name);
      if (!name.startsWith('@')) {
        try {
          if (statSync(full).isDirectory()) walk(full);
        } catch {
          // skip
        }
      }
    }
  };
  walk(nm);
  return out;
}

export function summarizeInsights(report: ProjectInsightsReport): string {
  return `Insights: ${report.insights.length} findings — ${report.insights.map((i) => i.title.split('(')[0].trim()).join('; ')}`.slice(0, 300);
}
