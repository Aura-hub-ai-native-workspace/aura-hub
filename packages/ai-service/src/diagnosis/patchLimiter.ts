/**
 * patchLimiter — the deterministic Patch Limiter safety engine.
 * ==================================================================
 * Line-based (not AST-diff) on purpose: it must work even when the
 * patched text doesn't parse yet. `'auto-approved'` means "passed the
 * deterministic safety gates" — it NEVER means "written to disk
 * automatically." The file is only ever written from the explicit
 * `/accept` endpoint after a human click, regardless of this decision.
 */
import { countImportLines, scanExports } from './exportScan';
import { resolveCrossLayerImports } from './detectors/architectureSmell';
import type { EntityLayerRef, PatchLimiterResult, TargetRange } from './types';

const FUNCTION_DECL_LINE = /\bfunction\s+[\w$]+|=>\s*\{?|\bclass\s+[\w$]+/;

export function splicePatch(originalText: string, range: TargetRange, newText: string): string {
  const lines = originalText.split('\n');
  const before = lines.slice(0, range.startLine - 1);
  const after = lines.slice(range.endLine);
  return [...before, ...newText.split('\n'), ...after].join('\n');
}

export function evaluatePatchLimiter(
  originalFileText: string,
  targetRange: TargetRange,
  newText: string,
  absFilePath: string,
  projectPath: string,
  entities: EntityLayerRef[],
): { limiter: PatchLimiterResult; patchedFileText: string } {
  const originalLines = originalFileText.split('\n');
  const totalLines = originalLines.length;
  const linesRemoved = targetRange.endLine - targetRange.startLine + 1;
  const linesAdded = newText.split('\n').length;
  const percentRemoved = totalLines > 0 ? linesRemoved / totalLines : 0;
  const entireFileChanged = percentRemoved > 0.9 || (targetRange.startLine <= 1 && targetRange.endLine >= totalLines);

  const patchedFileText = splicePatch(originalFileText, targetRange, newText);

  const exportsBefore = scanExports(originalFileText);
  const exportsAfter = scanExports(patchedFileText);
  const exportsRemoved = [...exportsBefore].filter((e) => !exportsAfter.has(e));
  const exportsAdded = [...exportsAfter].filter((e) => !exportsBefore.has(e));

  const importsRemovedCount = Math.max(0, countImportLines(originalFileText) - countImportLines(patchedFileText));

  const beforeCross = resolveCrossLayerImports(originalFileText, absFilePath, projectPath, entities);
  const afterCross = resolveCrossLayerImports(patchedFileText, absFilePath, projectPath, entities);
  const violKey = (c: { specifier: string; resolvedRelPath: string }) => `${c.specifier}=>${c.resolvedRelPath}`;
  const beforeViolations = new Set(beforeCross.filter((c) => !c.allowed).map(violKey));
  const afterViolations = new Set(afterCross.filter((c) => !c.allowed).map(violKey));
  const architectureLayerChanged = beforeViolations.size !== afterViolations.size || [...beforeViolations].some((k) => !afterViolations.has(k)) || [...afterViolations].some((k) => !beforeViolations.has(k));

  const changedRegionLines = originalLines.slice(targetRange.startLine - 1, targetRange.endLine);
  const functionsModified = changedRegionLines.filter((l) => FUNCTION_DECL_LINE.test(l)).length;

  const reasons: string[] = [];
  let decision: PatchLimiterResult['decision'];
  if (percentRemoved > 0.3) {
    decision = 'auto-rejected';
    reasons.push(`> 30% of the file removed (${Math.round(percentRemoved * 100)}%)`);
  } else if (entireFileChanged) {
    decision = 'auto-rejected';
    reasons.push('entire file replaced');
  } else if (exportsRemoved.length > 0) {
    decision = 'auto-rejected';
    reasons.push(`export(s) removed: ${exportsRemoved.join(', ')}`);
  } else if (architectureLayerChanged) {
    decision = 'requires-manual-approval';
    reasons.push('this patch changes a cross-layer import violation (introduces or fixes one) — requires manual approval');
  } else {
    decision = 'auto-approved';
    reasons.push('passed all deterministic safety gates');
  }

  return {
    limiter: {
      decision,
      reasons,
      stats: { linesAdded, linesRemoved, percentRemoved, entireFileChanged, exportsRemoved, exportsAdded, functionsModified, importsRemovedCount, architectureLayerChanged },
    },
    patchedFileText,
  };
}
