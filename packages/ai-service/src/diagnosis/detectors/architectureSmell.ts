/**
 * Architecture-smell detector — resolves the current file's REAL import
 * specifiers (scanned from its own text — works even when this file has
 * no graph Entity, unlike relying on `Entity.metadata.imports`) to
 * target files, looks up each target's real `Entity.layer`, and checks
 * a small explicit allowed-edges matrix. Never uses `graph.relations`
 * (immune to the JSX-only `'imports'` relation gap).
 */
import path from 'node:path';
import { scanImportSpecifiers } from '../exportScan';
import { resolveRelativeSpecifier } from '../repoScan';
import type { CrossLayerImport, DetectorContext, DetectorResult, EntityLayerRef } from '../types';

const DISALLOWED: Record<string, Set<string>> = {
  frontend: new Set(['backend', 'database']),
};

function fileLayerMap(entities: EntityLayerRef[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of entities) if (!m.has(e.relPath)) m.set(e.relPath, e.layer);
  return m;
}

/** Re-used unchanged by the Patch Limiter's `architectureLayerChanged` before/after check. */
export function resolveCrossLayerImports(fileText: string, absFilePath: string, projectRoot: string, entities: EntityLayerRef[]): CrossLayerImport[] {
  const layerMap = fileLayerMap(entities);
  const out: CrossLayerImport[] = [];
  for (const specifier of scanImportSpecifiers(fileText)) {
    const resolvedAbs = resolveRelativeSpecifier(absFilePath, specifier);
    if (!resolvedAbs) continue;
    const resolvedRelPath = path.relative(projectRoot, resolvedAbs).split(path.sep).join('/');
    const targetLayer = layerMap.get(resolvedRelPath);
    if (!targetLayer) continue;
    const currentRelPath = path.relative(projectRoot, absFilePath).split(path.sep).join('/');
    const currentLayer = layerMap.get(currentRelPath);
    if (!currentLayer) continue;
    const allowed = !(DISALLOWED[currentLayer]?.has(targetLayer) ?? false);
    out.push({ specifier, resolvedRelPath, targetLayer, allowed });
  }
  return out;
}

export function detectArchitectureSmell(ctx: DetectorContext): DetectorResult {
  const layerMap = fileLayerMap(ctx.entities);
  const currentLayer = layerMap.get(ctx.relPath);
  const evidence: string[] = [];
  if (currentLayer) evidence.push(`${ctx.relPath} is a known \`${currentLayer}\` layer file (from the knowledge graph)`);

  const crossLayerImports = currentLayer ? resolveCrossLayerImports(ctx.fileText, ctx.absFilePath, ctx.projectPath, ctx.entities) : [];
  const violations = crossLayerImports.filter((c) => !c.allowed);
  for (const v of violations) evidence.push(`imports \`${v.specifier}\` → ${v.resolvedRelPath} (\`${v.targetLayer}\` layer) — disallowed from \`${currentLayer}\``);
  if (currentLayer && !violations.length) evidence.push(`${crossLayerImports.length} cross-layer import(s) checked, none disallowed`);

  const checksRun = [
    { name: 'current file layer resolved from knowledge graph', fired: Boolean(currentLayer) },
    { name: 'disallowed cross-layer import detected', fired: violations.length > 0 },
  ];

  return { fires: checksRun.every((c) => c.fired), evidence, checksRun };
}
