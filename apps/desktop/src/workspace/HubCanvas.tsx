/**
 * HubCanvas — the Workspace's spatial execution surface.
 * ==================================================================
 * The Hub sits at the centre; capability nodes surround it; an edge is
 * drawn from the Hub to each node. The edges represent **which
 * capabilities the Hub can reach**, not a user-drawn pipeline — this is
 * deliberately not n8n/Zapier/Node-RED, and there is no way to wire node
 * to node. Execution relationships are decided by the mission DAG, never
 * by dragging.
 *
 * Every status shown here is measured. A node's colour and label come from
 * `environmentStore`, whose values are produced by real `execFile` probes
 * of this machine (`ai-service/src/environment.ts`). A node that has not
 * been scanned says "Not scanned" rather than guessing.
 */

import { useCallback, useRef, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { motion } from 'framer-motion';
import { cn } from '@aura/core';
import { Icon } from '@aura/ui';
import type { EnvironmentNode } from '@aura/connected-environment';
import { ACTIVITY_LABEL, NodeActivityPhase } from '../workspace/hubPhase';
import { STATUS_LABEL, STATUS_TONE, TONE_DOT, TONE_TEXT, CATEGORY_ICON } from '../environment/presentation';
import { useHubStore, type PlacedNode } from './hubStore';
import { NodeStatus } from '@aura/connected-environment';

/** Nodes whose capability is genuinely present get a solid edge. */
const LIVE_STATUSES = new Set(['connected', 'available']);

/** Maps node health status to status colors. */
const STATUS_COLOR_MAP: Record<NodeStatus, string> = {
  connected: '#22c55e',
  available: '#3b82f6',
  'not-installed': '#f87171',
  installing: '#f59e0b',
  uninstalling: '#f59e0b',
  degraded: '#f59e0b',
  'needs-auth': '#8b5cf6',
  'no-connector': '#6b7280',
  unknown: '#6b7280',
};

export function HubCanvas({
  nodes,
  canvasRef,
  onInspect,
  hub,
  activity,
}: {
  /** Placed nodes paired with their live measured state (null = catalogue miss). */
  nodes: { placed: PlacedNode; node: EnvironmentNode | null }[];
  canvasRef: RefObject<HTMLDivElement | null>;
  onInspect: (nodeId: string) => void;
  /** The Hub surface, rendered at the centre of the canvas. */
  hub: React.ReactNode;
  /**
   * Live execution phase per node, projected from the running mission.
   * Empty whenever nothing is executing — a node is never animated
   * without a real in-flight task behind it.
   */
  activity: Map<string, NodeActivityPhase>;
}) {
  // The ref is owned and attached by the screen (matching how the
  // Connected Environment does it); this component only reads it for drag
  // maths, so it must not attach it a second time.
  return (
    <div className="absolute inset-0 overflow-hidden">
      <EdgeLayer nodes={nodes} activity={activity} />

      {/* Hub — centred, above the edges. */}
      <div className="pointer-events-none absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2">
        {hub}
      </div>

      {nodes.map(({ placed, node }) => (
        <NodeChip
          key={placed.nodeId}
          placed={placed}
          node={node}
          canvasRef={canvasRef}
          activity={activity.get(placed.nodeId) ?? 'idle'}
          onInspect={() => onInspect(placed.nodeId)}
        />
      ))}
    </div>
  );
}

/**
 * The connector lines. Drawn in a single SVG beneath the nodes so an edge
 * can never sit on top of the thing it connects.
 */
function EdgeLayer({
  nodes,
  activity,
}: {
  nodes: { placed: PlacedNode; node: EnvironmentNode | null }[];
  activity: Map<string, NodeActivityPhase>;
}) {
  return (
    <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden>
      {nodes.map(({ placed, node }) => {
        const live = node ? LIVE_STATUSES.has(node.health.status) : false;
        const busy = (activity.get(placed.nodeId) ?? 'idle') !== 'idle';
        return (
          <line
            key={placed.nodeId}
            x1="50%"
            y1="50%"
            x2={`${placed.x * 100}%`}
            y2={`${placed.y * 100}%`}
            stroke="currentColor"
            className={cn(
              'group/data-[busy=true]:opacity-100',
              'group/data-[busy=false]:opacity-40',
              busy ? 'text-accent' : live ? 'text-accent/35' : 'text-line',
            )}
            strokeWidth={busy ? 2 : live ? 1.5 : 1}
            // A capability that isn't actually there gets a broken line —
            // the connection is catalogued, not established.
            strokeDasharray={live ? undefined : '4 5'}
          />
        );
      })}
    </svg>
  );
}

function NodeChip({
  placed,
  node,
  canvasRef,
  activity,
  onInspect,
}: {
  placed: PlacedNode;
  node: EnvironmentNode | null;
  canvasRef: RefObject<HTMLDivElement | null>;
  activity: NodeActivityPhase;
  onInspect: () => void;
}) {
  const move = useHubStore((s) => s.move);
  const dragging = useRef(false);
  const moved = useRef(false);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLButtonElement>) => {
      if (e.button !== 0) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      dragging.current = true;
      moved.current = false;
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [canvasRef],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLButtonElement>) => {
      if (!dragging.current) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      moved.current = true;
      move(placed.nodeId, (e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height);
    },
    [canvasRef, move, placed.nodeId],
  );

  const onPointerUp = useCallback((e: ReactPointerEvent<HTMLButtonElement>) => {
    dragging.current = false;
    e.currentTarget.releasePointerCapture(e.pointerId);
    // A drag must not also open the inspector, or every reposition would
    // pop a window; a click that never moved is a genuine click.
    if (!moved.current) onInspect();
  }, [onInspect]);

  // A placed node whose catalogue entry vanished is shown honestly rather
  // than hidden, so the user can remove it.
  const status = node?.health.status ?? 'unknown';
  const tone = STATUS_TONE[status];
  const name = node?.entry.name ?? placed.nodeId;

  return (
    <motion.div
      className="absolute z-[5]"
      style={{
        left: `${placed.x * 100}%`,
        top: `${placed.y * 100}%`,
        x: '-50%',
        y: '-50%',
      }}
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.2 }}
      role="button"
      tabIndex={0}
      onFocus={() => onInspect()}
      onBlur={() => {}}
    >
      <button
        data-testid="hub-node"
        data-node-id={placed.nodeId}
        data-status={status}
        data-activity={activity}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        title={`${name} — ${STATUS_LABEL[status]}${activity === 'idle' ? '' : ` · ${ACTIVITY_LABEL[activity]}`}`}
        className={cn(
          'group flex w-[140px] cursor-grab flex-col items-center gap-1.5 rounded-2xl border bg-surface/95 px-3 py-2.5 shadow-sm backdrop-blur-sm transition-colors hover:border-line-strong active:cursor-grabbing',
          activity === 'idle' ? 'border-line' : 'border-accent',
          // Hover styles for when keyboard-focused
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-surface-active',
        )}
      >
        <span className="relative grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-surface-active text-text-muted">
          <Icon name={node ? CATEGORY_ICON[node.entry.category] : 'dot'} size={17} />
          {/* Pulses only while a real task is in flight on this node. */}
          {activity === 'running' && (
            <span className="absolute -inset-1 animate-ping rounded-xl border border-accent/40" />
          )}
        </span>
        <span className="w-full truncate text-center text-[12px] font-medium text-text">{name}</span>
        <span className={cn('flex items-center gap-1.5 text-[10px]', TONE_TEXT[tone])}>
          <span className={cn('h-1.5 w-1.5 rounded-full', TONE_DOT[tone])} />
          {STATUS_LABEL[status]}
        </span>
        {/* Axis B, shown alongside status rather than replacing it: a node
            is `status × phase`, never one masquerading as the other. */}
        {activity !== 'idle' && (
          <span className="w-full truncate text-center text-[9.5px] font-medium text-accent">
            {ACTIVITY_LABEL[activity]}
          </span>
        )}
        {node?.health.version && (
          <span className="w-full truncate text-center font-mono text-[9.5px] text-text-subtle">
            {node.health.version}
          </span>
        )}
        {/* Connection indicator dot */}
        {node && (
          <span className="absolute -bottom-0.5 -left-0.5 h-3 w-3 rounded-full" style={{ background: STATUS_COLOR_MAP[node?.health.status as NodeStatus] }}>
            {/* Pulsing when task is running on this node */}
            {activity === 'running' && (
              <span className="aura-live" />
            )}
          </span>
        )}
      </button>
    </motion.div>
  );
}