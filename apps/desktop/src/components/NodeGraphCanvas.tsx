import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ease } from '@aura/core';
import { Icon, Input } from '@aura/ui';

/**
 * NodeGraphCanvas — a node-editor-style dependency diagram.
 * ==================================================================
 * Real nodes rendered as draggable-feeling cards (title bar + a few
 * key/value rows), connected by colored bezier wires — the same visual
 * language as node-based tools like ComfyUI, applied to AURA's own
 * architecture/knowledge data. No WebGL, no external graph library:
 * plain SVG wires underneath, absolutely-positioned HTML cards on top,
 * both living in one shared pan/zoom transform. This keeps it robust
 * across every WebView engine AURA runs in (unlike a 3D/WebGL canvas,
 * which can silently fail to render in some embedded webviews).
 */

export interface NodeCardRow {
  label: string;
  value: string;
}

export interface NodeCardData {
  id: string;
  title: string;
  group: string;
  rows: NodeCardRow[];
  /** Optional free-text shown as the last row (wrapped, not truncated). */
  note?: string;
  /** Full name shown as a hover tooltip when `title` is shortened for display. */
  fullTitle?: string;
}

export interface NodeCardEdge {
  from: string;
  to: string;
  kind?: string;
}

interface Pos { x: number; y: number }

const CARD_W = 220;
const ROW_H = 20;
const HEADER_H = 34;
const PADDING_Y = 14;

function cardHeight(node: NodeCardData): number {
  const rows = Math.min(node.rows.length, 6);
  const noteH = node.note ? 34 : 0;
  return HEADER_H + PADDING_Y + rows * ROW_H + noteH + 10;
}

/** Deterministic force-directed layout, sized for rectangular cards rather than points. */
function layoutCards(nodes: NodeCardData[], edges: NodeCardEdge[]): Map<string, Pos> {
  const n = nodes.length;
  const pos = new Map<string, Pos>();
  const idx = new Map<string, number>();
  const spread = 84 * Math.sqrt(Math.max(1, n));
  nodes.forEach((node, i) => {
    idx.set(node.id, i);
    const a = (i / Math.max(1, n)) * Math.PI * 2;
    let h = 0;
    for (let k = 0; k < node.id.length; k++) h = (h * 31 + node.id.charCodeAt(k)) >>> 0;
    pos.set(node.id, { x: Math.cos(a) * spread + ((h % 61) - 30), y: Math.sin(a) * spread * 0.7 + (((h >> 4) % 61) - 30) });
  });
  const links = edges.filter((e) => pos.has(e.from) && pos.has(e.to));
  const iterations = n > 80 ? 110 : 160;
  const k = 170; // ideal spacing — resolveOverlaps() below is the hard guarantee against collisions
  for (let it = 0; it < iterations; it++) {
    const disp = nodes.map(() => ({ x: 0, y: 0 }));
    for (let i = 0; i < n; i++) {
      const pi = pos.get(nodes[i].id) as Pos;
      for (let j = i + 1; j < n; j++) {
        const pj = pos.get(nodes[j].id) as Pos;
        const dx = pi.x - pj.x, dy = pi.y - pj.y;
        const d2 = dx * dx + dy * dy || 0.01;
        const f = (k * k) / d2;
        const d = Math.sqrt(d2);
        const ux = dx / d, uy = dy / d;
        disp[i].x += ux * f; disp[i].y += uy * f;
        disp[j].x -= ux * f; disp[j].y -= uy * f;
      }
    }
    for (const e of links) {
      const a = idx.get(e.from) as number, b = idx.get(e.to) as number;
      const pa = pos.get(e.from) as Pos, pb = pos.get(e.to) as Pos;
      const dx = pa.x - pb.x, dy = pa.y - pb.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const f = (d * d) / (k * 2.2);
      const ux = dx / d, uy = dy / d;
      disp[a].x -= ux * f; disp[a].y -= uy * f;
      disp[b].x += ux * f; disp[b].y += uy * f;
    }
    const cool = 1 - it / iterations;
    const maxStep = 22 * cool + 1;
    for (let i = 0; i < n; i++) {
      const p = pos.get(nodes[i].id) as Pos;
      const dl = Math.sqrt(disp[i].x * disp[i].x + disp[i].y * disp[i].y) || 0.01;
      p.x += (disp[i].x / dl) * Math.min(dl, maxStep);
      p.y += (disp[i].y / dl) * Math.min(dl, maxStep);
    }
  }
  resolveOverlaps(nodes, pos);
  return pos;
}

/**
 * The force simulation above treats cards as points, so two nodes can
 * still end up with overlapping rectangles (cards vary in height, and
 * point-repulsion doesn't know that). This is a deterministic guarantee
 * on top of it: while any two card rectangles overlap, push them apart
 * along whichever axis needs less movement. Caps at a fixed number of
 * passes — with real project sizes this always converges in a handful.
 */
function resolveOverlaps(nodes: NodeCardData[], pos: Map<string, Pos>) {
  const heights = new Map(nodes.map((n) => [n.id, cardHeight(n)]));
  const pad = 24;
  for (let pass = 0; pass < 80; pass++) {
    let moved = false;
    for (let i = 0; i < nodes.length; i++) {
      const a = pos.get(nodes[i].id) as Pos;
      const ah = heights.get(nodes[i].id) as number;
      for (let j = i + 1; j < nodes.length; j++) {
        const b = pos.get(nodes[j].id) as Pos;
        const bh = heights.get(nodes[j].id) as number;
        const overlapX = Math.min(a.x + CARD_W, b.x + CARD_W) - Math.max(a.x, b.x);
        const overlapY = Math.min(a.y + ah, b.y + bh) - Math.max(a.y, b.y);
        if (overlapX + pad <= 0 || overlapY + pad <= 0) continue;
        const pushX = overlapX + pad, pushY = overlapY + pad;
        const acx = a.x + CARD_W / 2, bcx = b.x + CARD_W / 2;
        const acy = a.y + ah / 2, bcy = b.y + bh / 2;
        if (pushX < pushY) {
          const sign = acx <= bcx ? -1 : 1;
          a.x += (sign * pushX) / 2;
          b.x -= (sign * pushX) / 2;
        } else {
          const sign = acy <= bcy ? -1 : 1;
          a.y += (sign * pushY) / 2;
          b.y -= (sign * pushY) / 2;
        }
        moved = true;
      }
    }
    if (!moved) break;
  }
}

function bounds(nodes: NodeCardData[], pos: Map<string, Pos>) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const node of nodes) {
    const p = pos.get(node.id);
    if (!p) continue;
    const h = cardHeight(node);
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + CARD_W);
    maxY = Math.max(maxY, p.y + h);
  }
  if (!isFinite(minX)) return { x: -160, y: -120, w: 320, h: 240 };
  const pad = 90;
  return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
}

export function NodeGraphCanvas({
  nodes: allNodes,
  edges: allEdges,
  groupColors,
  height = 560,
  onSelect,
  selectedId,
}: {
  nodes: NodeCardData[];
  edges: NodeCardEdge[];
  groupColors: Record<string, string>;
  height?: number;
  onSelect?: (id: string | null) => void;
  selectedId?: string | null;
}) {
  const [hiddenGroups, setHiddenGroups] = useState<Set<string>>(new Set());
  const [hiddenKinds, setHiddenKinds] = useState<Set<string>>(new Set());
  const toggleGroup = (g: string) => setHiddenGroups((prev) => { const next = new Set(prev); if (next.has(g)) next.delete(g); else next.add(g); return next; });
  const toggleKind = (k: string) => setHiddenKinds((prev) => { const next = new Set(prev); if (next.has(k)) next.delete(k); else next.add(k); return next; });

  const allGroups = useMemo(() => [...new Set(allNodes.map((n) => n.group))].sort(), [allNodes]);
  const allKinds = useMemo(() => [...new Set(allEdges.map((e) => e.kind).filter((k): k is string => Boolean(k)))].sort(), [allEdges]);

  // Layer-visibility (group) and relationship-type (kind) filters — applied
  // before layout, so hidden groups/kinds never affect the force simulation.
  const nodes = useMemo(() => allNodes.filter((n) => !hiddenGroups.has(n.group)), [allNodes, hiddenGroups]);
  const edges = useMemo(() => {
    const visible = new Set(nodes.map((n) => n.id));
    return allEdges.filter((e) => visible.has(e.from) && visible.has(e.to) && (!e.kind || !hiddenKinds.has(e.kind)));
  }, [allEdges, nodes, hiddenKinds]);

  const pos = useMemo(() => layoutCards(nodes, edges), [nodes, edges]);
  const base = useMemo(() => bounds(nodes, pos), [nodes, pos]);
  const [view, setViewState] = useState(base);
  const [hover, setHover] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ w: 800, h: height });
  const drag = useRef<{ x: number; y: number } | null>(null);

  // A real layout change (expand/collapse, filter toggle — anything that
  // changes which nodes/edges exist) briefly enables a position transition
  // so cards visibly glide to their new spot. Pan/zoom never touches this:
  // those only change `view`/`viewport`, not `nodes`/`edges`, so dragging
  // or scrolling stays perfectly 1:1 with the pointer — animating position
  // during an active drag would make panning feel laggy and rubber-banded.
  const [justRelaidOut, setJustRelaidOut] = useState(false);
  const firstLayout = useRef(true);
  useEffect(() => {
    if (firstLayout.current) { firstLayout.current = false; return; }
    setJustRelaidOut(true);
    const t = setTimeout(() => setJustRelaidOut(false), 260);
    return () => clearTimeout(t);
  }, [nodes, edges]);

  useEffect(() => setViewState(base), [base]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) setViewport({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // scale = CSS pixels per graph-unit; view.w is the graph-space width currently visible.
  const scale = viewport.w > 0 ? viewport.w / view.w : 1;
  const toScreen = (p: Pos) => ({ x: (p.x - view.x) * scale, y: (p.y - view.y) * scale });

  const onWheel = (e: ReactWheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 1.12 : 0.89;
    setViewState((cur) => {
      const nw = Math.max(240, Math.min(cur.w * factor, base.w * 5));
      const nh = nw * (viewport.h / Math.max(1, viewport.w));
      return { x: cur.x + (cur.w - nw) / 2, y: cur.y + (cur.h - nh) / 2, w: nw, h: nh };
    });
  };
  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    // Only start a pan when the press begins on the canvas background
    // itself. Capturing the pointer unconditionally (including presses
    // that start on a card) retargets the eventual 'click' to this root
    // element — which then reads as a background click and deselects,
    // so a card's own onClick never gets a chance to fire.
    if (e.target !== e.currentTarget) return;
    drag.current = { x: e.clientX, y: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const dx = (e.clientX - drag.current.x) / scale;
    const dy = (e.clientY - drag.current.y) / scale;
    drag.current = { x: e.clientX, y: e.clientY };
    setViewState((c) => ({ ...c, x: c.x - dx, y: c.y - dy }));
  };
  const onUp = () => { drag.current = null; };

  const centerOn = (id: string) => {
    const p = pos.get(id);
    if (!p) return;
    setViewState((cur) => ({ x: p.x + CARD_W / 2 - cur.w / 2, y: p.y - cur.h / 2 + 60, w: cur.w, h: cur.h }));
  };
  const search = () => {
    const q = query.trim().toLowerCase();
    if (!q) return;
    const hit = nodes.find((nd) => nd.title.toLowerCase().includes(q));
    if (hit) { onSelect?.(hit.id); centerOn(hit.id); }
  };

  const neighbors = useMemo(() => {
    const set = new Set<string>();
    const focus = selectedId ?? hover;
    if (!focus) return set;
    for (const e of edges) { if (e.from === focus) set.add(e.to); if (e.to === focus) set.add(e.from); }
    return set;
  }, [edges, selectedId, hover]);

  const focus = selectedId ?? hover;

  return (
    <div
      ref={containerRef}
      className="relative touch-none select-none overflow-hidden rounded-2xl border border-line"
      style={{ height, background: '#0a0c11' }}
      onWheel={onWheel}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerLeave={onUp}
      onClick={(e) => { if (e.target === e.currentTarget) onSelect?.(null); }}
    >
      {/* faint dot grid, purely decorative */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-40"
        style={{
          backgroundImage: 'radial-gradient(circle, rgba(255,255,255,0.06) 1px, transparent 1px)',
          backgroundSize: `${24 * scale}px ${24 * scale}px`,
          backgroundPosition: `${-view.x * scale}px ${-view.y * scale}px`,
        }}
      />

      {/* controls */}
      <div className="absolute left-3 top-3 z-10 w-56">
        <Input icon="search" placeholder="Search & center a node…" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && search()} />
      </div>
      <div className="absolute right-3 top-3 z-10 flex flex-col gap-1">
        <ZoomBtn icon="plus" onClick={() => setViewState((c) => ({ x: c.x + c.w * 0.06, y: c.y + c.h * 0.06, w: c.w * 0.88, h: c.h * 0.88 }))} />
        <ZoomBtn icon="dot" onClick={() => setViewState(base)} />
      </div>

      {/* wires */}
      <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
        {edges.map((e, i) => {
          const a = pos.get(e.from), b = pos.get(e.to);
          const an = nodes.find((n) => n.id === e.from);
          if (!a || !b || !an) return null;
          const sa = toScreen({ x: a.x + CARD_W, y: a.y + HEADER_H + PADDING_Y / 2 });
          const sb = toScreen({ x: b.x, y: b.y + HEADER_H + PADDING_Y / 2 });
          const active = focus === e.from || focus === e.to;
          const dx = Math.max(40, Math.abs(sb.x - sa.x) * 0.55);
          const d = `M ${sa.x} ${sa.y} C ${sa.x + dx} ${sa.y}, ${sb.x - dx} ${sb.y}, ${sb.x} ${sb.y}`;
          const color = groupColors[an.group] ?? '#8892a6';
          return (
            <path
              key={i}
              d={d}
              fill="none"
              stroke={color}
              strokeWidth={active ? 2.4 : 1.6}
              style={{ transition: 'opacity 0.2s ease' }}
              opacity={active ? 0.95 : focus ? 0.08 : 0.45}
            />
          );
        })}
      </svg>

      {/* node cards */}
      <AnimatePresence>
      {nodes.map((node) => {
        const p = pos.get(node.id);
        if (!p) return null;
        const s = toScreen(p);
        const h = cardHeight(node);
        // Culling uses screen-space size (CARD_W/h * scale); the box itself
        // stays at its natural (unscaled) size and gets a single CSS
        // `transform: scale()` below — that's what keeps every internal
        // measurement (fonts, padding, row height) in exact proportion to
        // the box's on-screen footprint. Manually re-deriving each of those
        // per `scale` (an earlier version of this component did) is how a
        // subtle mismatch crept in: fixed-px Tailwind padding doesn't scale
        // the way a hand-rolled `fontSize: N * scale` does, so the box's
        // *real* rendered height silently drifted from what the layout and
        // overlap-resolution math above assumed — nodes would overlap on
        // screen even though the solver reported a clean, gap-padded layout.
        //
        // Off-screen nodes are hidden via `display: none`, not omitted from
        // the tree — omitting them (returning null) would remove their key
        // from AnimatePresence's view every time they pan out of frame,
        // which reads to Framer as a genuine removal and replays the exit/
        // enter fade on every ordinary pan. `display: none` keeps the exit
        // animation reserved for real removals (expand/collapse, filtering)
        // while still fully skipping layout/paint cost for hidden cards.
        const offscreen = s.x + CARD_W * scale < -40 || s.x > viewport.w + 40 || s.y + h * scale < -40 || s.y > viewport.h + 40;
        const isFocus = focus === node.id;
        const isNeighbor = neighbors.has(node.id);
        const dim = focus && !isFocus && !isNeighbor;
        const color = groupColors[node.group] ?? '#8892a6';
        return (
          <motion.div
            key={node.id}
            initial={{ opacity: 0 }}
            animate={{ opacity: dim ? 0.32 : 1 }}
            exit={{ opacity: 0 }}
            transition={ease.out}
            className="absolute cursor-pointer overflow-hidden rounded-lg border text-[11px] shadow-lg"
            style={{
              display: offscreen ? 'none' : undefined,
              left: s.x,
              top: s.y,
              width: CARD_W,
              height: h,
              transform: `scale(${scale})`,
              transformOrigin: 'top left',
              transition: justRelaidOut ? 'left 0.22s ease-out, top 0.22s ease-out' : 'none',
              background: '#1c1f26',
              borderColor: isFocus ? color : 'rgba(255,255,255,0.08)',
              borderWidth: isFocus ? 1.5 : 1,
            }}
            title={node.fullTitle ?? node.title}
            onMouseEnter={() => setHover(node.id)}
            onMouseLeave={() => setHover(null)}
            onClick={(e) => { e.stopPropagation(); onSelect?.(node.id); }}
          >
            {/* corner tag */}
            <span className="absolute right-0 top-0 h-2.5 w-2.5 rounded-bl" style={{ background: color }} />
            {/* title bar */}
            <div className="flex items-center gap-1.5 border-b border-white/10 px-2.5 py-1.5" style={{ background: '#22262f', height: HEADER_H }}>
              <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color }} />
              <span className="truncate font-medium text-white/90">{node.title}</span>
            </div>
            {/* connector dots */}
            <span className="absolute left-0 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/20" style={{ background: color, top: HEADER_H + PADDING_Y / 2 }} />
            <span className="absolute right-0 h-2 w-2 translate-x-1/2 -translate-y-1/2 rounded-full border border-white/20" style={{ background: color, top: HEADER_H + PADDING_Y / 2 }} />
            {/* body rows */}
            <div className="px-2.5 py-1.5">
              {node.rows.slice(0, 6).map((row, i) => (
                <div key={i} className="flex items-center justify-between gap-2" style={{ height: ROW_H }}>
                  <span className="truncate text-white/45">{row.label}</span>
                  <span className="truncate font-mono text-white/80">{row.value}</span>
                </div>
              ))}
              {node.note && <p className="mt-1 line-clamp-2 text-[0.92em] text-white/40">{node.note}</p>}
            </div>
          </motion.div>
        );
      })}
      </AnimatePresence>

      <div className="pointer-events-none absolute bottom-3 left-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-white/40">
        <span>{nodes.length} nodes · {edges.length} connections · scroll to zoom · drag to pan</span>
      </div>
      <div className="pointer-events-none absolute bottom-3 right-3 max-w-[55%]">
        {allKinds.length > 1 && (
          <div className="pointer-events-auto mb-1 flex flex-wrap justify-end gap-x-3 gap-y-1">
            {allKinds.slice(0, 8).map((k) => {
              const isHidden = hiddenKinds.has(k);
              return (
                <button
                  key={k}
                  onClick={() => toggleKind(k)}
                  className={`text-[10.5px] capitalize transition-colors ${isHidden ? 'text-white/25 line-through' : 'text-white/50 hover:text-white/80'}`}
                  title={isHidden ? `Show "${k}" relationships` : `Hide "${k}" relationships`}
                >
                  {k}
                </button>
              );
            })}
          </div>
        )}
        {allGroups.length > 1 && (
          <div className="pointer-events-auto flex flex-wrap justify-end gap-x-3 gap-y-1">
            {allGroups.slice(0, 10).map((g) => {
              const isHidden = hiddenGroups.has(g);
              return (
                <button
                  key={g}
                  onClick={() => toggleGroup(g)}
                  className={`inline-flex items-center gap-1.5 text-[10.5px] capitalize transition-colors ${isHidden ? 'text-white/25 line-through' : 'text-white/50 hover:text-white/80'}`}
                  title={isHidden ? `Show ${g}` : `Hide ${g}`}
                >
                  <span className="h-2 w-2 rounded-full" style={{ background: groupColors[g] ?? '#8892a6', opacity: isHidden ? 0.35 : 1 }} />
                  {g}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function ZoomBtn({ icon, onClick }: { icon: 'plus' | 'dot'; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="grid h-7 w-7 place-items-center rounded-lg border border-white/10 bg-black/40 text-white/60 shadow-sm backdrop-blur transition-colors hover:bg-black/60 hover:text-white"
      title={icon === 'plus' ? 'Zoom in' : 'Reset view'}
    >
      <Icon name={icon} size={14} />
    </button>
  );
}
