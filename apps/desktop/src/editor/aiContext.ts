/**
 * aiContext — pure functions over the already-loaded knowledge graph.
 * ------------------------------------------------------------------
 * No network calls here: `graph` is the same `GraphView` Architecture.tsx
 * and Knowledge.tsx already consume via `useProjectData()` (zero extra
 * fetches). This is the single source of truth for what an AI action
 * would see right now — used by both the live AI Context Panel and the
 * action runner, so the panel never claims to know more than the action
 * actually gets sent.
 */
import type { ActionKind, CodeRelationRef, GraphEntity, GraphView, RiskLevel } from '../ai/aiClient';

export interface ResolvedSymbol {
  id: string;
  name: string;
  kind: string;
  line: number;
}

export interface SelectionContext {
  /** A line-proximity heuristic, NOT AST scope resolution — entities carry only a start line. */
  symbol: ResolvedSymbol | null;
  dependencies: CodeRelationRef[];
  dependents: CodeRelationRef[];
  dependentFileCount: number;
  referenceCount: number;
}

/** The nearest entity in `filePath` at or before `line` — a heuristic, never AST-precise. */
export function nearestSymbol(entities: GraphEntity[], filePath: string, line: number): GraphEntity | null {
  const inFile = entities
    .filter((e): e is GraphEntity & { line: number } => e.relPath === filePath && typeof e.line === 'number')
    .sort((a, b) => a.line - b.line);
  let best: GraphEntity | null = null;
  for (const e of inFile) {
    if (e.line <= line) best = e;
    else break;
  }
  return best;
}

/**
 * Real dependencies/references for the resolved symbol (or, when no
 * symbol resolves, the whole current file as a fallback scope) — derived
 * entirely from `graph.relations`, nothing invented.
 */
export function contextForSelection(graph: GraphView | null, filePath: string, cursorLine: number): SelectionContext {
  const empty: SelectionContext = { symbol: null, dependencies: [], dependents: [], dependentFileCount: 0, referenceCount: 0 };
  if (!graph) return empty;

  const byId = new Map(graph.entities.map((e) => [e.id, e]));
  const sym = nearestSymbol(graph.entities, filePath, cursorLine);
  const fileEntityIds = new Set(graph.entities.filter((e) => e.relPath === filePath).map((e) => e.id));
  const scopeIds = sym ? new Set([sym.id]) : fileEntityIds;

  const dependencies: CodeRelationRef[] = [];
  const dependents: CodeRelationRef[] = [];
  const dependentFiles = new Set<string>();

  for (const rel of graph.relations) {
    const fromInScope = scopeIds.has(rel.from);
    const toInScope = scopeIds.has(rel.to);
    if (fromInScope && !toInScope) {
      const target = byId.get(rel.to);
      if (target) dependencies.push({ id: target.id, name: target.name, kind: target.kind, relPath: target.relPath });
    } else if (toInScope && !fromInScope) {
      const source = byId.get(rel.from);
      if (source) {
        dependents.push({ id: source.id, name: source.name, kind: source.kind, relPath: source.relPath });
        if (source.relPath !== filePath) dependentFiles.add(source.relPath);
      }
    }
  }

  return {
    symbol: sym ? { id: sym.id, name: sym.name, kind: sym.kind, line: sym.line ?? 0 } : null,
    dependencies,
    dependents,
    dependentFileCount: dependentFiles.size,
    referenceCount: dependents.length,
  };
}

const SENSITIVE_PATTERN = /password|secret|token|api[_-]?key|process\.env|child_process|\bexec\(|\beval\(|drop\s+table|rm\s+-rf/i;

/** Deterministic risk floor from real numbers — the AI can add to this but never downgrade it (see server-side mergeRisk). */
export function riskFloor(action: ActionKind, ctx: SelectionContext, code: string): { level: RiskLevel; reasons: string[] } {
  const reasons: string[] = [];
  let rank = 0;
  const bump = (r: number, reason: string) => {
    if (r > rank) rank = r;
    reasons.push(reason);
  };

  if (ctx.dependentFileCount >= 5) bump(2, `Referenced across ${ctx.dependentFileCount} other files`);
  else if (ctx.dependentFileCount >= 1) bump(1, `Referenced in ${ctx.dependentFileCount} other file(s)`);

  if (ctx.referenceCount >= 8) bump(2, `${ctx.referenceCount} call sites depend on this`);

  if (SENSITIVE_PATTERN.test(code)) bump(2, 'Touches sensitive patterns (secrets, env vars, exec/eval, or destructive SQL/shell)');

  const lineCount = code.split('\n').length;
  if (lineCount > 120) bump(1, 'Large selection (120+ lines)');

  if (action === 'rename' && ctx.dependentFileCount > 0) {
    bump(2, `Rename affects ${ctx.referenceCount} reference(s) in other files this Phase-1 edit will not update`);
  }

  if (!reasons.length) reasons.push('No dependents or sensitive patterns detected');

  return { level: rank >= 2 ? 'high' : rank >= 1 ? 'medium' : 'safe', reasons };
}
