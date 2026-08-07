/**
 * WorkflowCanvas — the Mission Control v3 execution DAG canvas.
 * ==================================================================
 * Renders the real execution DAG (dependencies/blocks/critical path/
 * parallel batches) as a pannable, zoomable, layered SVG. Layout is
 * deterministic (Sugiyama-lite: rank = batch, then crossing-minimizing
 * sweeps), so the same plan always draws identically.
 *
 * Node colours follow the runtime state machine. Dependency edges are
 * animated with a flowing dash; `block` edges (a high-risk critical
 * dependency) render dashed red. Critical-path nodes carry an accent
 * ring. Clicking a node selects it (focuses neighbours, dims the rest).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Icon } from '@aura/ui';
import type { ExecutionDag, ExecutionTaskStatus, TaskPriority } from '../../ai/missionClient';
import { fmtDur, KIND_ICON, RUNTIME_STATUS_LABEL } from './missionMeta';

interface Pos { x: number; y: number }

const NODE_W = 176;
const NODE_H = 56;
const COL_GAP = 220;
const ROW_GAP = 78;
const PAD_X = 30;
const PAD_Y = 26;

const STATUS_FILL: Record<ExecutionTaskStatus, string> = {
  queued: 'var(--surface-active)',
  waiting: 'var(--surface-active)',
  blocked: 'var(--danger)',
  running: 'var(--accent)',
  paused: 'var(--attention)',
  review: 'var(--accent)',
  completed: 'var(--positive)',
  rejected: 'var(--danger)',
  cancelled: 'var(--surface-active)',
  retrying: 'var(--attention)',
  failed: 'var(--danger)',
  rollback: 'var(--danger)',
};

const PRIORITY_WEIGHT: Record<TaskPriority, number> = { critical: 4, high: 3, medium: 2, low: 1 };

function layoutDag(dag: ExecutionDag): { pos: Map<string, Pos>; bounds: { x: number; y: number; w: number; h: number } } {
  const pos = new Map<string, Pos>();
  const rankOf = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const n of dag.nodes) {
    rankOf.set(n.id, n.batch);
    children.set(n.id, []);
  }
  for (const e of dag.edges) {
    if (e.kind !== 'dependency') continue;
    const list = children.get(e.from) ?? [];
    if (!list.includes(e.to)) list.push(e.to);
    children.set(e.from, list);
  }

  // Initial placement: columns by rank, rows by the DAG's auto-order.
  const rankCols = new Map<number, string[]>();
  for (const id of dag.batches.flat()) {
    const r = rankOf.get(id) ?? 0;
    const arr = rankCols.get(r) ?? [];
    arr.push(id);
    rankCols.set(r, arr);
  }
  for (const [r, ids] of rankCols) {
    ids.sort((a, b) => {
      const na = dag.nodes.find((n) => n.id === a);
      const nb = dag.nodes.find((n) => n.id === b);
      return (PRIORITY_WEIGHT[nb?.priority ?? 'medium'] ?? 2) - (PRIORITY_WEIGHT[na?.priority ?? 'medium'] ?? 2);
    });
    ids.forEach((id, i) => pos.set(id, { x: r, y: i }));
  }

  // Crossing minimization: two top-down + two bottom-up sweeps.
  for (let pass = 0; pass < 2; pass++) {
    const ranks = [...rankCols.keys()].sort((a, b) => a - b);
    for (const r of ranks) {
      if (r === 0) continue;
      for (const id of rankCols.get(r) ?? []) {
        const parents = dag.nodes.filter((n) => n.id === id).flatMap((n) => n.dependencies);
        const avg = parents.map((p) => pos.get(p)?.y ?? 0);
        if (avg.length) pos.set(id, { x: r, y: avg.reduce((a, b) => a + b, 0) / avg.length });
      }
      const ids = rankCols.get(r) ?? [];
      ids.sort((a, b) => (pos.get(a)?.y ?? 0) - (pos.get(b)?.y ?? 0));
      ids.forEach((id, i) => pos.set(id, { x: r, y: i }));
    }
    const rrev = [...rankCols.keys()].sort((a, b) => b - a);
    for (const r of rrev) {
      if (r === rrev[0]) continue;
      for (const id of rankCols.get(r) ?? []) {
        const kids = children.get(id) ?? [];
        const avg = kids.map((k) => pos.get(k)?.y ?? 0);
        if (avg.length) pos.set(id, { x: r, y: avg.reduce((a, b) => a + b, 0) / avg.length });
      }
      const ids = rankCols.get(r) ?? [];
      ids.sort((a, b) => (pos.get(a)?.y ?? 0) - (pos.get(b)?.y ?? 0));
      ids.forEach((id, i) => pos.set(id, { x: r, y: i }));
    }
  }

  // Pixel conversion, column-centered.
  const maxRank = Math.max(0, ...rankCols.keys());
  const maxCols = Math.max(1, ...[...rankCols.values()].map((v) => v.length));
  for (const [r, ids] of rankCols) {
    const colX = PAD_X + r * COL_GAP;
    const colY = PAD_Y + (maxCols - ids.length) * (ROW_GAP / 2);
    ids.forEach((id, i) => pos.set(id, { x: colX, y: colY + i * ROW_GAP }));
  }

  const w = PAD_X * 2 + Math.max(0, maxRank) * COL_GAP + NODE_W;
  const h = PAD_Y * 2 + maxCols * ROW_GAP - (ROW_GAP - NODE_H);
  return { pos, bounds: { x: 0, y: 0, w: Math.max(w, 300), h: Math.max(h, 120) } };
}

export function WorkflowCanvas({
  dag,
  selectedId,
  onSelect,
  height = 480,
}: {
  dag: ExecutionDag;
  selectedId?: string | null;
  onSelect?: (id: string | null) => void;
  height?: number;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const layout = useMemo(() => layoutDag(dag), [dag]);
  const base = layout.bounds;
  const [vb, setVb] = useState(base);
  const [hover, setHover] = useState<string | null>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => { setVb(base); }, [base]);

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setVb((cur) => {
        const factor = e.deltaY > 0 ? 1.12 : 0.89;
        const nw = Math.max(120, Math.min(cur.w * factor, base.w * 4));
        const nh = nw * (cur.h / cur.w);
        return { x: cur.x + (cur.w - nw) / 2, y: cur.y + (cur.h - nh) / 2, w: nw, h: nh };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [base]);

  const focus = selectedId ?? hover;
  const neighbors = useMemo(() => {
    const s = new Set<string>();
    if (!focus) return s;
    for (const e of dag.edges) {
      if (e.from === focus) s.add(e.to);
      if (e.to === focus) s.add(e.from);
    }
    return s;
  }, [dag.edges, focus]);
  const critical = useMemo(() => new Set(dag.criticalPath), [dag.criticalPath]);

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

  const edgePath = (a: Pos, b: Pos) => {
    const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2;
    const x2 = b.x, y2 = b.y + NODE_H / 2;
    const mx = (x1 + x2) / 2;
    return `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
  };

  return (
    <div className="relative overflow-hidden rounded-2xl border border-line bg-surface" style={{ height }}>
      <div className="absolute left-3 top-3 z-10 flex items-center gap-2">
        <span className="rounded-lg border border-line bg-canvas px-2.5 py-1 text-[11px] text-text-muted">
          Critical path <strong className="text-text">{dag.criticalPath.length} tasks</strong>
          {dag.criticalDurationMinutes > 0 && <span className="text-text-subtle"> · {fmtDur(dag.criticalDurationMinutes)}</span>}
        </span>
        {dag.hasCycle && (
          <span className="rounded-lg border border-danger/30 bg-danger/10 px-2.5 py-1 text-[11px] text-danger">Cycle detected — {dag.cycle.length} tasks</span>
        )}
      </div>
      <div className="absolute right-3 top-3 z-10 flex flex-col gap-1">
        <button onClick={() => setVb((c) => ({ x: c.x + c.w * 0.06, y: c.y + c.h * 0.06, w: c.w * 0.88, h: c.h * 0.88 }))} className="grid h-7 w-7 place-items-center rounded-lg border border-line bg-surface text-text-muted shadow-sm transition-colors hover:bg-surface-hover hover:text-text" title="Zoom in"><Icon name="plus" size={14} /></button>
        <button onClick={() => setVb(base)} className="grid h-7 w-7 place-items-center rounded-lg border border-line bg-surface text-text-muted shadow-sm transition-colors hover:bg-surface-hover hover:text-text" title="Reset view"><Icon name="dot" size={14} /></button>
      </div>

      <svg
        ref={svgRef}
        viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
        className="h-full w-full cursor-grab touch-none select-none active:cursor-grabbing"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerLeave={onUp}
        onClick={(e) => { if (e.target === svgRef.current) onSelect?.(null); }}
      >
        {/* dependency edges */}
        {dag.edges.filter((e) => e.kind === 'dependency').map((e, i) => {
          const a = layout.pos.get(e.from), b = layout.pos.get(e.to);
          if (!a || !b) return null;
          const active = focus === e.from || focus === e.to;
          const onCrit = critical.has(e.from) && critical.has(e.to);
          return (
            <motion.path
              key={`dep-${i}`}
              d={edgePath(a, b)}
              fill="none"
              stroke={onCrit ? 'var(--accent)' : 'var(--line-strong)'}
              strokeOpacity={active ? 0.7 : focus ? 0.12 : 0.45}
              strokeWidth={active ? 1.6 : onCrit ? 1.2 : 0.9}
              initial={{ pathLength: 0 }}
              animate={{ pathLength: 1 }}
              transition={{ duration: 0.5, delay: i * 0.015, ease: 'easeOut' }}
              className="edge-flow"
              markerEnd="url(#mc-arrow)"
            />
          );
        })}
        {/* block edges */}
        {dag.edges.filter((e) => e.kind === 'block').map((e, i) => {
          const a = layout.pos.get(e.from), b = layout.pos.get(e.to);
          if (!a || !b) return null;
          return (
            <line key={`blk-${i}`} x1={a.x + NODE_W} y1={a.y + NODE_H / 2} x2={b.x} y2={b.y + NODE_H / 2}
              stroke="var(--danger)" strokeOpacity={0.55} strokeWidth={1.2} strokeDasharray="4 4" markerEnd="url(#mc-block)" />
          );
        })}

        {/* batch guides */}
        {dag.batches.map((ids, b) => {
          if (ids.length === 0) return null;
          const first = layout.pos.get(ids[0]);
          if (!first) return null;
          const x = first.x - 10;
          const guideY = layout.bounds.y - 4;
          const guideH = layout.bounds.h + 8;
          return (
            <g key={`guide-${b}`}>
              <rect x={x} y={guideY} width={NODE_W + 20} height={guideH} rx={14} fill="none" stroke="var(--line)" strokeOpacity={0.35} strokeDasharray="2 5" />
              <text x={x + (NODE_W + 20) / 2} y={layout.bounds.y + 14} textAnchor="middle" fontSize={9} fill="var(--text-subtle)">{b === 0 ? 'Wave 1' : `Wave ${b + 1}`}</text>
            </g>
          );
        })}

        {dag.nodes.map((nd) => {
          const p = layout.pos.get(nd.id);
          if (!p) return null;
          const isFocus = focus === nd.id;
          const isNeighbor = neighbors.has(nd.id);
          const dim = focus && !isFocus && !isNeighbor;
          const fill = STATUS_FILL[nd.status];
          const onCrit = critical.has(nd.id);
          const isSelected = selectedId === nd.id;
          const IconCmp = KIND_ICON[nd.kind] ?? 'doc';
          return (
            <g key={nd.id} transform={`translate(${p.x},${p.y})`} opacity={dim ? 0.25 : 1}
              className="cursor-pointer"
              onMouseEnter={() => setHover(nd.id)}
              onMouseLeave={() => setHover(null)}
              onClick={(e) => { e.stopPropagation(); onSelect?.(nd.id); }}>
              <rect width={NODE_W} height={NODE_H} rx={12}
                fill={fill} fillOpacity={0.14}
                stroke={isSelected ? 'var(--accent)' : onCrit ? 'var(--accent)' : 'var(--line-strong)'}
                strokeWidth={isSelected ? 2 : onCrit ? 1.4 : 1}
                strokeOpacity={isSelected ? 1 : onCrit ? 0.5 : 0.4}
              />
              <circle cx={12} cy={12} r={4.5} fill={fill} />
              {nd.status === 'running' && <circle cx={12} cy={12} r={4.5} fill="none" stroke={fill} className="animate-ping" style={{ transformOrigin: '12px 12px' }} />}
              <g transform="translate(24, 6)">
                <Icon name={IconCmp} size={12} className="text-text-muted" />
              </g>
              <text x={24} y={22} fontSize={10.5} fontWeight={isFocus ? 700 : 500} fill="var(--text)"
                style={{ pointerEvents: 'none' }}>
                {nd.title.length > 30 ? nd.title.slice(0, 29) + '…' : nd.title}
              </text>
              {nd.targetFile && (
                <text x={24} y={36} fontSize={8.5} fill="var(--text-subtle)" style={{ pointerEvents: 'none' }}>
                  {nd.targetFile.length > 40 ? '…' + nd.targetFile.slice(-39) : nd.targetFile}
                </text>
              )}
              <text x={NODE_W - 10} y={36} textAnchor="end" fontSize={8.5} fontWeight={600}
                fill={fill} style={{ pointerEvents: 'none', textTransform: 'uppercase' }}>
                {RUNTIME_STATUS_LABEL[nd.status]}
              </text>
              {isFocus && (
                <g transform={`translate(${NODE_W},${NODE_H})`} className="pointer-events-none">
                  <text x={0} y={-6} textAnchor="end" fontSize={9} fill="var(--text-muted)">
                    {nd.batch + 1}/{dag.batches.length} wave · {fmtDur(nd.estimatedDurationMinutes)}
                  </text>
                </g>
              )}
            </g>
          );
        })}

        <defs>
          <marker id="mc-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
            <path d="M0 0 L7 3.5 L0 7 z" fill="var(--line-strong)" />
          </marker>
          <marker id="mc-block" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
            <path d="M0 0 L7 3.5 L0 7 z" fill="var(--danger)" />
          </marker>
        </defs>
      </svg>

      <div className="pointer-events-none absolute bottom-3 left-3 flex items-center gap-3 text-[10.5px] text-text-subtle">
        <span>{dag.nodes.length} tasks · {dag.batches.length} waves · scroll to zoom · drag to pan</span>
        <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-accent" />critical path</span>
        <span className="inline-flex items-center gap-1"><span className="h-0.5 w-4 rounded bg-line-strong" />dependency</span>
        <span className="inline-flex items-center gap-1"><span className="h-0.5 w-4 rounded border-b border-dashed border-danger" />block</span>
      </div>
      <div className="absolute bottom-3 right-3 z-10 flex flex-wrap gap-1.5">
        {(Object.keys(RUNTIME_STATUS_LABEL) as ExecutionTaskStatus[]).slice(0, 6).map((s) => (
          <span key={s} className="inline-flex items-center gap-1 rounded-full bg-surface-active px-2 py-0.5 text-[9.5px] font-medium text-text-muted">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: STATUS_FILL[s] }} />{RUNTIME_STATUS_LABEL[s]}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Small legend helper re-exported for panels that want the same tones. */
export function runtimeFill(status: ExecutionTaskStatus): string {
  return STATUS_FILL[status] ?? 'var(--surface-active)';
}
