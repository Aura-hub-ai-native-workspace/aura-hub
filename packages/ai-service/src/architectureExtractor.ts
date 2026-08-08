/**
 * Architecture Extractor — dynamic layered architecture from graphify's graph.json.
 * ==================================================================
 * Derives architecture tiers from a project's REAL structure — no hardcoded
 * directory-name patterns. Modules are the actual source directories, ordered
 * by dependency direction (consumers on top, foundations at the bottom), with
 * real file/function names as items and real entity counts. Every project
 * produces a visually distinct diagram.
 */

import { readJsonFile } from './persist';

interface GraphNode {
  id: string;
  label: string;
  source_file: string;
  community?: number;
  file_type?: string;
  _origin?: string;
}

interface GraphLink { source: string; target: string; relation?: string }
interface GraphJson { nodes: GraphNode[]; links?: GraphLink[] }

export interface LayerDef {
  title: string;
  subtitle?: string;
  items?: string[];
  color: string;
  width?: number;
}

/**
 * A real inter-layer dependency, aggregated from actual relation edges
 * whose endpoints resolve to two different modules. `from` depends on
 * `to` (same direction already used to rank layers top-to-bottom below —
 * `from` is the net "consumer" side of the relation, `to` the "foundation"
 * side); `weight` is how many individual entity-level relations it
 * represents. Layer titles are the join key (stable per response).
 */
export interface LayerEdge {
  from: string;
  to: string;
  weight: number;
}

export interface LayerStack {
  layers: LayerDef[];
  edges: LayerEdge[];
}

/** Distinct, vivid palette (looks good under the diagram's bloom pass). */
const PALETTE = [
  '#3b82f6', '#06b6d4', '#8b5cf6', '#a855f7', '#ec4899', '#f43f5e',
  '#f97316', '#eab308', '#22c55e', '#14b8a6', '#0ea5e9', '#6366f1',
];

/** Directory names that only *contain* modules — never a module themselves. */
const CONTAINER = new Set(['packages', 'apps', 'app', 'src', 'lib', 'source', 'sources', 'pkg', 'modules', 'crates']);

const MAX_MODULE_LAYERS = 9;

/**
 * The module a file belongs to: keep leading container dirs, then take the
 * first meaningful directory. e.g.
 *   packages/ai-service/src/pipeline.ts -> "packages/ai-service"
 *   src/screens/project/x.tsx           -> "src/screens"
 *   kernel/main.c                       -> "kernel"
 *   README.md                           -> "(root)"
 */
function moduleOf(sourceFile: string): string {
  const parts = sourceFile.split('/').filter(Boolean);
  if (parts.length <= 1) return '(root)';
  const dirs = parts.slice(0, -1);
  const out: string[] = [];
  for (const d of dirs) {
    out.push(d);
    if (!CONTAINER.has(d.toLowerCase())) break;
  }
  return out.join('/') || '(root)';
}

function prettyTitle(moduleKey: string): string {
  if (moduleKey === '(root)') return 'Root';
  const leaf = moduleKey.split('/').pop() ?? moduleKey;
  return leaf.replace(/[-_.]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}

function clip(s: string, n = 30): string {
  return s.length > n ? s.slice(0, n - 1) + '...' : s;
}

/** A source record + its module, plus the edge list — the common input both
 *  extraction sources (graphify graph.json and the FullStack graph) map to. */
interface Rec { id: string; label: string; module: string }
interface Edge { source: string; target: string }

function itemsFor(recs: Rec[], degree: Map<string, number>): string[] {
  return [...recs]
    .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0))
    .map((r) => clip(r.label))
    .filter((v, idx, arr) => arr.indexOf(v) === idx)
    .slice(0, 5);
}

/** Increments a two-level counter (outer key -> inner key -> count) without ever joining the keys into a single string. */
function bumpNested(map: Map<string, Map<string, number>>, outer: string, inner: string): void {
  let row = map.get(outer);
  if (!row) { row = new Map<string, number>(); map.set(outer, row); }
  row.set(inner, (row.get(inner) ?? 0) + 1);
}

/** Assemble a per-project layer stack from records + edges. */
function buildLayerStack(recs: Rec[], edges: Edge[], projectName?: string): LayerStack {
  if (recs.length === 0) return { layers: [], edges: [] };

  const degree = new Map<string, number>();
  const moduleOfNode = new Map<string, string>();
  const modules = new Map<string, Rec[]>();
  for (const r of recs) {
    moduleOfNode.set(r.id, r.module);
    (modules.get(r.module) ?? modules.set(r.module, []).get(r.module)!).push(r);
  }

  const outDeg = new Map<string, number>();
  const inDeg = new Map<string, number>();
  // Per-module-pair relation counts, computed alongside outDeg/inDeg (same
  // loop, same direction) so the real inter-layer connections don't get
  // thrown away after only their aggregate net-direction survives below.
  const pairWeight = new Map<string, Map<string, number>>();
  for (const e of edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    const gs = moduleOfNode.get(e.source);
    const gt = moduleOfNode.get(e.target);
    if (!gs || !gt || gs === gt) continue;
    outDeg.set(gs, (outDeg.get(gs) ?? 0) + 1);
    inDeg.set(gt, (inDeg.get(gt) ?? 0) + 1);
    bumpNested(pairWeight, gs, gt);
  }

  let entries = [...modules.entries()].filter(([, ns]) => ns.length >= 2);
  if (entries.length === 0) entries = [...modules.entries()];
  entries.sort((a, b) => b[1].length - a[1].length);
  let overflow: Rec[] = [];
  let overflowModuleKeys: string[] = [];
  if (entries.length > MAX_MODULE_LAYERS) {
    const dropped = entries.slice(MAX_MODULE_LAYERS);
    overflow = dropped.flatMap(([, ns]) => ns);
    overflowModuleKeys = dropped.map(([key]) => key);
    entries = entries.slice(0, MAX_MODULE_LAYERS);
  }
  // Order top-to-bottom: consumers (high out-in) first, foundations (high in) last.
  entries.sort((a, b) => {
    const sa = (outDeg.get(a[0]) ?? 0) - (inDeg.get(a[0]) ?? 0);
    const sb = (outDeg.get(b[0]) ?? 0) - (inDeg.get(b[0]) ?? 0);
    return sb !== sa ? sb - sa : b[1].length - a[1].length;
  });

  const layers: LayerDef[] = [{
    title: (projectName ?? 'Repository').toUpperCase(),
    subtitle: `${recs.length} entities, ${edges.length} relationships, ${entries.length} modules`,
    color: '#6366f1',
    width: 15,
  }];
  // Every module key that ends up represented in the diagram (kept, or
  // folded into "Other Modules") maps to the exact layer title it renders
  // as — needed to translate the module-pair counts above into the
  // layer-pair edges returned below.
  const titleForModule = new Map<string, string>();
  entries.forEach(([key, ns], i) => {
    const items = itemsFor(ns, degree);
    const title = prettyTitle(key);
    titleForModule.set(key, title);
    layers.push({ title, subtitle: `${ns.length} entities, ${key}`, items, color: PALETTE[i % PALETTE.length], width: items.length >= 4 ? 14 : 12 });
  });
  if (overflow.length) {
    const title = 'Other Modules';
    for (const key of overflowModuleKeys) titleForModule.set(key, title);
    layers.push({ title, subtitle: `${overflow.length} entities across smaller modules`, items: itemsFor(overflow, degree), color: '#64748b', width: 13 });
  }

  const layerEdgeWeight = new Map<string, Map<string, number>>();
  for (const [gs, row] of pairWeight) {
    const fromTitle = titleForModule.get(gs);
    if (!fromTitle) continue;
    for (const [gt, count] of row) {
      const toTitle = titleForModule.get(gt);
      // Both sides folded into the same bucket (e.g. two overflow modules
      // both landing in "Other Modules") — no real inter-layer edge to show.
      if (!toTitle || fromTitle === toTitle) continue;
      let outRow = layerEdgeWeight.get(fromTitle);
      if (!outRow) { outRow = new Map<string, number>(); layerEdgeWeight.set(fromTitle, outRow); }
      outRow.set(toTitle, (outRow.get(toTitle) ?? 0) + count);
    }
  }
  const layerEdges: LayerEdge[] = [];
  for (const [from, row] of layerEdgeWeight) {
    for (const [to, weight] of row) layerEdges.push({ from, to, weight });
  }

  return { layers, edges: layerEdges };
}

/** Primary source: graphify's graph.json (rich AST-level graph). */
export function extractArchitectureLayers(graphJsonPath: string, projectName?: string): LayerStack {
  const data = readJsonFile<GraphJson | null>(graphJsonPath, null);
  if (!data?.nodes?.length) return { layers: [], edges: [] };
  let nodes = data.nodes.filter((n) => n._origin === 'ast' && n.source_file);
  if (nodes.length === 0) nodes = data.nodes.filter((n) => n.source_file);
  const recs: Rec[] = nodes.map((n) => ({ id: n.id, label: n.label, module: moduleOf(n.source_file) }));
  const edges: Edge[] = (data.links ?? []).map((l) => ({ source: l.source, target: l.target }));
  return buildLayerStack(recs, edges, projectName);
}

/** Immediate fallback: derive layers straight from AURA's FullStack graph
 *  (always available for the mounted project — no graphify run needed). */
export function layersFromFullstack(
  entities: { id: string; name: string; relPath: string }[],
  relations: { from: string; to: string }[],
  projectName?: string,
): LayerStack {
  const recs: Rec[] = entities.filter((e) => e.relPath).map((e) => ({ id: e.id, label: e.name, module: moduleOf(e.relPath) }));
  const edges: Edge[] = relations.map((r) => ({ source: r.from, target: r.to }));
  return buildLayerStack(recs, edges, projectName);
}
