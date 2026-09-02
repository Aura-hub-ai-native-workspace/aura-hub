import { useEffect, useMemo, useReducer, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ease } from '@aura/core';
import { Icon, Input } from '@aura/ui';

/**
 * NodeGraphCanvas — the Knowledge Graph's engine.
 * ==================================================================
 * A real, continuous force-directed simulation (Fruchterman-Reingold-style
 * repulsion/attraction, d3-force-style velocity + decaying alpha), not a
 * one-shot layout — nodes keep settling live, a dragged node pins under
 * the pointer and its neighbors resettle around it. Rendered as SVG wires
 * + absolutely-positioned HTML cards sharing one pan/zoom transform. No
 * WebGL, no external graph/physics library: this keeps it robust across
 * every WebView engine AURA runs in, and (now that Architecture has its
 * own blueprint engine) this component exists for exactly one purpose —
 * being the Knowledge Graph, not a generic "boxes and lines" primitive.
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
type Vec = Pos;

const CARD_W = 220;
const ROW_H = 20;
const HEADER_H = 34;
const PADDING_Y = 14;

// Continuous simulation tuning — d3-force-style decaying alpha, velocity
// damping, and a defensive max-speed clamp (can't visually tune these by
// eye in this environment, so these are conservative, standard-practice
// values rather than anything picked to look right on screen).
const SPRING_K = 170;
const FORCE_SCALE = 0.02;
const VELOCITY_DECAY = 0.72;
const ALPHA_DECAY = 0.02;
const ALPHA_MIN = 0.001;
const MAX_SPEED = 40;
const REHEAT_ON_CHANGE = 0.45;
const REHEAT_ON_DRAG = 0.5;

function cardHeight(node: NodeCardData): number {
  const rows = Math.min(node.rows.length, 6);
  const noteH = node.note ? 34 : 0;
  return HEADER_H + PADDING_Y + rows * ROW_H + noteH + 10;
}

/** Deterministic seed for a brand-new node — a hint (e.g. a cluster's last known position, so an expanding cluster's members visibly bloom outward from it) takes priority over the hash+circle fallback. */
function seedNodePosition(id: string, index: number, total: number, hint?: Pos): Pos {
  if (hint) return { x: hint.x, y: hint.y };
  const spread = 84 * Math.sqrt(Math.max(1, total));
  const a = (index / Math.max(1, total)) * Math.PI * 2;
  let h = 0;
  for (let k = 0; k < id.length; k++) h = (h * 31 + id.charCodeAt(k)) >>> 0;
  return { x: Math.cos(a) * spread + ((h % 61) - 30), y: Math.sin(a) * spread * 0.7 + (((h >> 4) % 61) - 30) };
}

/** One tick's worth of repulsion + spring attraction, added to `vel` (not applied to `pos` directly — see integrate()). Scaled by `alpha` so movement naturally tapers as the simulation settles. */
function applyForces(ids: string[], pos: Map<string, Pos>, vel: Map<string, Vec>, links: { from: string; to: string }[], alpha: number) {
  const n = ids.length;
  for (let i = 0; i < n; i++) {
    const pi = pos.get(ids[i]);
    if (!pi) continue;
    for (let j = i + 1; j < n; j++) {
      const pj = pos.get(ids[j]);
      if (!pj) continue;
      const dx = pi.x - pj.x, dy = pi.y - pj.y;
      const d2 = dx * dx + dy * dy || 0.01;
      const d = Math.sqrt(d2);
      const f = ((SPRING_K * SPRING_K) / d2) * alpha * FORCE_SCALE;
      const ux = dx / d, uy = dy / d;
      const vi = vel.get(ids[i]), vj = vel.get(ids[j]);
      if (vi) { vi.x += ux * f; vi.y += uy * f; }
      if (vj) { vj.x -= ux * f; vj.y -= uy * f; }
    }
  }
  for (const e of links) {
    const pa = pos.get(e.from), pb = pos.get(e.to);
    if (!pa || !pb) continue;
    const dx = pa.x - pb.x, dy = pa.y - pb.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
    const f = (d * d / (SPRING_K * 2.2)) * alpha * FORCE_SCALE;
    const ux = dx / d, uy = dy / d;
    const va = vel.get(e.from), vb = vel.get(e.to);
    if (va) { va.x -= ux * f; va.y -= uy * f; }
    if (vb) { vb.x += ux * f; vb.y += uy * f; }
  }
}

/** Applies velocity to position with damping. A fixed (dragged) node snaps straight to its pinned position each frame instead — it still repels/attracts everything else via applyForces above, it just doesn't accumulate its own displacement. */
function integrate(ids: string[], pos: Map<string, Pos>, vel: Map<string, Vec>, fixed: Map<string, Pos>) {
  for (const id of ids) {
    const f = fixed.get(id);
    if (f) { pos.set(id, { x: f.x, y: f.y }); vel.set(id, { x: 0, y: 0 }); continue; }
    const v = vel.get(id), p = pos.get(id);
    if (!v || !p) continue;
    v.x *= VELOCITY_DECAY; v.y *= VELOCITY_DECAY;
    const speed = Math.hypot(v.x, v.y);
    if (speed > MAX_SPEED) { const s = MAX_SPEED / speed; v.x *= s; v.y *= s; }
    p.x += v.x; p.y += v.y;
  }
}

/**
 * The force simulation treats cards as points, so two nodes can still end
 * up with overlapping rectangles (cards vary in height, and point-
 * repulsion doesn't know that). This is a deterministic guarantee on top
 * of it: while any two card rectangles overlap, push them apart along
 * whichever axis needs less movement. Called with a small `maxPasses`
 * each animation frame (steady, cheap progress every tick) rather than
 * fully converging in one shot.
 */
function resolveOverlaps(nodes: NodeCardData[], pos: Map<string, Pos>, maxPasses: number) {
  const heights = new Map(nodes.map((n) => [n.id, cardHeight(n)]));
  const pad = 24;
  for (let pass = 0; pass < maxPasses; pass++) {
    let moved = false;
    for (let i = 0; i < nodes.length; i++) {
      const a = pos.get(nodes[i].id);
      if (!a) continue;
      const ah = heights.get(nodes[i].id) as number;
      for (let j = i + 1; j < nodes.length; j++) {
        const b = pos.get(nodes[j].id);
        if (!b) continue;
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
  seedHints,
  onSearchMiss,
  focusRequestId,
}: {
  nodes: NodeCardData[];
  edges: NodeCardEdge[];
  groupColors: Record<string, string>;
  height?: number;
  onSelect?: (id: string | null) => void;
  selectedId?: string | null;
  /**
   * Maps a brand-new node id to another id it should spawn near (that
   * other id's current or just-vacated position). Used by callers like
   * Knowledge.tsx so a newly-expanded cluster's members bloom outward
   * from where the cluster card was, instead of popping in at a fresh
   * hash-seeded spot. Consulted once, the first time an id appears.
   */
  seedHints?: Map<string, string>;
  /**
   * Called when the built-in search box finds no match among currently-
   * rendered nodes — e.g. because it's inside a still-collapsed cluster
   * this component doesn't know about. The caller can expand whatever
   * container holds it and then drive `focusRequestId` once the node
   * actually exists.
   */
  onSearchMiss?: (query: string) => void;
  /** Controlled: once this id appears among the (filtered) nodes, selects and centers on it. */
  focusRequestId?: string | null;
}) {
  const [hiddenGroups, setHiddenGroups] = useState<Set<string>>(new Set());
  const [hiddenKinds, setHiddenKinds] = useState<Set<string>>(new Set());
  const toggleGroup = (g: string) => setHiddenGroups((prev) => { const next = new Set(prev); if (next.has(g)) next.delete(g); else next.add(g); return next; });
  const toggleKind = (k: string) => setHiddenKinds((prev) => { const next = new Set(prev); if (next.has(k)) next.delete(k); else next.add(k); return next; });

  const allGroups = useMemo(() => [...new Set(allNodes.map((n) => n.group))].sort(), [allNodes]);
  const allKinds = useMemo(() => [...new Set(allEdges.map((e) => e.kind).filter((k): k is string => Boolean(k)))].sort(), [allEdges]);

  // Layer-visibility (group) and relationship-type (kind) filters — applied
  // before layout, so hidden groups/kinds never affect the simulation.
  const nodes = useMemo(() => allNodes.filter((n) => !hiddenGroups.has(n.group)), [allNodes, hiddenGroups]);
  const edges = useMemo(() => {
    const visible = new Set(nodes.map((n) => n.id));
    return allEdges.filter((e) => visible.has(e.from) && visible.has(e.to) && (!e.kind || !hiddenKinds.has(e.kind)));
  }, [allEdges, nodes, hiddenKinds]);

  // ---- persistent simulation state — survives across renders and data
  // changes (a ref, not React state, because it's mutated every frame). ----
  const posRef = useRef<Map<string, Pos>>(new Map());
  const velRef = useRef<Map<string, Vec>>(new Map());
  const fixedRef = useRef<Map<string, Pos>>(new Map()); // pinned = currently being dragged
  const alphaRef = useRef(1);
  const nodeIdsRef = useRef<string[]>([]);
  const linksRef = useRef<{ from: string; to: string }[]>([]);
  const cardListRef = useRef<NodeCardData[]>([]);
  const baseRef = useRef(bounds([], new Map()));
  const [, forceRender] = useReducer((x: number) => x + 1, 0);

  const pos = posRef.current;
  const [view, setViewState] = useState(baseRef.current);
  const [hover, setHover] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ w: 800, h: height });
  const drag = useRef<{ x: number; y: number } | null>(null);

  // Reconcile the simulation's node set with the current filtered `nodes`
  // list whenever it actually changes (expand/collapse, filter toggle):
  // seed brand-new ids (via seedHints when available), drop ids that
  // disappeared, reheat alpha so the graph resettles around the change
  // instead of snapping, and refit the view to the new bounds.
  useEffect(() => {
    const pos = posRef.current, vel = velRef.current;
    const liveIds = new Set(nodes.map((n) => n.id));
    const removedPositions = new Map<string, Pos>();
    let changed = false;
    for (const id of [...pos.keys()]) {
      if (!liveIds.has(id)) {
        const p = pos.get(id);
        if (p) removedPositions.set(id, p);
        pos.delete(id);
        vel.delete(id);
        changed = true;
      }
    }
    nodes.forEach((node, i) => {
      if (!pos.has(node.id)) {
        const parentId = seedHints?.get(node.id);
        const hint = parentId ? removedPositions.get(parentId) ?? pos.get(parentId) : undefined;
        pos.set(node.id, seedNodePosition(node.id, i, nodes.length, hint));
        vel.set(node.id, { x: 0, y: 0 });
        changed = true;
      }
    });
    nodeIdsRef.current = nodes.map((n) => n.id);
    linksRef.current = edges.map((e) => ({ from: e.from, to: e.to }));
    cardListRef.current = nodes;
    if (changed) alphaRef.current = Math.max(alphaRef.current, REHEAT_ON_CHANGE);
    const fitted = bounds(nodes, pos);
    baseRef.current = fitted;
    setViewState(fitted);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, seedHints]);

  // The continuous tick loop — runs for the component's whole lifetime,
  // reading live refs each frame so it never needs to restart. Skips the
  // actual physics work once alpha has settled near zero (cheap to keep
  // polling; reheats — from a data change above, or a drag below — pick
  // back up on the very next frame with no separate "wake up" plumbing).
  useEffect(() => {
    let raf = requestAnimationFrame(function step() {
      if (alphaRef.current > ALPHA_MIN) {
        const ids = nodeIdsRef.current;
        applyForces(ids, posRef.current, velRef.current, linksRef.current, alphaRef.current);
        integrate(ids, posRef.current, velRef.current, fixedRef.current);
        resolveOverlaps(cardListRef.current, posRef.current, 3);
        alphaRef.current += (0 - alphaRef.current) * ALPHA_DECAY;
        forceRender();
      }
      raf = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(raf);
  }, []);

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
      const nw = Math.max(240, Math.min(cur.w * factor, baseRef.current.w * 5));
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
    else onSearchMiss?.(query.trim());
  };

  // Controlled focus request: once the requested id actually exists among
  // the currently-rendered nodes (e.g. after a caller expands the cluster
  // that was hiding it), select and center on it.
  useEffect(() => {
    if (!focusRequestId) return;
    if (!nodes.some((n) => n.id === focusRequestId)) return;
    onSelect?.(focusRequestId);
    centerOn(focusRequestId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequestId, nodes]);

  // Dragging a card pins it at the pointer (fed into the live simulation
  // via `fixedRef`, so everything else keeps resettling around it), and
  // releases it back into free motion on pointer-up. A press that never
  // moves past a small threshold is a click, not a drag — click-to-select
  // still works exactly as before.
  const onCardPointerDown = (node: NodeCardData) => (e: ReactPointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    const startClientX = e.clientX, startClientY = e.clientY;
    const startWorld = pos.get(node.id) ?? { x: 0, y: 0 };
    let dragging = false;

    const onCardMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startClientX, dy = ev.clientY - startClientY;
      if (!dragging && Math.hypot(dx, dy) > 4) {
        dragging = true;
        alphaRef.current = Math.max(alphaRef.current, REHEAT_ON_DRAG);
      }
      if (dragging) fixedRef.current.set(node.id, { x: startWorld.x + dx / scale, y: startWorld.y + dy / scale });
    };
    const onCardUp = () => {
      window.removeEventListener('pointermove', onCardMove);
      window.removeEventListener('pointerup', onCardUp);
      if (dragging) {
        fixedRef.current.delete(node.id);
        alphaRef.current = Math.max(alphaRef.current, REHEAT_ON_CHANGE);
      } else {
        onSelect?.(node.id);
      }
    };
    window.addEventListener('pointermove', onCardMove);
    window.addEventListener('pointerup', onCardUp);
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
        <ZoomBtn icon="dot" onClick={() => setViewState(baseRef.current)} />
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
        // `transform: scale()` below. Off-screen nodes are hidden via
        // `display: none`, not omitted from the tree, so AnimatePresence
        // doesn't replay enter/exit on ordinary panning — only on a real
        // removal (filter/expand-collapse).
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
            className="absolute cursor-grab overflow-hidden rounded-lg border text-[11px] shadow-lg active:cursor-grabbing"
            style={{
              display: offscreen ? 'none' : undefined,
              left: s.x,
              top: s.y,
              width: CARD_W,
              height: h,
              transform: `scale(${scale})`,
              transformOrigin: 'top left',
              // No CSS position transition: the continuous simulation
              // itself supplies smooth per-frame motion, so a left/top
              // transition here would just fight the live position feed.
              background: '#1c1f26',
              borderColor: isFocus ? color : 'rgba(255,255,255,0.08)',
              borderWidth: isFocus ? 1.5 : 1,
            }}
            title={node.fullTitle ?? node.title}
            onMouseEnter={() => setHover(node.id)}
            onMouseLeave={() => setHover(null)}
            onPointerDown={onCardPointerDown(node)}
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
        <span>{nodes.length} nodes · {edges.length} connections · scroll to zoom · drag canvas to pan · drag a card to reposition</span>
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
