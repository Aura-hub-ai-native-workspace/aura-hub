/**
 * Broken-API detector — real signature parse + bounded cross-file
 * caller search, NOT type-compatibility checking. Checks two purely
 * syntactic things per real caller: a named import that no longer
 * exists in this file's export list, and an argument-count mismatch
 * against the symbol's required parameters. If zero real callers exist
 * anywhere, this category cannot honestly fire — falls through to the
 * next detector (or `'unknown'`) rather than guessing.
 */
import ts from 'typescript';
import { scanExports, scanImportedNames } from '../exportScan';
import { resolveRelativeSpecifier, scanSourceFiles } from '../repoScan';
import { languageForPath, parseSignature, parseSource } from '../tsHelpers';
import type { DetectorContext, DetectorResult } from '../types';

interface CallSite {
  file: string;
  argCount: number;
  line: number;
}

function findCallSites(sf: ts.SourceFile, name: string): CallSite[] {
  const out: CallSite[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) {
      out.push({ file: sf.fileName, argCount: node.arguments.length, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Real files (capped) that import `name` from `absFilePath` — shared with Patch Simulation's reference re-check. */
export function findRealCallers(projectPath: string, absFilePath: string, name: string): { relPath: string }[] {
  const { files } = scanSourceFiles(projectPath, 40);
  const out: { relPath: string }[] = [];
  for (const f of files) {
    if (f.absPath === absFilePath) continue;
    const hit = scanImportedNames(f.text).some((imp) => imp.name === name && resolveRelativeSpecifier(f.absPath, imp.specifier) === absFilePath);
    if (hit) out.push({ relPath: f.relPath });
  }
  return out;
}

export function detectBrokenApi(ctx: DetectorContext): DetectorResult {
  const name = ctx.symbolName;
  const evidence: string[] = [];
  if (!name) return { fires: false, evidence: [], checksRun: [{ name: 'symbol resolved', fired: false }] };

  const sf = parseSource(ctx.absFilePath, ctx.fileText, ctx.language);
  const signature = parseSignature(sf, name);
  const currentExports = scanExports(ctx.fileText);
  const isRealExport = currentExports.has(name);

  if (signature) evidence.push(`\`${name}\` currently takes ${signature.requiredParamCount} required / ${signature.totalParamCount} total parameter(s)`);
  if (isRealExport) evidence.push(`\`${name}\` is a real export of ${ctx.relPath}`);

  const { files, capHit, scanned } = scanSourceFiles(ctx.projectPath, 40);
  let realCallerCount = 0;
  let brokenImportCount = 0;
  let argMismatchCount = 0;
  const brokenImportEvidence: string[] = [];
  const argMismatchEvidence: string[] = [];

  for (const f of files) {
    if (f.absPath === ctx.absFilePath) continue;
    const importsOfThisName = scanImportedNames(f.text).filter((imp) => imp.name === name && resolveRelativeSpecifier(f.absPath, imp.specifier) === ctx.absFilePath);
    if (!importsOfThisName.length) continue;
    realCallerCount++;

    if (!isRealExport) {
      brokenImportCount++;
      brokenImportEvidence.push(`${f.relPath} imports \`${name}\`, which is no longer exported`);
    }
    if (signature) {
      const callerSf = parseSource(f.absPath, f.text, languageForPath(f.absPath));
      for (const call of findCallSites(callerSf, name)) {
        if (call.argCount < signature.requiredParamCount) {
          argMismatchCount++;
          argMismatchEvidence.push(`${f.relPath}:${call.line} calls \`${name}(...)\` with ${call.argCount} argument(s), fewer than the ${signature.requiredParamCount} required`);
        }
      }
    }
  }

  evidence.push(
    realCallerCount === 0
      ? `No real caller found across ${scanned} scanned source file(s)${capHit ? ' (scan capped at 40 files)' : ''}`
      : `${realCallerCount} real caller file(s) found${capHit ? ' (scan capped at 40 files, more callers may exist)' : ''}`,
  );
  evidence.push(...brokenImportEvidence, ...argMismatchEvidence);

  if (ctx.dependents.length) evidence.push(`Knowledge graph shows ${ctx.dependents.length} related relation(s) (bonus corroboration, not the sole check)`);

  const checksRun = [
    { name: 'signature parsed for this symbol', fired: Boolean(signature) },
    { name: 'at least one real caller found', fired: realCallerCount > 0 },
    { name: 'broken import or argument-count mismatch detected in a real caller', fired: brokenImportCount > 0 || argMismatchCount > 0 },
  ];

  return { fires: checksRun.every((c) => c.fired), evidence, checksRun };
}
