import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import ForceGraph3D from '3d-force-graph';
import { Icon, Input } from '@aura/ui';
import type { GraphCanvasNode, GraphCanvasEdge } from './GraphCanvas';
import { GraphLegend, GraphCanvas } from './GraphCanvas';

/**
 * GraphCanvas3D — an industrial-grade interactive 3D force-directed graph.
 * ==================================================================
 * Wraps 3d-force-graph (three.js + d3-force-3d). Nodes are sized by their
 * connection count (hubs stand out), edges are directional (arrows show who
 * depends on whom) with animated flow particles, and hovering a node lights
 * up its immediate neighbourhood while everything else dims — the signature
 * "living map of the codebase" interaction. Falls back to a 2D SVG graph if
 * WebGL is unavailable or initialisation fails.
 */

interface Graph3DNode extends Record<string, unknown> {
  id: string;
  label: string;
  group: string;
}
interface Graph3DLink { source: unknown; target: unknown; kind?: string }

const linkEnd = (x: unknown): string => (x && typeof x === 'object' ? String((x as { id: string }).id) : String(x));

/** Probe once whether the browser can create a WebGL context. */
function hasWebGL(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl'));
  } catch { return false; }
}
const WEBGL_OK = hasWebGL();

// Module-level guard: prevents React strict-mode double-mount from creating
// two live renderers on the same container.
const liveContainers = new WeakSet<HTMLElement>();

function InnerGraphCanvas3D({
  nodes,
  edges,
  groupColors,
  height,
  onSelect,
  selectedId,
}: {
  nodes: GraphCanvasNode[];
  edges: GraphCanvasEdge[];
  groupColors: Record<string, string>;
  height: number;
  onSelect?: (node: GraphCanvasNode | null) => void;
  selectedId?: string | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<ReturnType<typeof ForceGraph3D> | null>(null);
  const [query, setQuery] = useState('');
  const [initError, setInitError] = useState(false);

  const nodesRef = useRef(nodes); nodesRef.current = nodes;
  const edgesRef = useRef(edges); edgesRef.current = edges;
  const onSelectRef = useRef(onSelect); onSelectRef.current = onSelect;

  // Degree per node (drives sphere size — hubs become bigger).
  const degRef = useRef<Record<string, number>>({});
  const deg: Record<string, number> = {};
  for (const e of edges) { deg[e.from] = (deg[e.from] ?? 0) + 1; deg[e.to] = (deg[e.to] ?? 0) + 1; }
  degRef.current = deg;

  const graph3dNodes = useMemo(
    () => nodes.map((n) => ({ id: n.id, label: n.label, group: n.group, type: n.type, relPath: n.relPath, line: n.line, detail: n.detail })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nodes.length, nodes.map((n) => n.id).join(',')],
  );
  const graph3dLinks = useMemo(
    () =>
      edges
        .filter((e) => nodes.some((n) => n.id === e.from) && nodes.some((n) => n.id === e.to))
        .map((e) => ({ source: e.from, target: e.to, kind: e.kind })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [edges.length, edges.map((e) => `${e.from}-${e.to}`).join(',')],
  );

  useEffect(() => {
    if (!containerRef.current) return;
    if (!WEBGL_OK) { setInitError(true); return; }
    const el = containerRef.current;
    if (liveContainers.has(el)) return;
    liveContainers.add(el);

    let destroyed = false;
    let graph: ReturnType<typeof ForceGraph3D> | null = null;
    let ro: ResizeObserver | null = null;

    const doInit = () => {
      if (destroyed || !el) return;
      el.innerHTML = '';
      const w = el.clientWidth || 600;
      const h = el.clientHeight || height;

      // Highlight state (id-based so it survives d3's link-object mutation).
      const hi = new Set<string>();
      let hoverId: string | null = null;
      const baseColor = (n: Graph3DNode) => groupColors[n.group] ?? '#8892a6';
      const isHot = (l: Graph3DLink) => linkEnd(l.source) === hoverId || linkEnd(l.target) === hoverId;

      // Named accessors — re-applied on hover to force a refresh.
      const nodeValFn = (node: Record<string, unknown>) => (degRef.current[(node as Graph3DNode).id] ?? 0) + 1;
      const nodeColorFn = (node: Record<string, unknown>) => {
        const n = node as Graph3DNode;
        if (!hi.size) return baseColor(n);
        if (n.id === hoverId) return '#ffffff';
        return hi.has(n.id) ? baseColor(n) : 'rgba(70,80,100,0.14)';
      };
      const linkColorFn = (link: Record<string, unknown>) => {
        const l = link as unknown as Graph3DLink;
        if (!hi.size) return 'rgba(110,140,210,0.16)';
        return isHot(l) ? 'rgba(150,190,255,0.85)' : 'rgba(70,80,100,0.05)';
      };
      const linkWidthFn = (link: Record<string, unknown>) => {
        const l = link as unknown as Graph3DLink;
        if (!hi.size) return 0.5;
        return isHot(l) ? 1.6 : 0.25;
      };
      const particlesFn = (link: Record<string, unknown>) => {
        const l = link as unknown as Graph3DLink;
        if (!hi.size) return 1;
        return isHot(l) ? 4 : 0;
      };

      try {
        graph = ForceGraph3D(el, { controlType: 'orbit', rendererConfig: { antialias: true, alpha: false } })
          .backgroundColor('#0a0e17')
          .showNavInfo(false)
          .width(w)
          .height(h)
          .graphData({ nodes: graph3dNodes, links: graph3dLinks })
          .nodeVal(nodeValFn)
          .nodeResolution(18)
          .nodeOpacity(0.95)
          .nodeColor(nodeColorFn)
          .nodeLabel((node: Record<string, unknown>) => {
            const n = node as Graph3DNode & { relPath?: string };
            const sub = n.relPath ? `<div style="color:#94a3b8;font-size:10px;margin-top:2px">${n.relPath}</div>` : '';
            return `<div style="background:#141a26;padding:7px 11px;border-radius:9px;color:#e2e8f0;font:12px/1.35 system-ui,sans-serif;max-width:280px;border:1px solid #2a3346;box-shadow:0 4px 16px rgba(0,0,0,.4)"><b>${n.label}</b>${sub}</div>`;
          })
          .linkColor(linkColorFn)
          .linkDirectionalParticleWidth(1.4)
          .linkDirectionalParticleSpeed(0.006)
          .linkDirectionalParticleColor(() => 'rgba(150,190,255,0.7)')
          .d3AlphaDecay(0.024)
          .d3VelocityDecay(0.32)
          .warmupTicks(220)
          .cooldownTime(3500)
          .onNodeHover((node: Record<string, unknown> | null) => {
            const n = node as Graph3DNode | null;
            hi.clear();
            hoverId = n ? n.id : null;
            if (n) {
              hi.add(n.id);
              for (const e of edgesRef.current) {
                if (e.from === n.id) hi.add(e.to);
                if (e.to === n.id) hi.add(e.from);
              }
            }
            el.style.cursor = n ? 'pointer' : 'grab';
            const g = graphRef.current;
            if (g) {
              try {
                g.nodeColor(nodeColorFn).linkColor(linkColorFn);
                // The installed 3d-force-graph typings don't cover function
                // accessors for linkWidth / linkDirectionalParticles or the
                // arrow setters, though they all work at runtime.
                const l = g as unknown as Record<string, (a: unknown) => unknown>;
                l.linkWidth(linkWidthFn);
                l.linkDirectionalParticles(particlesFn);
                l.linkDirectionalArrowLength(2.6);
                l.linkDirectionalArrowRelPos(1);
                l.linkDirectionalArrowColor(() => 'rgba(140,170,240,0.5)');
              } catch (err) {
                console.error('[GraphCanvas3D] applyLoose on hover failed:', err);
              }
            }
          })
          .onNodeClick((node: Record<string, unknown>) => {
            const n = node as Graph3DNode;
            const original = nodesRef.current.find((nd) => nd.id === n.id);
            if (original) onSelectRef.current?.(original);
          })
          .onBackgroundClick(() => onSelectRef.current?.(null));

        // Apply extended accessors after chain.
        if (graph) {
          try {
            const l = graph as unknown as Record<string, (a: unknown) => unknown>;
            l.linkWidth(linkWidthFn);
            l.linkDirectionalParticles(particlesFn);
            l.linkDirectionalArrowLength(2.6);
            l.linkDirectionalArrowRelPos(1);
            l.linkDirectionalArrowColor(() => 'rgba(140,170,240,0.5)');
          } catch (err) {
            console.error('[GraphCanvas3D] applyLoose on init failed:', err);
          }
          graph.cameraPosition({ x: 0, y: 0, z: Math.max(w, h) * 0.62 }, { x: 0, y: 0, z: 0 });
          graphRef.current = graph;
        }
      } catch (err) {
        console.error('[GraphCanvas3D] ForceGraph3D init failed:', err);
        graph = null;
        setInitError(true);
      }
    };

    const raf = requestAnimationFrame(() => {
      if (destroyed) return;
      if (el.clientWidth >= 10 && el.clientHeight >= 10) doInit();
      else {
        ro = new ResizeObserver(() => {
          if (!destroyed && el.clientWidth >= 10 && el.clientHeight >= 10) { ro?.disconnect(); ro = null; doInit(); }
        });
        ro.observe(el);
      }
    });

    return () => {
      destroyed = true;
      cancelAnimationFrame(raf);
      ro?.disconnect();
      liveContainers.delete(el);
      if (graph) {
        try { graph.graphData({ nodes: [], links: [] }); } catch { /* swallow */ }
        try { const r = (graph as unknown as { renderer?: () => { dispose: () => void } }).renderer?.(); r?.dispose(); } catch { /* swallow */ }
      }
      graphRef.current = null;
      el.innerHTML = '';
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    try { graph.graphData({ nodes: graph3dNodes, links: graph3dLinks }); } catch { /* ignore */ }
  }, [graph3dNodes, graph3dLinks]);

  useEffect(() => {
    const graph = graphRef.current;
    if (!graph || !selectedId) return;
    graph.cameraPosition({ x: 0, y: 0, z: 200 }, { x: 0, y: 0, z: 0 }, 800);
  }, [selectedId]);

  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry || !graphRef.current) return;
      const { width } = entry.contentRect;
      if (width > 10) graphRef.current.width(width).height(height);
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [height]);

  // If WebGL is unavailable or init failed, hand off to the 2D SVG graph
  // immediately — the parent component (GraphCanvas3D) handles the fallback.
  if (initError) throw new Error('3D_FALLBACK');

  const search = () => {
    const q = query.trim().toLowerCase();
    if (!q) return;
    const hit = nodes.find((nd) => nd.label.toLowerCase().includes(q)) ?? nodes.find((nd) => (nd.relPath ?? '').toLowerCase().includes(q));
    if (hit) { onSelect?.(hit); graphRef.current?.cameraPosition({ x: 0, y: 0, z: 220 }, { x: 0, y: 0, z: 0 }, 600); }
  };

  const activeGroups = useMemo(() => [...new Set(nodes.map((n) => n.group))], [nodes]);

  return (
    <div className="relative overflow-hidden rounded-2xl border border-line bg-[#0a0e17]" style={{ height: height + 48 }}>
      <div className="absolute left-3 top-3 z-10 w-56">
        <Input icon="search" placeholder="Search & center a node…" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && search()} />
      </div>
      <div className="absolute right-3 top-3 z-10 flex flex-col gap-1">
        <ZoomBtn icon="plus" onClick={() => { const g = graphRef.current; if (!g) return; const p = g.camera().position.clone(); const d = p.clone().normalize(); g.cameraPosition({ x: p.x - d.x * 40, y: p.y - d.y * 40, z: p.z - d.z * 40 }, { x: 0, y: 0, z: 0 }, 300); }} />
        <ZoomBtn icon="dot" onClick={() => graphRef.current?.cameraPosition({ x: 0, y: 0, z: 300 }, { x: 0, y: 0, z: 0 }, 600)} />
      </div>
      <div ref={containerRef} style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: `${height}px` }} />
      <div className="pointer-events-none absolute bottom-3 left-3 z-10 text-[10.5px] text-text-subtle">
        {nodes.length} nodes · {edges.length} edges · drag to orbit · scroll to zoom · hover to trace
      </div>
      <div className="absolute bottom-3 right-3 z-10"><GraphLegend groupColors={groupColors} active={activeGroups} /></div>
    </div>
  );
}

/** Error boundary — if 3D fails, fall back to the 2D SVG graph. */
class Graph3DErrorBoundary extends Component<{ children: ReactNode; fallback2D: ReactNode }, { error: boolean }> {
  state = { error: false };
  static getDerivedStateFromError() { return { error: true }; }
  componentDidCatch(err: unknown) {
    if (err instanceof Error && err.message === '3D_FALLBACK') {
      console.info('[GraphCanvas3D] Falling back to 2D SVG graph (WebGL unavailable or init failed)');
    } else {
      console.error('[GraphCanvas3D] Error boundary caught:', err);
    }
  }
  render() { return this.state.error ? this.props.fallback2D : this.props.children; }
}

export function GraphCanvas3D(props: {
  nodes: GraphCanvasNode[];
  edges: GraphCanvasEdge[];
  groupColors: Record<string, string>;
  height?: number;
  onSelect?: (node: GraphCanvasNode | null) => void;
  selectedId?: string | null;
}) {
  const fallback2D = <GraphCanvas {...props} />;
  return (
    <Graph3DErrorBoundary fallback2D={fallback2D}>
      <InnerGraphCanvas3D {...props} height={props.height ?? 560} />
    </Graph3DErrorBoundary>
  );
}

function ZoomBtn({ icon, onClick }: { icon: 'plus' | 'dot'; onClick: () => void }) {
  return (
    <button onClick={onClick} className="grid h-7 w-7 place-items-center rounded-lg border border-line bg-surface text-text-muted shadow-sm transition-colors hover:bg-surface-hover hover:text-text" title={icon === 'plus' ? 'Zoom in' : 'Reset view'}>
      <Icon name={icon} size={14} />
    </button>
  );
}
