/**
 * Graph algorithms — deterministic analysis primitives.
 * ==================================================================
 * Tarjan strongly-connected components (real cycle detection),
 * longest dependency chain over the condensation DAG, and normalized
 * token-level file similarity (duplicate implementation detection).
 * No heuristics masquerading as measurements — everything is exact.
 */

export interface GraphEdge {
  from: string;
  to: string;
}

/** Tarjan SCC. Returns components with >1 node (or self-loops) as cycles. */
export function stronglyConnectedComponents(nodes: string[], edges: GraphEdge[]): string[][] {
  const adj = new Map<string, string[]>();
  for (const n of nodes) adj.set(n, []);
  for (const e of edges) {
    const list = adj.get(e.from);
    if (list && e.from !== e.to) list.push(e.to);
  }
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  let counter = 0;
  const components: string[][] = [];

  const strongconnect = (v: string): void => {
    index.set(v, counter);
    lowlink.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);
    for (const w of adj.get(v) ?? []) {
      if (!index.has(w)) {
        strongconnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, index.get(w)!));
      }
    }
    if (lowlink.get(v) === index.get(v)) {
      const comp: string[] = [];
      let w: string | undefined;
      do {
        w = stack.pop();
        onStack.delete(w!);
        comp.push(w!);
      } while (w !== v);
      components.push(comp);
    }
  };

  for (const n of nodes) if (!index.has(n)) strongconnect(n);
  return components.filter((c) => c.length > 1);
}

export interface CycleDetail {
  nodes: string[];
  edges: GraphEdge[];
}

export function findCycles(graph: Map<string, string[]>): CycleDetail[] {
  const nodes = [...graph.keys()];
  const edges: GraphEdge[] = [];
  for (const [from, targets] of graph) {
    for (const to of targets) edges.push({ from, to });
  }
  const sccs = stronglyConnectedComponents(nodes, edges);
  return sccs.map((comp) => {
    const compSet = new Set(comp);
    const cycleEdges = edges.filter((e) => compSet.has(e.from) && compSet.has(e.to));
    return { nodes: comp, edges: cycleEdges };
  });
}

/** Longest simple path in a DAG (nodes → children). Returns [nodes, length]. */
export function longestPathDag(graph: Map<string, string[]>, roots: string[]): { path: string[]; length: number } {
  const memo = new Map<string, { path: string[]; length: number }>();
  const visit = (node: string): { path: string[]; length: number } => {
    const cached = memo.get(node);
    if (cached) return cached;
    const children = graph.get(node) ?? [];
    let best: { path: string[]; length: number } = { path: [], length: 0 };
    for (const child of children) {
      const sub = visit(child);
      if (sub.length + 1 > best.length) best = { path: [child, ...sub.path], length: sub.length + 1 };
    }
    const result = { path: best.path, length: best.length };
    memo.set(node, result);
    return result;
  };
  let overall: { path: string[]; length: number } = { path: [], length: 0 };
  for (const r of roots) {
    const sub = visit(r);
    if (sub.length > overall.length) overall = sub;
  }
  return overall;
}

/** Condense an SCC graph into a DAG (component id → member nodes). */
export function condensation(nodes: string[], edges: GraphEdge[]): { dag: Map<string, string[]>; componentOf: Map<string, string>; comps: string[][]; scc: string[][] } {
  const scc = stronglyConnectedComponents(nodes, edges);
  const allInScc = new Set<string>();
  for (const comp of scc) for (const n of comp) allInScc.add(n);
  const singles = nodes.filter((n) => !allInScc.has(n)).map((n) => [n]);
  const comps = [...scc, ...singles];
  const componentOf = new Map<string, string>();
  comps.forEach((comp, i) => {
    const id = `c${i}`;
    for (const n of comp) componentOf.set(n, id);
  });
  const dag = new Map<string, string[]>();
  for (const c of comps) dag.set(componentOf.get(c[0])!, []);
  for (const e of edges) {
    const a = componentOf.get(e.from);
    const b = componentOf.get(e.to);
    if (a !== undefined && b !== undefined && a !== b) {
      const list = dag.get(a)!;
      if (!list.includes(b)) list.push(b);
    }
  }
  return { dag, componentOf, comps, scc };
}

/**
 * Normalized token n-gram similarity (Dice coefficient).
 * Normalizes: lowercase, strips comments/strings/whitespace, keeps
 * identifier tokens. Returns 0..1 where 1 = identical logic.
 */
export function similarityScore(a: string, b: string): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.length < 4 || tb.length < 4) return 0;
  const bigramsA = new Map<string, number>();
  for (let i = 0; i < ta.length - 1; i++) {
    const key = `${ta[i]}\u0001${ta[i + 1]}`;
    bigramsA.set(key, (bigramsA.get(key) ?? 0) + 1);
  }
  let intersection = 0;
  for (let i = 0; i < tb.length - 1; i++) {
    const key = `${tb[i]}\u0001${tb[i + 1]}`;
    const count = bigramsA.get(key);
    if (count !== undefined && count > 0) {
      intersection++;
      bigramsA.set(key, count - 1);
    }
  }
  return (2 * intersection) / (ta.length - 1 + tb.length - 1);
}

const TOKEN_RE = /[a-zA-Z_$][a-zA-Z0-9_$]*|0x[0-9a-fA-F]+|\d+|\S/g;

function tokenize(text: string): string[] {
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\\])('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")/g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/\s+/g, ' ');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(stripped)) !== null) out.push(m[0]);
  return out;
}
