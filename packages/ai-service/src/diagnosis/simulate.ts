/**
 * simulate — Patch Simulation. Never trusts the patch: real, bounded
 * checks only. `ts.transpileModule` gives syntax + local diagnostics
 * only (no cross-file type-checking — explicit scope cut, stated in
 * `notes` every time). Test discovery is existence-only and NEVER
 * executes anything — `notes` always says so, regardless of outcome,
 * so it can never be misread as "tests passed."
 */
import ts from 'typescript';
import { detectArchitectureSmell } from './detectors/architectureSmell';
import { detectBrokenApi, findRealCallers } from './detectors/brokenApi';
import { detectDeadCode } from './detectors/deadCode';
import { detectNullBug } from './detectors/nullBug';
import type { BugCategory, CodeRelationRef, DetectorContext, ImpactReport } from './types';

const DETECTOR_BY_CATEGORY: Record<Exclude<BugCategory, 'unknown'>, (ctx: DetectorContext) => ReturnType<typeof detectNullBug>> = {
  'null-bug': detectNullBug,
  'dead-code': detectDeadCode,
  'broken-api': detectBrokenApi,
  'architecture-smell': detectArchitectureSmell,
};

function compileCheck(absFilePath: string, patchedFileText: string, language: string): { compiled: boolean; diagnostics: { message: string; line: number }[] } {
  const compilerOptions: ts.CompilerOptions = { target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext };
  if (/tsx|jsx/i.test(language)) compilerOptions.jsx = ts.JsxEmit.Preserve;
  const result = ts.transpileModule(patchedFileText, { fileName: absFilePath, reportDiagnostics: true, compilerOptions });
  const diagnostics = (result.diagnostics ?? []).map((d) => ({
    message: ts.flattenDiagnosticMessageText(d.messageText, ' '),
    line: d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : 0,
  }));
  return { compiled: diagnostics.length === 0, diagnostics };
}

export function simulatePatch(
  category: BugCategory,
  originalCtx: DetectorContext,
  patchedFileText: string,
  exportsRemoved: string[],
  relatedTests: { found: boolean; paths: string[] },
): ImpactReport {
  const { compiled, diagnostics } = compileCheck(originalCtx.absFilePath, patchedFileText, originalCtx.language);

  let categoryStillPresent = false;
  if (category !== 'unknown') {
    const patchedCtx: DetectorContext = { ...originalCtx, fileText: patchedFileText };
    categoryStillPresent = DETECTOR_BY_CATEGORY[category](patchedCtx).fires;
  }

  const referencesBroken: CodeRelationRef[] = exportsRemoved.flatMap((name) =>
    findRealCallers(originalCtx.projectPath, originalCtx.absFilePath, name).map((c) => ({ id: `${c.relPath}#${name}`, name, kind: 'import', relPath: c.relPath })),
  );

  const notes = [
    'Syntax and local diagnostics only — does not type-check across files.',
    "Not run: this pass does not execute the project's test suite.",
  ];
  if (exportsRemoved.length) notes.push(`Reference re-check covered ${exportsRemoved.length} removed export(s), capped at 40 scanned files.`);

  return {
    compiled,
    diagnostics,
    categoryStillPresent,
    referencesBroken,
    testsFound: relatedTests.found,
    testFilePaths: relatedTests.paths,
    notes,
  };
}
