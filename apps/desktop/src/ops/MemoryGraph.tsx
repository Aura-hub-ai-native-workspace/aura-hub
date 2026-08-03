/**
 * MemoryGraph — the Memory Graph view.
 * ------------------------------------------------------------------
 * Renders the laid-out memory graph (see layoutMemoryGraph in
 * memoryStore.ts) as a lightweight SVG: edges connect memories that
 * share a mission, diagnosis, file, symbol or architecture layer.
 * Clicking a node selects the memory in the center.
 */
import type { MemoryGraph } from './memoryStore';
import { MEMORY_CATEGORY_META } from './memoryStore';

const CATEGORY_FILL: Record<string, string> = {
  architecture: 'var(--accent-600)',
  code: 'var(--accent-500)',
  mission: 'var(--attention)',
  diagnosis: 'var(--attention)',
  documentation: 'var(--accent-400)',
  review: 'var(--attention)',
  decision: 'var(--positive)',
  learning: 'var(--text-muted)',
};

export function MemoryGraphView({
  graph,
  selectedId,
  onSelect,
  height = 420,
}: {
  graph: MemoryGraph;
  selectedId: string | null;
  onSelect: (id: string) => void;
  height?: number;
}) {
  if (graph.nodes.length === 0) {
    return (
      <div className="grid h-full min-h-[200px] place-items-center text-[12px] text-text-subtle">
        No memories yet — events will appear here as they happen.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-canvas">
      <svg
        viewBox="0 0 100 100"
        className="block h-auto w-full"
        style={{ height, maxHeight: height }}
        preserveAspectRatio="xMidYMid meet"
      >
        <g>
          {graph.edges.map((e, i) => {
            const a = graph.nodes.find((n) => n.id === e.source);
            const b = graph.nodes.find((n) => n.id === e.target);
            if (!a || !b) return null;
            return (
              <line
                key={i}
                x1={a.x * 100}
                y1={a.y * 100}
                x2={b.x * 100}
                y2={b.y * 100}
                stroke="var(--border-line)"
                strokeWidth={0.35}
              />
            );
          })}
        </g>
        <g>
          {graph.nodes.map((n) => {
            const fill = CATEGORY_FILL[n.category] ?? 'var(--text-muted)';
            const selected = n.id === selectedId;
            const cx = n.x * 100;
            const cy = n.y * 100;
            return (
              <g key={n.id} onClick={() => onSelect(n.id)} className="cursor-pointer">
                <circle cx={cx} cy={cy} r={selected ? 3.1 : 2.3} fill="var(--bg-app)" />
                <circle
                  cx={cx}
                  cy={cy}
                  r={selected ? 2.1 : 1.55}
                  fill={fill}
                  stroke={selected ? 'var(--accent-600)' : 'none'}
                  strokeWidth={0.4}
                />
                <text
                  x={cx}
                  y={cy + 3.6}
                  textAnchor="middle"
                  fontSize={2.6}
                  fill="var(--text-subtle)"
                >
                  {n.label}
                </text>
                <title>{`${MEMORY_CATEGORY_META[n.category].label} · ${n.label}`}</title>
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}
