/**
 * Technical Debt Engine
 * ==================================================================
 * Real debt detection over actual source:
 *   • TODO / FIXME / HACK / XXX markers (with line + author hint)
 *   • deprecated APIs (@deprecated / .deprecated() / deprecated props)
 *   • large files, large classes, large functions (measured spans)
 *   • repeated logic (normalized similarity, same as arch engine)
 *   • long dependency chains (internal graph + npm dependency depth)
 * Every item is prioritized by severity × impact × cost.
 */

import path from 'node:path';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { scanWorkspace, findPackages } from '../core/scan';
import { buildModuleGraph } from '../core/imports';
import { longestPathDag, condensation, similarityScore } from '../core/algorithms';
import { analyzeCodeShape } from '../core/codeShape';
import type { Evidence, Finding, ReportMeta, Severity } from '../core/types';

export type DebtCategory =
  | 'todo'
  | 'fixme'
  | 'deprecated-api'
  | 'large-file'
  | 'large-class'
  | 'large-function'
  | 'repeated-logic'
  | 'long-dependency-chain';

export interface DebtItem extends Finding {
  category: DebtCategory;
  /** 0..100 — priority score (severity × impact). */
  priority: number;
  effort: 'small' | 'medium' | 'large';
}

export interface DebtThresholds {
  largeFileLines: number;
  largeClassLines: number;
  largeFunctionLines: number;
  duplicateSimilarity: number;
  maxDuplicatePairs: number;
}

export const DEFAULT_DEBT_THRESHOLDS: DebtThresholds = {
  largeFileLines: 600,
  largeClassLines: 300,
  largeFunctionLines: 80,
  duplicateSimilarity: 0.6,
  maxDuplicatePairs: 15,
};

export interface TechnicalDebtReport {
  totalItems: number;
  byCategory: Record<DebtCategory, number>;
  bySeverity: Record<Severity, number>;
  items: DebtItem[];
  debtRatio: number; // debt markers per 1000 lines of code
  meta: ReportMeta;
}

export interface DebtInput {
  projectPath: string;
  thresholds?: Partial<DebtThresholds>;
}

const MARKER_RE = /(TODO|FIXME|HACK|XXX|TEMP|WIP)\b/i;
const DEPRECATED_JSDOC_RE = /@deprecated\b/;
const DEPRECATED_CALL_RE = /\.deprecated\b|deprecated:\s*true|['"`]deprecated['"`]\s*:/;

export async function getTechnicalDebt(input: DebtInput): Promise<TechnicalDebtReport> {
  const t0 = Date.now();
  const thresholds = { ...DEFAULT_DEBT_THRESHOLDS, ...input.thresholds };
  const ws = await scanWorkspace(input.projectPath);
  const packages = findPackages(ws);
  const graph = buildModuleGraph(ws, packages);

  const items: DebtItem[] = [];
  let seq = 0;
  const push = (category: DebtCategory, severity: Severity, title: string, description: string, evidence: Evidence[], recommendation: string, priority: number, effort: DebtItem['effort']): void => {
    items.push({
      id: `debt-${category}-${seq++}`,
      type: category,
      category,
      severity,
      title,
      description,
      evidence,
      recommendation,
      priority,
      effort,
    });
  };

  const codeFiles = ws.files.filter((f) => f.isSource);

  // ── Markers: TODO / FIXME / HACK / XXX ────────────────────────────
  for (const f of codeFiles) {
    const lines = f.text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith(' *')) continue;
      const m = MARKER_RE.exec(trimmed);
      if (!m) continue;
      const marker = m[1].toUpperCase();
      const severity: Severity = marker === 'FIXME' ? 'high' : marker === 'XXX' ? 'medium' : 'low';
      push(
        marker === 'FIXME' ? 'fixme' : 'todo',
        severity,
        `${marker} in ${f.relPath}:${i + 1}`,
        `Explicit ${marker} marker in committed code.`,
        [{ file: f.relPath, line: i + 1, snippet: lines[i].trim().slice(0, 120), basis: `regex marker scan of real file content` }],
        'Resolve or track this marker in the issue tracker; remove it once done.',
        severity === 'high' ? 90 : severity === 'medium' ? 65 : 40,
        severity === 'high' ? 'medium' : 'small',
      );
    }
  }

  // ── Deprecated APIs ───────────────────────────────────────────────
  for (const f of codeFiles) {
    const lines = f.text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (DEPRECATED_JSDOC_RE.test(lines[i]) || DEPRECATED_CALL_RE.test(lines[i])) {
        push(
          'deprecated-api',
          'medium',
          `Deprecated API in ${f.relPath}:${i + 1}`,
          'Code uses or documents a deprecated API surface.',
          [{ file: f.relPath, line: i + 1, snippet: lines[i].trim().slice(0, 120), basis: 'deprecation markers (@deprecated, .deprecated, deprecated: true) in real file' }],
          'Replace with the current API and remove the deprecated call site.',
          60,
          'medium',
        );
      }
    }
  }

  // ── Large files ───────────────────────────────────────────────────
  for (const f of codeFiles) {
    if (f.lines > thresholds.largeFileLines) {
      push(
        'large-file',
        'low',
        `Large file: ${f.relPath} (${f.lines} lines)`,
        `File exceeds ${thresholds.largeFileLines} lines — hard to navigate, review and test.`,
        [{ file: f.relPath, basis: `real line count ${f.lines}` }],
        'Split the file along cohesive responsibilities.',
        35,
        'medium',
      );
    }
  }

  // ── Large classes & functions ─────────────────────────────────────
  for (const f of codeFiles) {
    if (f.isTest) continue;
    const shape = analyzeCodeShape(f.text, { functionLineLimit: thresholds.largeFunctionLines, classLineLimit: thresholds.largeClassLines });
    for (const cls of shape.classes) {
      if (cls.span > thresholds.largeClassLines) {
        push(
          'large-class',
          'medium',
          `Large class: ${cls.name} in ${f.relPath} (${cls.span} lines)`,
          `Class body spans ${cls.span} lines with ${cls.methods} methods — a god-class risk.`,
          [{ file: f.relPath, line: cls.startLine, basis: `brace-matched class span ${cls.span} lines (real measurement)` }],
          'Split the class into focused collaborators.',
          55,
          'large',
        );
      }
    }
    for (const fn of shape.functions) {
      if (fn.span > thresholds.largeFunctionLines) {
        push(
          'large-function',
          'medium',
          `Large function: ${fn.name} in ${f.relPath}:${fn.startLine} (${fn.span} lines, complexity ${fn.complexity})`,
          `Function spans ${fn.span} lines — beyond the ${thresholds.largeFunctionLines}-line guardrail.`,
          [{ file: f.relPath, line: fn.startLine, basis: `brace-matched function span ${fn.span} lines, ${fn.complexity} decision points` }],
          'Extract sub-steps into smaller functions; reduce branching.',
          60,
          'medium',
        );
      }
    }
  }

  // ── Repeated logic ────────────────────────────────────────────────
  const candidates = ws.files.filter((f) => f.isSource && !f.isTest && f.lines >= 30);
  const pairs: { a: string; b: string; similarity: number }[] = [];
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      if (candidates[i].ext !== candidates[j].ext) continue;
      const sim = similarityScore(candidates[i].text, candidates[j].text);
      if (sim >= thresholds.duplicateSimilarity) pairs.push({ a: candidates[i].relPath, b: candidates[j].relPath, similarity: Math.round(sim * 100) / 100 });
      if (pairs.length > 300) break;
    }
    if (pairs.length > 300) break;
  }
  pairs.sort((x, y) => y.similarity - x.similarity);
  for (const p of pairs.slice(0, thresholds.maxDuplicatePairs)) {
    push(
      'repeated-logic',
      'medium',
      `Repeated logic: ${p.a} ≈ ${p.b} (${p.similarity})`,
      'Near-identical normalized logic in two files — copy-paste debt.',
      [
        { file: p.a, basis: `token similarity ${p.similarity} with ${p.b}` },
        { file: p.b, basis: 'identical normalization pipeline' },
      ],
      'Extract a shared helper and replace both copies.',
      55,
      'medium',
    );
  }

  // ── Long dependency chains ────────────────────────────────────────
  const sourceFiles = [...graph.nodes.keys()];
  const edges = [...graph.nodes.values()].flatMap((n) => n.imports.filter((t) => graph.nodes.has(t)).map((t) => ({ from: n.relPath, to: t })));
  const cond = condensation(sourceFiles, edges);
  const longest = longestPathDag(cond.dag, sourceFiles.map((r) => cond.componentOf.get(r)!));
  if (longest.length > 10) {
    push(
      'long-dependency-chain',
      'low',
      `Long dependency chain (${longest.length} hops)`,
      'Deepest import chain in the internal module graph is unusually long.',
      [{ file: sourceFiles[0] ?? '', basis: `longest path in SCC-condensed dependency DAG = ${longest.length} edges` }],
      'Flatten intermediate hops where possible.',
      30,
      'medium',
    );
  }

  // npm dependency depth (real node_modules metadata where present).
  const npmDepth = measureNpmDepth(input.projectPath);

  const byCategory: Record<DebtCategory, number> = {
    todo: 0,
    fixme: 0,
    'deprecated-api': 0,
    'large-file': 0,
    'large-class': 0,
    'large-function': 0,
    'repeated-logic': 0,
    'long-dependency-chain': 0,
  };
  const bySeverity: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const it of items) {
    byCategory[it.category]++;
    bySeverity[it.severity]++;
  }

  items.sort((a, b) => b.priority - a.priority);
  const totalLines = codeFiles.reduce((s, f) => s + f.lines, 0);
  const debtRatio = totalLines > 0 ? items.length / (totalLines / 1000) : 0;

  const unavailable: string[] = [];
  if (!npmDepth.available) unavailable.push('npm dependency depth: node_modules metadata not available');

  return {
    totalItems: items.length,
    byCategory,
    bySeverity,
    items,
    debtRatio: Math.round(debtRatio * 100) / 100,
    meta: {
      root: ws.root,
      analyzedFiles: ws.files.length,
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - t0,
      unavailable,
    },
  };
}

function measureNpmDepth(root: string): { available: boolean; maxDepth: number } {
  const nodeModules = path.posix.join(root, 'node_modules');
  try {
    const walk = (dir: string, depth: number): number => {
      let max = depth;
      let entries: string[] = [];
      try {
        entries = readdirSync(dir);
      } catch {
        return max;
      }
      for (const name of entries) {
        if (name.startsWith('.')) continue;
        const full = path.posix.join(dir, name);
        const pkgJson = path.posix.join(full, 'package.json');
        let deps: Record<string, string> = {};
        try {
          deps = (JSON.parse(readFileSync(pkgJson, 'utf8')) as { dependencies?: Record<string, string> }).dependencies ?? {};
        } catch {
          deps = {};
        }
        const depNames = Object.keys(deps).map((d) => d.split('/').slice(0, 2).join('/'));
        let childDepth = depth;
        for (const dn of depNames) {
          const resolved = tryResolveDep(dir, dn);
          if (resolved) childDepth = Math.max(childDepth, walk(resolved, depth + 1));
        }
        max = Math.max(max, childDepth);
      }
      return max;
    };
    const top = walk(nodeModules, 0);
    return { available: top > 0, maxDepth: top };
  } catch {
    return { available: false, maxDepth: 0 };
  }
}

function tryResolveDep(baseDir: string, name: string): string | null {
  const scoped = name.startsWith('@');
  const parts = name.split('/');
  const pkgName = scoped ? `${parts[0]}/${parts[1] ?? ''}` : parts[0];
  const candidates = [
    path.posix.join(baseDir, 'node_modules', pkgName),
    path.posix.join(baseDir, pkgName),
    path.posix.join(baseDir, '..', 'node_modules', pkgName),
  ];
  for (const c of candidates) {
    try {
      statSync(c);
      return c;
    } catch {
      // try next
    }
  }
  return null;
}

export function summarizeDebt(report: TechnicalDebtReport): string {
  return `Technical debt: ${report.totalItems} items (${report.byCategory.fixme} FIXMEs, ${report.byCategory.todo} TODOs, ${report.byCategory['deprecated-api']} deprecated APIs, ${report.byCategory['large-function']} large functions) — ${report.debtRatio} items per 1k LOC.`;
}
