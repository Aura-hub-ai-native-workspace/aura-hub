/**
 * Dead-code detector — real export scan + bounded cross-file import
 * search, NOT a graph lookup. The graph's `'imports'` relation only
 * fires for JSX-rendered component tags (see linker.ts), so it would
 * silently miss ~80% of real code. Graph `dependentFileCount` is used
 * only as a bonus corroborating signal, never the sole check.
 */
import fs from 'node:fs';
import path from 'node:path';
import { scanExports, scanImportedNames } from '../exportScan';
import { resolveRelativeSpecifier, scanSourceFiles } from '../repoScan';
import type { DetectorContext, DetectorResult } from '../types';

const NEVER_ELIGIBLE_KINDS = new Set([
  'route', 'page', 'endpoint', 'middleware', 'dockerfile', 'compose-service',
  'ci-pipeline', 'build-config', 'migration', 'env-var', 'dependency',
]);

export function detectDeadCode(ctx: DetectorContext): DetectorResult {
  const name = ctx.symbolName;
  const evidence: string[] = [];

  const isRealExport = Boolean(name) && scanExports(ctx.fileText).has(name as string);
  if (isRealExport) evidence.push(`\`${name}\` is a real export of ${ctx.relPath}`);

  const graphEntity = name ? ctx.entities.find((e) => e.relPath === ctx.relPath && e.name === name) : undefined;
  const isFrameworkEntryPoint = Boolean(graphEntity && NEVER_ELIGIBLE_KINDS.has(graphEntity.kind));
  if (isFrameworkEntryPoint) evidence.push(`\`${name}\` is a graph-recognized ${graphEntity!.kind} — framework-invoked, never eligible`);

  const { files, capHit, scanned } = isRealExport && !isFrameworkEntryPoint ? scanSourceFiles(ctx.projectPath, 40) : { files: [], capHit: false, scanned: 0 };
  let importerCount = 0;
  const importerEvidence: string[] = [];
  for (const f of files) {
    if (f.absPath === ctx.absFilePath) continue;
    for (const imp of scanImportedNames(f.text)) {
      if (imp.name !== name) continue;
      const resolved = resolveRelativeSpecifier(f.absPath, imp.specifier);
      if (resolved === ctx.absFilePath) {
        importerCount++;
        importerEvidence.push(`imported by ${f.relPath}`);
      }
    }
  }
  if (isRealExport && !isFrameworkEntryPoint) {
    evidence.push(
      importerCount === 0
        ? `No cross-file importer found across ${scanned} scanned source file(s)${capHit ? ' (scan capped at 40 files)' : ''}`
        : `${importerCount} cross-file importer(s) found: ${importerEvidence.slice(0, 5).join(', ')}`,
    );
  }

  // Barrel re-export check: does a sibling index.ts/.tsx re-export this name from this file?
  let barrelReExported = false;
  if (isRealExport && !isFrameworkEntryPoint && importerCount === 0) {
    const dir = path.dirname(ctx.absFilePath);
    const base = path.basename(ctx.absFilePath).replace(/\.[^.]+$/, '');
    for (const barrelName of ['index.ts', 'index.tsx', 'index.js']) {
      const barrelAbs = path.join(dir, barrelName);
      if (barrelAbs === ctx.absFilePath) continue;
      let text: string;
      try {
        text = fs.readFileSync(barrelAbs, 'utf8');
      } catch {
        continue;
      }
      const reExportRe = new RegExp(`export\\s*(?:\\{[^}]*\\b${name}\\b[^}]*\\}|\\*)\\s*from\\s*['"]\\.\\/${base}['"]`);
      if (reExportRe.test(text)) {
        barrelReExported = true;
        evidence.push(`re-exported from barrel ${barrelName}`);
        break;
      }
    }
  }

  const dependentFileCount = ctx.dependentFileCount;
  if (dependentFileCount === 0) evidence.push('Knowledge graph also shows 0 dependent files (bonus corroboration, not the sole check)');

  const checksRun = [
    { name: 'is a real export', fired: isRealExport },
    { name: 'not a framework-invoked entry point', fired: isRealExport && !isFrameworkEntryPoint },
    { name: 'zero cross-file importers found', fired: isRealExport && !isFrameworkEntryPoint && importerCount === 0 },
    { name: 'not re-exported from a sibling barrel', fired: isRealExport && !isFrameworkEntryPoint && importerCount === 0 && !barrelReExported },
  ];

  return { fires: checksRun.every((c) => c.fired), evidence, checksRun };
}
