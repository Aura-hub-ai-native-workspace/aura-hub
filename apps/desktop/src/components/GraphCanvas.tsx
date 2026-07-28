import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon, Input } from '@aura/ui';
import { cn } from '@aura/core';

/**
 * GraphCanvas — a live, interactive, dependency-free graph.
 * ==================================================================
 * Renders real nodes/edges as pannable, zoomable SVG. Layout is a small
 * deterministic force simulation computed once per graph (stable across
 * re-renders), so it never jitters. Nodes are selectable; searching
 * centers the view on a match. Used for both the Architecture view and
 * the Knowledge Graph — fed only with real project data.
 */

export interface GraphCanvasNode {
  id: string;
  label: string;
  group: string;
  type?: string;
  relPath?: string;
  line?: number;
  detail?: string;
}
export interface GraphCanvasEdge { from: string; to: string; kind: string }

interface Pos { x: number; y: number }

/** Deterministic force-directed layout (seeded on a circle, then relaxed). */
function layout(nodes: GraphCanvasNode[], edges: GraphCanvasEdge[]): Map<string, Pos> {
  const n = nodes.length;
  const pos = new Map<string, Pos>();
  const idx = new Map<string, number>();
  const R = 40 * Math.sqrt(Math.max(1, n));
  nodes.forEach((node, i) => {
    idx.set(node.id, i);
    const a = (i / Math.max(1, n)) * Math.PI * 2;
    // seed with a hash offset so identical rings don't overlap perfectly
    let h = 0; for (let k = 0; k < node.id.length; k++) h = (h * 31 + node.id.charCodeAt(k)) >>> 0;
    pos.set(node.id, { x: Math.cos(a) * R + (h % 17) - 8, y: Math.sin(a) * R + ((h >> 4) % 17) - 8 });
  });
  const links = edges.filter((e) => pos.has(e.from) && pos.has(e.to));
  const iterations = n > 160 ? 90 : 140;
  const k = 34; // ideal spacing
  for (let it = 0; it < iterations; it++) {
    const disp = nodes.map(() => ({ x: 0, y: 0 }));
    // repulsion (O(n^2), fine for our capped node counts)
    for (let i = 0; i < n; i++) {
      const pi = pos.get(nodes[i].id)!;
      for (let j = i + 1; j < n; j++) {
        const pj = pos.get(nodes[j].id)!;
        let dx = pi.x - pj.x, dy = pi.y - pj.y;
        let d2 = dx * dx + dy * dy || 0.01;
        const f = (k * k) / d2;
        const d = Math.sqrt(d2);
        const ux = dx / d, uy = dy / d;
        disp[i].x += ux * f; disp[i].y += uy * f;
        disp[j].x -= ux * f; disp[j].y -= uy * f;
      }
    }
    // attraction along edges
    for (const e of links) {
      const a = idx.get(e.from)!, b = idx.get(e.to)!;
      const pa = pos.get(e.from)!, pb = pos.get(e.to)!;
      let dx = pa.x - pb.x, dy = pa.y - pb.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const f = (d * d) / k;
      const ux = dx / d, uy = dy / d;
      disp[a].x -= ux * f; disp[a].y -= uy * f;
      disp[b].x += ux * f; disp[b].y += uy * f;
    }
    const cool = 1 - it / iterations;
    const maxStep = 12 * cool + 1;
    for (let i = 0; i < n; i++) {
      const p = pos.get(nodes[i].id)!;
      const dl = Math.sqrt(disp[i].x * disp[i].x + disp[i].y * disp[i].y) || 0.01;
      p.x += (disp[i].x / dl) * Math.min(dl, maxStep);
      p.y += (disp[i].y / dl) * Math.min(dl, maxStep);
    }
  }
  return pos;
}

function bounds(pos: Map<string, Pos>) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pos.values()) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  if (!isFinite(minX)) return { x: -100, y: -100, w: 200, h: 200 };
  const pad = 60;
  return { x: minX - pad, y: minY - pad, w: (maxX - minX) + pad * 2, h: (maxY - minY) + pad * 2 };
}

export function GraphCanvas({ nodes, edges, groupColors, height = 520, onSelect, selectedId }: {
  nodes: GraphCanvasNode[];
  edges: GraphCanvasEdge[];
  groupColors: Record<string, string>;
  height?: number;
  onSelect?: (node: GraphCanvasNode | null) => void;
  selectedId?: string | null;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const pos = useMemo(() => layout(nodes, edges), [nodes, edges]);
  const base = useMemo(() => bounds(pos), [pos]);
  const [vb, setVb] = useState(base);
  const [hover, setHover] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const drag = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => { setVb(base); }, [base]);

  // Non-passive wheel zoom centered on the viewBox.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setVb((cur) => {
        const factor = e.deltaY > 0 ? 1.12 : 0.89;
        const nw = Math.max(60, Math.min(cur.w * factor, base.w * 4));
        const nh = nw * (cur.h / cur.w);
        return { x: cur.x + (cur.w - nw) / 2, y: cur.y + (cur.h - nh) / 2, w: nw, h: nh };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [base.w]);

  const neighbors = useMemo(() => {
    const set = new Set<string>();
    if (!selectedId && !hover) return set;
    const focus = selectedId ?? hover!;
    for (const e of edges) { if (e.from === focus) set.add(e.to); if (e.to === focus) set.add(e.from); }
    return set;
  }, [edges, selectedId, hover]);

  const centerOn = (id: string) => {
    const p = pos.get(id);
    if (!p) return;
    const w = Math.min(vb.w, base.w * 0.5), h = w * (vb.h / vb.w);
    setVb({ x: p.x - w / 2, y: p.y - h / 2, w, h });
  };

  const search = () => {
    const q = query.trim().toLowerCase();
    if (!q) return;
    const hit = nodes.find((nd) => nd.label.toLowerCase().includes(q)) ?? nodes.find((nd) => (nd.relPath ?? '').toLowerCase().includes(q));
    if (hit) { onSelect?.(hit); centerOn(hit.id); }
  };

  const onDown = (e: React.PointerEvent) => { drag.current = { x: e.clientX, y: e.clientY }; (e.target as Element).setPointerCapture?.(e.pointerId); };
  const onMove = (e: React.PointerEvent) => {
    if (!drag.current || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const dx = (e.clientX - drag.current.x) * (vb.w / rect.width);
    const dy = (e.clientY - drag.current.y) * (vb.h / rect.height);
    drag.current = { x: e.clientX, y: e.clientY };
    setVb((c) => ({ ...c, x: c.x - dx, y: c.y - dy }));
  };
  const onUp = () => { drag.current = null; };

  const focus = selectedId ?? hover;

  return (
    <div className="relative overflow-hidden rounded-2xl border border-line bg-surface" style={{ height }}>
      {/* Controls */}
      <div className="absolute left-3 top-3 z-10 flex items-center gap-2">
        <div className="w-56"><Input icon="search" placeholder="Search & center a node…" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && search()} /></div>
      </div>
      <div className="absolute right-3 top-3 z-10 flex flex-col gap-1">
        <ZoomBtn icon="plus" onClick={() => setVb((c) => ({ x: c.x + c.w * 0.06, y: c.y + c.h * 0.06, w: c.w * 0.88, h: c.h * 0.88 }))} />
        <ZoomBtn icon="dot" onClick={() => setVb(base)} />
      </div>

      <svg
        ref={svgRef}
        viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
        className="h-full w-full cursor-grab touch-none active:cursor-grabbing"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerLeave={onUp}
        onClick={(e) => { if (e.target === svgRef.current) onSelect?.(null); }}
      >
        {edges.map((e, i) => {
          const a = pos.get(e.from), b = pos.get(e.to);
          if (!a || !b) return null;
          const active = focus === e.from || focus === e.to;
          return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={active ? 'var(--accent, #3b6bff)' : 'currentColor'} strokeOpacity={active ? 0.55 : focus ? 0.06 : 0.14} strokeWidth={active ? 1.4 : 0.8} className="text-text-subtle" />;
        })}
        {nodes.map((nd) => {
          const p = pos.get(nd.id);
          if (!p) return null;
          const isFocus = focus === nd.id;
          const isNeighbor = neighbors.has(nd.id);
          const dim = focus && !isFocus && !isNeighbor;
          const r = isFocus ? 8 : selectedId === nd.id ? 7 : 5.5;
          const color = groupColors[nd.group] ?? '#8892a6';
          return (
            <g key={nd.id} transform={`translate(${p.x},${p.y})`} className="cursor-pointer" opacity={dim ? 0.28 : 1}
              onMouseEnter={() => setHover(nd.id)} onMouseLeave={() => setHover(null)}
              onClick={(e) => { e.stopPropagation(); onSelect?.(nd); }}>
              <circle r={r} fill={color} stroke={isFocus ? 'var(--accent, #3b6bff)' : 'white'} strokeWidth={isFocus ? 2 : 1} />
              {(isFocus || isNeighbor || hover === nd.id) && (
                <text x={r + 3} y={3.5} fontSize={9} className="fill-text" style={{ paintOrder: 'stroke', stroke: 'var(--surface, #fff)', strokeWidth: 3 }}>{nd.label.length > 26 ? nd.label.slice(0, 25) + '…' : nd.label}</text>
              )}
            </g>
          );
        })}
      </svg>

      <div className="pointer-events-none absolute bottom-3 left-3 text-[10.5px] text-text-subtle">{nodes.length} nodes · {edges.length} edges · scroll to zoom · drag to pan</div>
    </div>
  );
}

function ZoomBtn({ icon, onClick }: { icon: 'plus' | 'dot'; onClick: () => void }) {
  return (
    <button onClick={onClick} className="grid h-7 w-7 place-items-center rounded-lg border border-line bg-surface text-text-muted shadow-sm transition-colors hover:bg-surface-hover hover:text-text" title={icon === 'plus' ? 'Zoom in' : 'Reset view'}>
      <Icon name={icon} size={14} />
    </button>
  );
}

/** A small legend for the group colors present in the graph. */
export function GraphLegend({ groupColors, active }: { groupColors: Record<string, string>; active: string[] }) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1.5">
      {active.map((g) => (
        <span key={g} className="inline-flex items-center gap-1.5 text-[11px] capitalize text-text-muted">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: groupColors[g] ?? '#8892a6' }} />{g}
        </span>
      ))}
    </div>
  );
}

/** Shared detail panel for a selected node. */
export function NodeDetail({ node, onClose }: { node: GraphCanvasNode; onClose: () => void }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-text-subtle">{node.type ?? node.group}</div>
          <div className="mt-0.5 truncate text-[15px] font-semibold text-text">{node.label}</div>
        </div>
        <button onClick={onClose} className={cn('grid h-7 w-7 shrink-0 place-items-center rounded-lg text-text-subtle hover:bg-surface-hover hover:text-text')}><Icon name="close" size={14} /></button>
      </div>
      {node.relPath && <div className="mt-2 truncate font-mono text-[11.5px] text-text-muted">{node.relPath}{node.line ? `:${node.line}` : ''}</div>}
      {node.detail && <p className="mt-2 text-[12.5px] leading-relaxed text-text-muted">{node.detail}</p>}
    </div>
  );
}
