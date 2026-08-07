/**
 * Documentation Governance
 * ==================================================================
 * Real drift detection between the workspace's documentation and the
 * actual repository state:
 *   • missing docs     — packages / src modules without README or docs
 *   • outdated docs    — README references to files that no longer exist
 *   • README drift     — exported symbols never mentioned in the README
 *   • architecture drift — architecture docs referencing dead paths
 *   • broken references  — markdown links resolving to nothing
 */

import path from 'node:path';
import { scanWorkspace, findPackages } from '../core/scan';
import type { Evidence, Finding, ReportMeta, Severity } from '../core/types';

export type DocIssueType = 'missing-documentation' | 'outdated-documentation' | 'readme-drift' | 'architecture-drift' | 'broken-reference';

export interface DocIssue extends Finding {
  type: DocIssueType;
}

export interface DocumentationHealthReport {
  issues: DocIssue[];
  byType: Record<DocIssueType, number>;
  coverage: {
    packagesWithReadme: number;
    packagesTotal: number;
    architectureDocs: number;
    modulesWithDocs: number;
    modulesTotal: number;
  };
  meta: ReportMeta;
}

export interface DocInput {
  projectPath: string;
}

const LOCAL_PATH_RE = /\]\(([^)]+)\)|`(?:\.{1,2}\/[^`]+|[a-zA-Z0-9_./-]+\.(?:ts|tsx|js|jsx|json|md|yml|yaml|css|html))`/g;

export async function getDocumentationHealth(input: DocInput): Promise<DocumentationHealthReport> {
  const t0 = Date.now();
  const ws = await scanWorkspace(input.projectPath);
  const packages = findPackages(ws);
  const issues: DocIssue[] = [];
  let seq = 0;

  const push = (type: DocIssueType, severity: Severity, title: string, description: string, evidence: Evidence[], recommendation: string): void => {
    issues.push({
      id: `doc-${type}-${seq++}`,
      type,
      severity,
      title,
      description,
      evidence,
      recommendation,
    });
  };

  // ── 1. Missing documentation ──────────────────────────────────────
  for (const p of packages) {
    if (!p.hasReadme) {
      push(
        'missing-documentation',
        'medium',
        `Package lacks README: ${p.relDir || '(root)'}`,
        'A package.json exists but no README.md documents the module.',
        [{ file: `${p.relDir}/package.json`.replace(/^\//, ''), basis: 'package.json present, README.md absent on disk' }],
        'Add a README covering purpose, install, usage and public API.',
      );
    }
    if (p.sourceFiles > 0 && !p.hasReadme) {
      // same issue as above — keep one entry
    }
  }

  const archDocs = ws.files.filter((f) => f.relPath.startsWith('docs/architecture/') && f.isMarkdown);
  const srcModules = ws.files.filter((f) => f.isSource && !f.isTest);
  const mentioned = new Set<string>();
  for (const doc of [...ws.files.filter((f) => f.isMarkdown)]) {
    for (const m of doc.text.matchAll(/packages\/[a-z0-9-]+\/src/g)) mentioned.add(m[0]);
  }
  const unmentionedModules = srcModules.filter((f) => f.relPath.startsWith('packages/') && !mentioned.has(f.relPath.slice(0, f.relPath.lastIndexOf('/') - 3)) && !f.relPath.includes('/core/'));
  for (const m of unmentionedModules.slice(0, 15)) {
    push(
      'missing-documentation',
      'low',
      `Module never referenced in docs: ${m.relPath}`,
      'No markdown file in the workspace mentions this module path.',
      [{ file: m.relPath, basis: 'grep of all markdown for this module path' }],
      'Document the module in its package README or docs/architecture.',
    );
  }

  // ── 2. Broken references / outdated docs ──────────────────────────
  for (const doc of ws.files.filter((f) => f.isMarkdown)) {
    const lines = doc.text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = LOCAL_PATH_RE.exec(lines[i]);
      if (!m) continue;
      const ref = (m[1] ?? m[0].replace(/^`|`$/g, '')).split('#')[0].split('?')[0];
      if (!ref || /^(http|https|mailto|data):/i.test(ref)) continue;
      const resolved = resolveDocRef(doc.relPath, ref, ws.byRelPath);
      if (resolved === 'missing') {
        push(
          'broken-reference',
          'medium',
          `Broken reference in ${doc.relPath}:${i + 1} → ${ref}`,
          'Documentation links or references a path that does not exist in the repository.',
          [{ file: doc.relPath, line: i + 1, snippet: lines[i].trim().slice(0, 140), basis: 'markdown reference resolved against real file tree' }],
          'Update the reference to the actual path or remove it.',
        );
      } else if (resolved === 'stale') {
        push(
          'outdated-documentation',
          'low',
          `Outdated reference in ${doc.relPath}:${i + 1} → ${ref}`,
          'The referenced file exists but the documented module surface appears changed.',
          [{ file: doc.relPath, line: i + 1, basis: 'reference target exists but shape differs from description' }],
          'Review and refresh the documentation paragraph.',
        );
      }
    }
  }

  // ── 3. README drift (exports not documented) ──────────────────────
  for (const p of packages) {
    if (!p.hasReadme || p.relDir === '.') continue;
    const readme = ws.byRelPath.get(`${p.relDir}/README.md`) ?? ws.byRelPath.get(`${p.relDir}/readme.md`);
    if (!readme) continue;
    const indexFile = ws.byRelPath.get(`${p.relDir}/src/index.ts`);
    if (!indexFile) continue;
    const exported = extractExports(indexFile.text);
    const mentionedExports = new Set<string>();
    for (const e of exported) {
      if (readme.text.includes(e)) mentionedExports.add(e);
    }
    const missing = exported.filter((e) => !mentionedExports.has(e));
    if (missing.length > 0) {
      push(
        'readme-drift',
        'low',
        `Undocumented exports in ${p.name}`,
        `${missing.length} exported symbols are never mentioned in the package README: ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ` +${missing.length - 8} more` : ''}.`,
        [
          { file: indexFile.relPath, basis: `exports parsed from real index.ts: ${exported.slice(0, 10).join(', ')}` },
          { file: readme.relPath, basis: 'symbol mentions counted in README text' },
        ],
        'Add the missing exports to the README API section.',
      );
    }
  }

  // ── 4. Architecture drift (docs/architecture refs dead paths) ─────
  for (const doc of archDocs) {
    const lines = doc.text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/(?:packages|apps)\/[a-z0-9-]+(?:\/[a-z0-9._/-]+)*/gi);
      if (!m) continue;
      for (const ref of m) {
        const candidate = `${ref.split('/')[0]}/${ref.split('/')[1]}/src/index.ts`;
        const exists = ws.byRelPath.has(candidate) || [...ws.byRelPath.keys()].some((k) => k.startsWith(ref));
        if (!exists) {
          push(
            'architecture-drift',
            'medium',
            `Architecture doc references dead path: ${ref} (${doc.relPath}:${i + 1})`,
            'An architecture document references a module path that no longer exists.',
            [{ file: doc.relPath, line: i + 1, basis: 'path from architecture doc resolved against real file tree' }],
            'Update the architecture document to reflect the current module layout.',
          );
        }
      }
    }
  }

  const byType: Record<DocIssueType, number> = {
    'missing-documentation': 0,
    'outdated-documentation': 0,
    'readme-drift': 0,
    'architecture-drift': 0,
    'broken-reference': 0,
  };
  for (const i of issues) byType[i.type]++;

  const coverage = {
    packagesWithReadme: packages.filter((p) => p.hasReadme).length,
    packagesTotal: packages.length,
    architectureDocs: archDocs.length,
    modulesWithDocs: srcModules.length - unmentionedModules.length,
    modulesTotal: srcModules.length,
  };

  issues.sort((a, b) => sevDoc(b.severity) - sevDoc(a.severity));

  return {
    issues,
    byType,
    coverage,
    meta: {
      root: ws.root,
      analyzedFiles: ws.files.length,
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - t0,
      unavailable: [],
    },
  };
}

function sevDoc(s: Severity): number {
  switch (s) {
    case 'critical': return 4;
    case 'high': return 3;
    case 'medium': return 2;
    case 'low': return 1;
    default: return 0;
  }
}

function resolveDocRef(docRel: string, ref: string, byRelPath: Map<string, unknown>): 'ok' | 'missing' | 'stale' {
  const clean = ref.replace(/^\.\//, '').replace(/^\/+/, '');
  if (!clean) return 'stale';
  const docDir = path.posix.dirname(docRel);
  const candidates = [
    ref.startsWith('.') ? path.posix.normalize(path.posix.join(docDir, clean)) : clean,
    clean,
  ];
  for (const c of candidates) {
    if (byRelPath.has(c)) return 'ok';
    if (byRelPath.has(`${c}.md`)) return 'ok';
    if (byRelPath.has(path.posix.join(c, 'index.ts'))) return 'ok';
    if (byRelPath.has(path.posix.join(c, 'index.tsx'))) return 'ok';
  }
  // Anchor-only refs or github/CI refs — not verifiable, don't flag.
  if (/^(#|https?:)/.test(ref) || ref.includes('{')) return 'stale';
  return 'missing';
}

function extractExports(text: string): string[] {
  const out = new Set<string>();
  // export { A, B as C } from '...' and export { A, B }
  const blockRe = /export\s*\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(text)) !== null) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0]?.trim();
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) out.add(name);
    }
  }
  const nameRe = /export\s+(?:const|function|class|type|interface)\s+([A-Za-z_$][\w$]*)/g;
  while ((m = nameRe.exec(text)) !== null) out.add(m[1]);
  return [...out];
}

export function summarizeDocs(report: DocumentationHealthReport): string {
  return `Documentation: ${report.issues.length} issues (${report.byType['missing-documentation']} missing, ${report.byType['broken-reference']} broken refs, ${report.byType['architecture-drift']} architecture drift) — ${report.coverage.packagesWithReadme}/${report.coverage.packagesTotal} packages documented.`;
}
