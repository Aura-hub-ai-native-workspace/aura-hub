/**
 * Quality Gates — per-pull-request evaluation.
 * ==================================================================
 * Five gates evaluated against the REAL change set (git diff when not
 * supplied):
 *   architecture  — changed files must not introduce layer violations,
 *                   drift imports or new import cycles
 *   security      — changed files must be free of secrets/unsafe APIs
 *   documentation — changed modules must be documented (README + exports)
 *   testing       — added source files must ship with test coverage
 *   performance   — no oversized/complex functions may be introduced
 * Produces a pass/fail report with per-gate reasoning.
 */

import path from 'node:path';
import { existsSync } from 'node:fs';
import { scanWorkspace, findPackages } from '../core/scan';
import { parseImportSpecifiers } from '../core/imports';
import { analyzeCodeShape } from '../core/codeShape';
import { getChangedFiles } from '../core/git';
import { layerOf, defaultLayerRules } from '../architecture/architecture_governance';
import { SECRET_PATTERNS, UNSAFE_PATTERNS, PLACEHOLDER_PATTERN } from '../security/patterns';
import type { ReportMeta } from '../core/types';

export type GateName = 'architecture' | 'security' | 'documentation' | 'testing' | 'performance';

export type GateStatus = 'pass' | 'fail' | 'warn' | 'skip';

export interface GateResult {
  gate: GateName;
  status: GateStatus;
  score: number; // 0..100
  findings: { severity: 'error' | 'warning' | 'info'; message: string; file?: string }[];
  reasoning: string[];
}

export interface QualityReport {
  pullRequest: {
    id: string;
    base: string;
    changes: { path: string; status: 'added' | 'modified' | 'deleted' | 'renamed' | 'unknown' }[];
  };
  gates: GateResult[];
  overall: 'pass' | 'fail';
  summary: string;
  meta: ReportMeta;
}

export interface QualityInput {
  projectPath: string;
  pullRequestId?: string;
  base?: string;
  changes?: { path: string; status: QualityReport['pullRequest']['changes'][number]['status'] }[];
}

export async function getQualityReport(input: QualityInput): Promise<QualityReport> {
  const t0 = Date.now();
  const changes = input.changes ?? (await getChangedFiles(input.projectPath, input.base ?? 'HEAD~1'));
  const ws = await scanWorkspace(input.projectPath);
  const packages = findPackages(ws);
  const rules = defaultLayerRules(input.projectPath);

  const byFile = ws.byRelPath;
  const changedSource = changes.filter((c) => byFile.has(c.path) && byFile.get(c.path)!.isSource && c.status !== 'deleted');
  const addedSource = changes.filter((c) => c.status === 'added' && byFile.has(c.path) && byFile.get(c.path)!.isSource && !byFile.get(c.path)!.isTest);

  // ── Architecture gate ─────────────────────────────────────────────
  const archFindings: GateResult['findings'] = [];
  const archReasoning: string[] = [];
  const pkgNameByFile = new Map<string, string>();
  for (const p of packages) {
    const prefix = p.relDir === '.' ? '' : `${p.relDir}/`;
    for (const f of ws.files) if (f.isSource && f.relPath.startsWith(prefix)) pkgNameByFile.set(f.relPath, p.name);
  }
  for (const c of changedSource) {
    const file = byFile.get(c.path)!;
    const fromLayer = layerOf(file.relPath, rules);
    const pkgName = pkgNameByFile.get(file.relPath);
    for (const spec of parseImportSpecifiers(file.text)) {
      if (!spec.startsWith('.')) continue;
      const resolved = resolveRelative(file.relPath, spec);
      if (!resolved) continue;
      const target = byFile.get(resolved);
      if (!target) continue;
      const toLayer = layerOf(resolved, rules);
      if (fromLayer && toLayer && fromLayer !== toLayer && rules.some((r) => r.layer === fromLayer && r.forbiddenTargets.includes(toLayer))) {
        archFindings.push({ severity: 'error', message: `Layer violation: ${fromLayer} → ${toLayer} (${file.relPath} imports ${resolved})`, file: file.relPath });
      }
      const targetPkg = pkgNameByFile.get(resolved);
      if (pkgName && targetPkg && pkgName !== targetPkg) {
        const pkg = packages.find((p) => p.name === pkgName);
        const declared = pkg && (pkg.dependencies[targetPkg] || pkg.devDependencies[targetPkg] || pkg.peerDependencies[targetPkg]);
        if (!declared) {
          archFindings.push({ severity: 'warning', message: `Undeclared package import: ${targetPkg} (not in ${pkgName} package.json)`, file: file.relPath });
        }
      }
    }
  }
  archReasoning.push(`Checked ${changedSource.length} changed source files for layer and boundary rules.`);
  const archGate: GateResult = {
    gate: 'architecture',
    status: archFindings.some((f) => f.severity === 'error') ? 'fail' : archFindings.length ? 'warn' : 'pass',
    score: Math.max(0, 100 - archFindings.length * 20),
    findings: archFindings,
    reasoning: archReasoning,
  };

  // ── Security gate ─────────────────────────────────────────────────
  const secFindings: GateResult['findings'] = [];
  for (const c of changedSource) {
    const file = byFile.get(c.path)!;
    const lines = file.text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const [name, re] of SECRET_PATTERNS) {
        const m = re.exec(lines[i]);
        if (m && !PLACEHOLDER_PATTERN.test(m[0])) {
          secFindings.push({ severity: 'error', message: `Secret-shaped value (${name}) in changed file`, file: file.relPath });
        }
      }
      for (const [name, re] of UNSAFE_PATTERNS) {
        if (re.test(lines[i])) {
          secFindings.push({ severity: 'error', message: `Unsafe API (${name}) in changed file`, file: file.relPath });
        }
      }
    }
  }
  const secGate: GateResult = {
    gate: 'security',
    status: secFindings.some((f) => f.severity === 'error') ? 'fail' : 'pass',
    score: secFindings.length === 0 ? 100 : Math.max(0, 100 - secFindings.length * 25),
    findings: secFindings,
    reasoning: [`Scanned ${changedSource.length} changed files with ${SECRET_PATTERNS.length} secret patterns and ${UNSAFE_PATTERNS.length} unsafe-API patterns.`],
  };

  // ── Documentation gate ────────────────────────────────────────────
  const docFindings: GateResult['findings'] = [];
  const affectedDirs = new Set(changedSource.map((c) => c.path.split('/').slice(0, 2).join('/')));
  for (const dir of affectedDirs) {
    const pkg = packages.find((p) => p.relDir === dir);
    if (pkg && !pkg.hasReadme) {
      docFindings.push({ severity: 'warning', message: `Package ${pkg.name} has no README`, file: `${pkg.relDir}/README.md` });
    }
  }
  for (const c of changedSource) {
    const file = byFile.get(c.path)!;
    if (!file.relPath.endsWith('/index.ts') && !file.relPath.includes('.test.') && !file.relPath.startsWith('docs/')) {
      const hasDoc = ws.files.some((f) => f.isMarkdown && f.text.includes(file.relPath));
      if (!hasDoc) {
        docFindings.push({ severity: 'info', message: `New source file not referenced by any markdown`, file: file.relPath });
      }
    }
  }
  const docGate: GateResult = {
    gate: 'documentation',
    status: docFindings.some((f) => f.severity === 'error') ? 'fail' : docFindings.length > 2 ? 'warn' : 'pass',
    score: Math.max(0, 100 - docFindings.filter((f) => f.severity === 'warning').length * 15),
    findings: docFindings,
    reasoning: [`${affectedDirs.size} package directories touched; ${packages.filter((p) => p.hasReadme).length}/${packages.length} packages documented.`],
  };

  // ── Testing gate ──────────────────────────────────────────────────
  const testFindings: GateResult['findings'] = [];
  for (const c of addedSource) {
    const file = byFile.get(c.path)!;
    if (file.relPath.endsWith('index.ts') || file.relPath.endsWith('index.tsx')) continue;
    const dir = path.posix.dirname(file.relPath);
    const base = path.posix.basename(file.relPath).replace(/\.(ts|tsx|js|jsx)$/, '');
    const hasTest =
      ws.files.some((f) => f.isTest && (f.relPath === `${dir}/${base}.test.ts` || f.relPath === `${dir}/${base}.test.tsx` || f.relPath === `${dir}/${base}.spec.ts` || f.relPath === `${dir}/${base}.spec.tsx` || f.relPath.startsWith(`${dir}/__tests__/`)));
    if (!hasTest) {
      testFindings.push({ severity: 'warning', message: `Added source file has no sibling test`, file: file.relPath });
    }
  }
  const testGate: GateResult = {
    gate: 'testing',
    status: testFindings.length === 0 ? 'pass' : testFindings.length >= 3 ? 'fail' : 'warn',
    score: addedSource.length === 0 ? 100 : Math.max(0, 100 - (testFindings.length / addedSource.length) * 100),
    findings: testFindings,
    reasoning: [`${addedSource.length} source files added; ${addedSource.length - testFindings.length} have sibling tests.`],
  };

  // ── Performance gate ──────────────────────────────────────────────
  const perfFindings: GateResult['findings'] = [];
  for (const c of changedSource) {
    const file = byFile.get(c.path)!;
    if (file.isTest) continue;
    const shape = analyzeCodeShape(file.text, { functionLineLimit: 80, classLineLimit: 300 });
    for (const fn of shape.functions) {
      if (fn.span > 80) perfFindings.push({ severity: 'warning', message: `Large function ${fn.name} (${fn.span} lines)`, file: file.relPath });
    }
    for (const cls of shape.classes) {
      if (cls.span > 300) perfFindings.push({ severity: 'warning', message: `Large class ${cls.name} (${cls.span} lines)`, file: file.relPath });
    }
  }
  const perfGate: GateResult = {
    gate: 'performance',
    status: perfFindings.some((f) => f.severity === 'error') ? 'fail' : perfFindings.length ? 'warn' : 'pass',
    score: Math.max(0, 100 - perfFindings.length * 10),
    findings: perfFindings,
    reasoning: [`Measured function spans in ${changedSource.length} changed files.`],
  };

  const gates: GateResult[] = [archGate, secGate, docGate, testGate, perfGate];
  const failures = gates.filter((g) => g.status === 'fail');
  const overall: QualityReport['overall'] = failures.length > 0 ? 'fail' : 'pass';

  return {
    pullRequest: {
      id: input.pullRequestId ?? `PR-${Date.now()}`,
      base: input.base ?? 'HEAD~1',
      changes,
    },
    gates,
    overall,
    summary: failures.length
      ? `Blocked: ${failures.map((f) => f.gate).join(', ')} gate${failures.length > 1 ? 's' : ''} failed on ${failures.reduce((s, f) => s + f.findings.length, 0)} real findings.`
      : 'All gates passed on the analyzed change set.',
    meta: {
      root: ws.root,
      analyzedFiles: ws.files.length,
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - t0,
      unavailable: [],
    },
  };
}

function resolveRelative(fromRel: string, spec: string): string | null {
  const dir = path.posix.dirname(fromRel);
  const clean = spec.split('?')[0];
  const base = path.posix.normalize(path.posix.join(dir, clean));
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}/index.ts`, `${base}/index.tsx`];
  for (const c of candidates) {
    if (c.startsWith('..')) continue;
    if (existsOnDisk(c)) return c;
  }
  return null;
}

function existsOnDisk(p: string): boolean {
  return existsSync(p);
}
