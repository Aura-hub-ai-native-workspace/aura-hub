/**
 * signals — Stage 1, real Failure Analysis. Gathers everything BEFORE
 * any AI call: file/symbol/imports/exports/dependency/reference data
 * from the real knowledge graph (server-side mirror of the client's
 * `aiContext.ts` — the backend can't import client code), plus what
 * the graph alone can't give: an export scan, cross-layer import
 * resolution, real git history/blame, test-file existence, doc/API/DB
 * relations, `ts.transpileModule` diagnostics, and a real memory recall.
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import type { Entity, Relation } from '@aura/knowledge-fullstack';
import type { PipelineManager } from '../pipeline';
import { resolveCrossLayerImports } from './detectors/architectureSmell';
import { scanExports, scanImportSpecifiers } from './exportScan';
import { resolveInsideProject } from './repoScan';
import { nearestDeclaredName, parseSource } from './tsHelpers';
import type { CodeRelationRef, DetectorContext, DiagnosisRequest, EntityLayerRef, FailureSignals } from './types';
import { gitBlame, gitHistory } from './gitSignals';

function toRef(e: Entity): CodeRelationRef {
  return { id: e.id, name: e.name, kind: e.kind, relPath: e.relPath };
}

function toLayerRef(e: Entity): EntityLayerRef {
  return { relPath: e.relPath, layer: e.layer, kind: e.kind, name: e.name };
}

/** Same line-proximity heuristic as the client's `aiContext.ts#nearestSymbol` — entities only carry a start line. */
function nearestSymbol(entities: Entity[], relPath: string, line: number): Entity | null {
  const inFile = entities.filter((e) => e.relPath === relPath && typeof e.line === 'number').sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
  let best: Entity | null = null;
  for (const e of inFile) {
    if ((e.line ?? 0) <= line) best = e;
    else break;
  }
  return best;
}

function relationRefs(entities: Entity[], relations: Relation[], relPath: string, symbol: Entity | null) {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const scopeIds = symbol ? new Set([symbol.id]) : new Set(entities.filter((e) => e.relPath === relPath).map((e) => e.id));
  const dependencies: CodeRelationRef[] = [];
  const dependents: CodeRelationRef[] = [];
  const dependentFiles = new Set<string>();
  for (const rel of relations) {
    const fromIn = scopeIds.has(rel.from);
    const toIn = scopeIds.has(rel.to);
    if (fromIn && !toIn) {
      const t = byId.get(rel.to);
      if (t) dependencies.push(toRef(t));
    } else if (toIn && !fromIn) {
      const s = byId.get(rel.from);
      if (s) {
        dependents.push(toRef(s));
        if (s.relPath !== relPath) dependentFiles.add(s.relPath);
      }
    }
  }
  return { dependencies, dependents, dependentFileCount: dependentFiles.size };
}

function findTestPaths(projectPath: string, absFilePath: string): { found: boolean; paths: string[] } {
  const dir = path.dirname(absFilePath);
  const ext = path.extname(absFilePath);
  const base = path.basename(absFilePath, ext);
  const candidates = [
    path.join(dir, `${base}.test${ext}`),
    path.join(dir, `${base}.spec${ext}`),
    path.join(dir, '__tests__', `${base}.test${ext}`),
    path.join(dir, '__tests__', `${base}.spec${ext}`),
  ];
  const found = candidates.filter((c) => { try { return fs.statSync(c).isFile(); } catch { return false; } });
  return { found: found.length > 0, paths: found.map((c) => path.relative(projectPath, c).split(path.sep).join('/')) };
}

function compilerDiagnostics(absFilePath: string, text: string, language: string): { message: string; line: number }[] {
  const compilerOptions: ts.CompilerOptions = { target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext };
  if (/tsx|jsx/i.test(language)) compilerOptions.jsx = ts.JsxEmit.Preserve;
  const result = ts.transpileModule(text, { fileName: absFilePath, reportDiagnostics: true, compilerOptions });
  return (result.diagnostics ?? []).map((d) => {
    const message = ts.flattenDiagnosticMessageText(d.messageText, ' ');
    const line = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : 0;
    return { message, line };
  });
}

export interface GatherResult {
  signals: FailureSignals;
  detectorContext: DetectorContext;
  absFilePath: string;
  fileText: string;
}

export async function gatherSignals(pipeline: PipelineManager, projectPath: string, req: DiagnosisRequest): Promise<GatherResult> {
  const absFilePath = resolveInsideProject(projectPath, req.filePath);
  const fileText = fs.readFileSync(absFilePath, 'utf8');
  const language = req.language;

  const { entities, relations } = pipeline.graphView() as { entities: Entity[]; relations: Relation[] };
  const relPath = req.filePath;
  const cursorLine = req.selectionRange?.startLine ?? 1;
  const graphSymbol = nearestSymbol(entities, relPath, cursorLine);
  const { dependencies, dependents, dependentFileCount } = relationRefs(entities, relations, relPath, graphSymbol);

  // Gap 2: plain, non-framework-shaped files never become graph entities at
  // all, so `graphSymbol` is null for most ordinary utility code — fall back
  // to a real textual declaration lookup rather than leaving every detector
  // with no symbol to work with.
  let symbol: { id: string; name: string; kind: string; line: number } | null = graphSymbol
    ? { id: graphSymbol.id, name: graphSymbol.name, kind: graphSymbol.kind, line: graphSymbol.line ?? 0 }
    : null;
  if (!symbol) {
    const declared = nearestDeclaredName(parseSource(absFilePath, fileText, language), cursorLine);
    if (declared) symbol = { id: `local:${relPath}#${declared.name}`, name: declared.name, kind: 'declaration', line: declared.line };
  }

  const layerRefs: EntityLayerRef[] = entities.map(toLayerRef);
  const architectureLayer = layerRefs.find((e) => e.relPath === relPath)?.layer ?? 'unknown';
  const crossLayerImports = architectureLayer !== 'unknown' ? resolveCrossLayerImports(fileText, absFilePath, projectPath, layerRefs) : [];

  const specifiers = scanImportSpecifiers(fileText);
  const imports = {
    local: specifiers.filter((s) => s.startsWith('.')),
    external: specifiers.filter((s) => !s.startsWith('.')),
  };
  const exportsList = [...scanExports(fileText)];

  const relatedDocs = dependencies.filter((d) => d.kind === 'doc' || d.kind === 'arch-module');
  const relatedApis = dependencies
    .filter((d) => d.kind === 'endpoint')
    .map((d) => ({ ...d }));
  const dbRelations = dependencies.filter((d) => d.kind === 'orm-model' || d.kind === 'table' || d.kind === 'migration');

  const [gitHistoryResult, gitBlameResult] = await Promise.all([
    gitHistory(projectPath, relPath),
    gitBlame(projectPath, relPath, req.selectionRange?.startLine ?? 1, req.selectionRange?.endLine ?? req.selectionRange?.startLine ?? 1),
  ]);

  const memoryRecall = pipeline.memory
    ? pipeline.memory.recall(`${symbol?.name ?? path.basename(relPath)} ${relPath}`, 4).map((m) => ({ id: m.id, kind: m.kind, title: m.title }))
    : [];

  const signals: FailureSignals = {
    file: { relPath, language, totalLines: fileText.split('\n').length },
    symbol: symbol ? { id: symbol.id, name: symbol.name, kind: symbol.kind, line: symbol.line ?? 0 } : null,
    imports,
    exports: exportsList,
    dependencies,
    dependents,
    dependentFileCount,
    architectureLayer,
    crossLayerImports,
    gitHistory: gitHistoryResult,
    gitBlame: gitBlameResult,
    relatedTests: findTestPaths(projectPath, absFilePath),
    relatedDocs,
    relatedApis,
    dbRelations,
    compilerDiagnostics: compilerDiagnostics(absFilePath, fileText, language),
    runtimeLogs: { unavailable: true, reason: 'no runtime log aggregation exists in this project' },
    memoryRecall,
  };

  const detectorContext: DetectorContext = {
    projectPath,
    absFilePath,
    relPath,
    language,
    fileText,
    selectionText: req.selectionRange ? sliceLines(fileText, req.selectionRange.startLine, req.selectionRange.endLine) : '',
    selectionRange: req.selectionRange ? { startLine: req.selectionRange.startLine, endLine: req.selectionRange.endLine } : null,
    symbolName: symbol?.name ?? null,
    entities: layerRefs,
    dependents,
    dependentFileCount,
  };

  return { signals, detectorContext, absFilePath, fileText };
}

function sliceLines(text: string, startLine: number, endLine: number): string {
  const lines = text.split('\n');
  return lines.slice(Math.max(0, startLine - 1), endLine).join('\n');
}
