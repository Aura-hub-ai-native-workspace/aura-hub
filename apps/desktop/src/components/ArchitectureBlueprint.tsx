import { useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { spring } from '@aura/core';
import { Icon } from '@aura/ui';
import type { ArchitectureLayer, ArchitectureLayerEdge } from '../ai/aiClient';

/**
 * ArchitectureBlueprint — the Architecture engine.
 * ==================================================================
 * A deterministic, flat 2D engineering diagram — deliberately not a
 * graph. Layers stack top-to-bottom in the backend's real dependency
 * order (consumers first, foundations last); real inter-layer edges
 * route as right-angle elbow connectors along an offset spine, not
 * organic bezier wires — visually distinct from NodeGraphCanvas on
 * purpose (see the Separate Knowledge Graph and Architecture plan).
 * No WebGL, no physics: plain SVG connectors over stacked HTML bands,
 * with a simple scale/pan transform for zoom.
 */

interface Rect { top: number; left: number; width: number; height: number }

const BAND_WIDTH = 640;
const SPINE_GAP = 36;
const LANE_STEP = 13;
const MAX_LANES = 7;

export function ArchitectureBlueprint({ layers, edges }: { layers: ArchitectureLayer[]; edges: ArchitectureLayerEdge[] }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const stackRef = useRef<HTMLDivElement>(null);
  const bandRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [rects, setRects] = useState<Map<string, Rect>>(new Map());

  // layers[0] is always the synthetic project-name title card the backend
  // prepends — no module of its own, never appears in `edges`. Rendered
  // as a distinct header banner, not part of the interactive stack.
  const header = layers[0];
  const body = useMemo(() => layers.slice(1), [layers]);

  const toggleCollapse = (title: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(title)) next.delete(title);
      else next.add(title);
      return next;
    });

  // Real edges between two layers that are both actually in the stack.
  const bodyTitles = useMemo(() => new Set(body.map((l) => l.title)), [body]);
  const realEdges = useMemo(
    () => edges.filter((e) => bodyTitles.has(e.from) && bodyTitles.has(e.to)),
    [edges, bodyTitles],
  );

  // Multi-hop dependency trace from the selected layer — downstream (what
  // it depends on, following `from === layer` transitively) and upstream
  // (what depends on it, following `to === layer` transitively). Together
  // these ARE the isolate mode: everything outside the trace dims.
  const { downstream, upstream } = useMemo(() => {
    const down = new Set<string>();
    const up = new Set<string>();
    if (!selected) return { downstream: down, upstream: up };
    const outAdj = new Map<string, string[]>();
    const inAdj = new Map<string, string[]>();
    for (const e of realEdges) {
      (outAdj.get(e.from) ?? outAdj.set(e.from, []).get(e.from)!).push(e.to);
      (inAdj.get(e.to) ?? inAdj.set(e.to, []).get(e.to)!).push(e.from);
    }
    const bfs = (start: string, adj: Map<string, string[]>, out: Set<string>) => {
      const queue = [start];
      const seen = new Set([start]);
      while (queue.length) {
        const cur = queue.shift() as string;
        for (const next of adj.get(cur) ?? []) {
          if (seen.has(next)) continue;
          seen.add(next);
          out.add(next);
          queue.push(next);
        }
      }
    };
    bfs(selected, outAdj, down);
    bfs(selected, inAdj, up);
    return { downstream: down, upstream: up };
  }, [selected, realEdges]);

  const traced = selected ? new Set([selected, ...downstream, ...upstream]) : null;

  // Measure each band's position/size relative to the stack whenever the
  // layer set or collapsed state changes — connectors are drawn from
  // these, not from any layout math of our own (plain document flow does
  // the actual stacking; we just read where it landed).
  useLayoutEffect(() => {
    const measure = () => {
      const next = new Map<string, Rect>();
      for (const [title, el] of bandRefs.current) {
        next.set(title, { top: el.offsetTop, left: el.offsetLeft, width: el.offsetWidth, height: el.offsetHeight });
      }
      setRects(next);
    };
    measure();
    const stack = stackRef.current;
    if (!stack) return;
    const ro = new ResizeObserver(measure);
    ro.observe(stack);
    return () => ro.disconnect();
  }, [body, collapsed]);

  const onWheel = (e: ReactWheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    setZoom((z) => Math.max(0.5, Math.min(2, z * (e.deltaY > 0 ? 0.9 : 1.11))));
  };
  const onBackgroundDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    dragRef.current = { x: e.clientX, y: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onBackgroundMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.x, dy = e.clientY - dragRef.current.y;
    dragRef.current = { x: e.clientX, y: e.clientY };
    setPan((p) => ({ x: p.x + dx, y: p.y + dy }));
  };
  const onBackgroundUp = () => { dragRef.current = null; };

  const contentHeight = Math.max(...[...rects.values()].map((r) => r.top + r.height), 200) + 40;

  return (
    <div
      ref={containerRef}
      className="relative touch-none select-none overflow-hidden rounded-2xl border border-line"
      style={{ height: 620, background: '#0a0e17' }}
      onWheel={onWheel}
      onPointerDown={onBackgroundDown}
      onPointerMove={onBackgroundMove}
      onPointerUp={onBackgroundUp}
      onPointerLeave={onBackgroundUp}
      onClick={(e) => { if (e.target === e.currentTarget) setSelected(null); }}
    >
      {/* blueprint grid — straight lines, not dots, deliberately distinct from the Knowledge Graph's dot grid */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.07]"
        style={{
          backgroundImage:
            'linear-gradient(rgba(120,170,255,0.9) 1px, transparent 1px), linear-gradient(90deg, rgba(120,170,255,0.9) 1px, transparent 1px)',
          backgroundSize: `${32 * zoom}px ${32 * zoom}px`,
          backgroundPosition: `${pan.x}px ${pan.y}px`,
        }}
      />

      <div className="absolute right-3 top-3 z-10 flex flex-col gap-1">
        <ZoomBtn icon="plus" onClick={() => setZoom((z) => Math.min(2, z * 1.15))} title="Zoom in" />
        <ZoomBtn icon="dot" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }} title="Reset view" />
      </div>
      {selected && (
        <button
          onClick={() => setSelected(null)}
          className="absolute left-3 top-3 z-10 flex items-center gap-1.5 rounded-lg border border-accent/40 bg-accent/10 px-2.5 py-1.5 text-[11px] font-medium text-accent-200 transition-colors hover:bg-accent/20"
        >
          <Icon name="close" size={11} />
          Clear isolation
        </button>
      )}

      <div
        className="absolute left-1/2 top-8"
        style={{ transform: `translateX(-50%) translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: 'top center' }}
      >
        {header && (
          <div className="mb-4 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3" style={{ width: BAND_WIDTH }}>
            <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/70">{header.title}</div>
            {header.subtitle && <div className="mt-0.5 font-mono text-[10.5px] text-white/40">{header.subtitle}</div>}
          </div>
        )}

        <div className="relative" ref={stackRef} style={{ width: BAND_WIDTH + SPINE_GAP + MAX_LANES * LANE_STEP + 20, minHeight: contentHeight }}>
          <svg className="pointer-events-none absolute left-0 top-0 overflow-visible" width="100%" height={contentHeight}>
            <defs>
              <marker id="arch-arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
                <path d="M0,0 L6,3 L0,6 Z" fill="rgba(120,170,255,0.85)" />
              </marker>
              <marker id="arch-arrow-dim" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
                <path d="M0,0 L6,3 L0,6 Z" fill="rgba(255,255,255,0.18)" />
              </marker>
            </defs>
            {realEdges.map((e, i) => {
              const a = rects.get(e.from), b = rects.get(e.to);
              if (!a || !b) return null;
              // "On the trace" means both endpoints are part of the
              // selected layer's dependency chain (itself, or anything
              // upstream/downstream of it) — a simple, readable
              // approximation of "this connector matters right now"
              // rather than reconstructing the exact BFS path.
              const active = Boolean(traced && traced.has(e.from) && traced.has(e.to));
              const dim = Boolean(traced) && !active;
              const lane = i % MAX_LANES;
              const spineX = a.left + a.width + SPINE_GAP + lane * LANE_STEP;
              const ay = a.top + a.height / 2;
              const by = b.top + b.height / 2;
              const startX = a.left + a.width;
              const endX = b.left + b.width;
              const d = `M ${startX} ${ay} L ${spineX} ${ay} L ${spineX} ${by} L ${endX} ${by}`;
              return (
                <path
                  key={i}
                  d={d}
                  fill="none"
                  stroke={active ? '#7aaaff' : 'rgba(120,170,255,0.35)'}
                  strokeWidth={active ? 2 : 1.3}
                  opacity={dim ? 0.12 : 1}
                  markerEnd={`url(#${active ? 'arch-arrow' : 'arch-arrow-dim'})`}
                  strokeDasharray={active ? '5 4' : undefined}
                  style={active ? { animation: 'arch-flow 0.9s linear infinite' } : undefined}
                />
              );
            })}
          </svg>

          <div className="space-y-3">
            {body.map((layer) => {
              const isCollapsed = collapsed.has(layer.title);
              const isSelected = selected === layer.title;
              const isDown = downstream.has(layer.title);
              const isUp = upstream.has(layer.title);
              const dim = traced ? !traced.has(layer.title) : false;
              return (
                <div
                  key={layer.title}
                  ref={(el) => { if (el) bandRefs.current.set(layer.title, el); else bandRefs.current.delete(layer.title); }}
                  className="relative overflow-hidden rounded-xl border transition-[opacity,border-color] duration-200"
                  style={{
                    width: BAND_WIDTH,
                    background: '#11151f',
                    borderColor: isSelected ? layer.color : 'rgba(255,255,255,0.09)',
                    borderWidth: isSelected ? 1.5 : 1,
                    opacity: dim ? 0.28 : 1,
                  }}
                >
                  <button
                    onClick={(e) => { e.stopPropagation(); setSelected(isSelected ? null : layer.title); }}
                    className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left"
                  >
                    <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: layer.color }} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-semibold text-white/90">{layer.title}</span>
                      {layer.subtitle && <span className="block truncate font-mono text-[10.5px] text-white/40">{layer.subtitle}</span>}
                    </span>
                    {isDown && <Badge label="depends on" tone="down" />}
                    {isUp && <Badge label="depended on" tone="up" />}
                    <span
                      onClick={(e) => { e.stopPropagation(); toggleCollapse(layer.title); }}
                      className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-white/40 transition-colors hover:bg-white/10 hover:text-white/80"
                      title={isCollapsed ? 'Expand' : 'Collapse'}
                    >
                      <motion.span animate={{ rotate: isCollapsed ? -90 : 0 }} transition={spring.snappy}>
                        <Icon name="chevron-down" size={13} />
                      </motion.span>
                    </span>
                  </button>
                  <AnimatePresence initial={false}>
                    {!isCollapsed && layer.items && layer.items.length > 0 && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={spring.smooth}
                        className="overflow-hidden"
                      >
                        <div className="flex flex-wrap gap-1.5 border-t border-white/10 px-3.5 py-2.5">
                          {layer.items.map((item) => (
                            <span key={item} className="rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 font-mono text-[10.5px] text-white/60">
                              {item}
                            </span>
                          ))}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="pointer-events-none absolute bottom-3 left-3 text-[10.5px] text-white/40">
        {body.length} layers · {realEdges.length} dependencies · scroll to zoom · drag to pan · click a layer to trace it
      </div>

      <style>{`@keyframes arch-flow { to { stroke-dashoffset: -18; } }`}</style>
    </div>
  );
}

function Badge({ label, tone }: { label: string; tone: 'up' | 'down' }) {
  return (
    <span
      className="shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide"
      style={
        tone === 'down'
          ? { background: 'rgba(120,170,255,0.15)', color: '#a9c6ff' }
          : { background: 'rgba(255,180,120,0.15)', color: '#ffc99a' }
      }
    >
      {label}
    </span>
  );
}

function ZoomBtn({ icon, onClick, title }: { icon: 'plus' | 'dot'; onClick: () => void; title: string }) {
  return (
    <button
      onClick={onClick}
      className="grid h-7 w-7 place-items-center rounded-lg border border-white/10 bg-black/40 text-white/60 shadow-sm backdrop-blur transition-colors hover:bg-black/60 hover:text-white"
      title={title}
    >
      <Icon name={icon} size={14} />
    </button>
  );
}
