/**
 * ConnectedEnvironment — the execution layer, as one screen.
 * ==================================================================
 * Two modes, one surface:
 *
 *   No mission  → the environment itself. What is here, what is
 *                 connected, what could be. This is the resting state.
 *   Mission open → the board takes the left column and the environment
 *                 compresses to the right, because once work is running
 *                 the question changes from "what do I have" to "what is
 *                 happening".
 *
 * Node windows float above both. A window is for *inspecting* a node
 * while the mission keeps running behind it — the workspace stays clean
 * and nothing is hidden behind a modal.
 *
 * Deliberately not a wiring canvas. n8n, Zapier, Make and Node-RED all
 * ask the user to draw the pipeline; the premise here is that they
 * shouldn't have to. What is worth showing is state and progress, so
 * that is what the layout spends its space on.
 */

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { cn, spring } from '@aura/core';
import { Icon, type IconName } from '@aura/ui';
import {
  CATEGORY_LABELS,
  describeEnvironment,
  type EnvironmentNode,
  type NodeCategory,
} from '@aura/connected-environment';
import { useCapabilityGaps, useEnvironmentStore, useEnvironmentSummary } from './environmentStore';
import { FABRIC_CORE_REQUIREMENTS } from './fabricRequirements';
import { GapPanel } from './GapPanel';
import { NodeCard } from './NodeCard';
import { NodeInspector } from './NodeInspector';
import { FloatingSurface } from './windows/FloatingSurface';
import { useWindowManager } from './windows/windowManager';
import { CATEGORY_ICON, STATUS_TONE, TONE_DOT } from './presentation';

type Filter = 'connected' | 'here' | 'all';

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'connected', label: 'Connected' },
  { id: 'here', label: 'On this machine' },
  { id: 'all', label: 'Everything' },
];

export function ConnectedEnvironment() {
  const nodes = useEnvironmentStore((s) => s.nodes);
  const scanning = useEnvironmentStore((s) => s.scanning);
  const lastScanAt = useEnvironmentStore((s) => s.lastScanAt);
  const busy = useEnvironmentStore((s) => s.busy);
  const scan = useEnvironmentStore((s) => s.scan);
  const connect = useEnvironmentStore((s) => s.connect);
  const disconnect = useEnvironmentStore((s) => s.disconnect);

  const summary = useEnvironmentSummary();
  // What the execution layer still needs to be fully operational. Real
  // gaps against the real environment — not tied to any mission, so this
  // screen never holds mission state.
  const coreGaps = useCapabilityGaps(FABRIC_CORE_REQUIREMENTS);
  const openWindow = useWindowManager((s) => s.open);
  const canvasRef = useRef<HTMLDivElement>(null);
  const setCanvas = useWindowManager((s) => s.setCanvas);

  const [filter, setFilter] = useState<Filter>('connected');

  // One scan on first mount. The environment starts unmeasured on every
  // launch by design — a remembered "Docker is connected" that is no
  // longer true is worse than not knowing.
  useEffect(() => { void scan(); }, [scan]);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      setCanvas(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [setCanvas]);

  const visible = useMemo(() => filterNodes(nodes, filter), [nodes, filter]);
  const grouped = useMemo(() => groupByCategory(visible), [visible]);

  // The canvas is the *non-scrolling* frame; content scrolls inside it.
  // Node windows are positioned against the frame, so a scroll never drags
  // a floating window off with it.
  return (
    <div ref={canvasRef} className="relative flex h-full min-h-0 flex-col overflow-hidden bg-app">
      <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[1320px] px-6 py-7">
        <Header
          summary={summary}
          scanning={scanning}
          lastScanAt={lastScanAt}
          onScan={() => void scan(true)}
        />

        <div className="mt-7 grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,380px)]">
          <div className="min-w-0 space-y-4 lg:order-2">
            <div>
              <h2 className="text-[13px] font-semibold text-text">Execution readiness</h2>
              <p className="mt-1 text-[11.5px] leading-relaxed text-text-muted">
                What the Capability Fabric still needs before it can carry the core execution surface —
                files, terminal, source control, code hosting and browser verification.
              </p>
            </div>
            <GapPanel
              gaps={coreGaps}
              busy={busy}
              onConnect={(id) => void connect(id)}
              onInspect={openWindow}
            />
          </div>

          <div className="min-w-0 space-y-4 lg:order-1">
            <section>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <h2 className="text-[13px] font-semibold text-text">Environment</h2>
                <span className="text-[11px] text-text-subtle">{visible.length} shown</span>
                <div className="ml-auto flex items-center gap-1 rounded-xl border border-line bg-surface p-0.5">
                  {FILTERS.map((f) => (
                    <button
                      key={f.id}
                      onClick={() => setFilter(f.id)}
                      className={cn(
                        'rounded-lg px-2 py-1 text-[11px] font-medium transition-colors',
                        filter === f.id ? 'bg-surface-active text-text' : 'text-text-muted hover:text-text',
                      )}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>

              {visible.length === 0 ? (
                <EmptyFilter filter={filter} onShowAll={() => setFilter('all')} />
              ) : (
                <div className="space-y-5">
                  {grouped.map(([category, list]) => (
                    <div key={category}>
                      <div className="mb-2 flex items-center gap-1.5">
                        <Icon name={CATEGORY_ICON[category]} size={12} className="text-text-subtle" />
                        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-text-subtle">
                          {CATEGORY_LABELS[category]}
                        </h3>
                        <span className="text-[10.5px] text-text-subtle">{list.length}</span>
                      </div>
                      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                        {list.map((node) => (
                          <NodeCard
                            key={node.id}
                            node={node}
                            busy={busy.includes(node.id)}
                            onConnect={() => void connect(node.id)}
                            onDisconnect={() => disconnect(node.id)}
                            onInspect={() => openWindow(node.id)}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        </div>
      </div>
      </div>

      <NodeWindows canvasRef={canvasRef} />
      <WindowTray />
    </div>
  );
}

/* ── header ─────────────────────────────────────────────────────── */

function Header({
  summary,
  scanning,
  lastScanAt,
  onScan,
}: {
  summary: { connected: number; available: number; catalogued: number; running: number };
  scanning: boolean;
  lastScanAt: string | null;
  onScan: () => void;
}) {
  return (
    <header className="flex flex-wrap items-start gap-4">
      <div className="min-w-0 flex-1">
        <h1 className="text-[22px] font-semibold tracking-tight text-text">Connected Environment</h1>
        <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-text-muted">
          Everything outside AURA Hub is a node here. You describe the outcome; the Hub reads the request, plans it,
          routes each step to whichever node can actually do it, and tells you what it assumed along the way.
        </p>
        <p className="mt-2 text-[11.5px] text-text-subtle">
          {describeEnvironment(summary)}
          {lastScanAt && ` Last scanned ${new Date(lastScanAt).toLocaleTimeString()}.`}
        </p>
      </div>
      <button
        onClick={onScan}
        disabled={scanning}
        className="flex h-8 shrink-0 items-center gap-1.5 rounded-xl border border-line bg-surface px-3 text-[12px] font-medium text-text-muted transition-colors hover:border-line-strong hover:text-text disabled:opacity-60"
      >
        <Icon name="refresh" size={13} className={scanning ? 'animate-spin' : undefined} />
        {scanning ? 'Scanning…' : 'Scan this machine'}
      </button>
    </header>
  );
}

function EmptyFilter({ filter, onShowAll }: { filter: Filter; onShowAll: () => void }) {
  const copy =
    filter === 'connected'
      ? 'Nothing is connected yet. Scan this machine to find what is already installed, or browse everything the Hub can plan against.'
      : 'Nothing was found on this machine for that filter. Everything the Hub knows about is still available to plan against.';
  return (
    <div className="rounded-2xl border border-line bg-surface p-5 text-center">
      <p className="text-[12.5px] text-text-muted">{copy}</p>
      <button
        onClick={onShowAll}
        className="mt-2.5 rounded-lg border border-line px-2.5 py-1 text-[11.5px] font-medium text-text transition-colors hover:border-line-strong"
      >
        Show everything
      </button>
    </div>
  );
}

/* ── node windows ───────────────────────────────────────────────── */

function NodeWindows({ canvasRef }: { canvasRef: RefObject<HTMLDivElement | null> }) {
  const windows = useWindowManager((s) => s.windows);
  const nodes = useEnvironmentStore((s) => s.nodes);
  const busy = useEnvironmentStore((s) => s.busy);
  const connect = useEnvironmentStore((s) => s.connect);
  const disconnect = useEnvironmentStore((s) => s.disconnect);
  const setNodePermissions = useEnvironmentStore((s) => s.setNodePermissions);

  return (
    <AnimatePresence>
      {windows.map((win) => {
        const node = nodes.find((n) => n.id === win.contentId);
        if (!node) return null;
        const tone = STATUS_TONE[node.health.status];
        return (
          <FloatingSurface
            key={win.id}
            window={win}
            canvasRef={canvasRef}
            title={node.entry.name}
            icon={CATEGORY_ICON[node.entry.category]}
            subtitle={node.health.version}
            toneClass={TONE_DOT[tone]}
          >
            <NodeInspector
              node={node}
              busy={busy.includes(node.id)}
              onConnect={() => void connect(node.id)}
              onDisconnect={() => disconnect(node.id)}
              onPermissions={(partial) => setNodePermissions(node.id, partial)}
            />
          </FloatingSurface>
        );
      })}
    </AnimatePresence>
  );
}

/** Dock for open node windows — mirrors the Workspace's tray vocabulary. */
function WindowTray() {
  const windows = useWindowManager((s) => s.windows);
  const focusedId = useWindowManager((s) => s.focusedId);
  const focus = useWindowManager((s) => s.focus);
  const minimize = useWindowManager((s) => s.minimize);
  const closeAll = useWindowManager((s) => s.closeAll);
  const nodes = useEnvironmentStore((s) => s.nodes);

  if (!windows.length) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={spring.smooth}
      className="pointer-events-none absolute inset-x-0 bottom-3 z-40 flex justify-center"
    >
      <div className="pointer-events-auto flex items-center gap-1 rounded-2xl border border-line bg-surface/90 p-1.5 shadow-lg backdrop-blur-xl">
        {windows.map((win) => {
          const node = nodes.find((n) => n.id === win.contentId);
          if (!node) return null;
          const active = focusedId === win.id && !win.minimized;
          return (
            <button
              key={win.id}
              onClick={() => (active ? minimize(win.id) : focus(win.id))}
              title={node.entry.name}
              className={cn(
                'grid h-8 w-8 place-items-center rounded-xl transition-all hover:scale-105',
                active ? 'bg-accent/15 text-accent' : 'text-text-muted hover:bg-surface-hover hover:text-text',
              )}
            >
              <Icon name={CATEGORY_ICON[node.entry.category] as IconName} size={14} />
            </button>
          );
        })}
        <span className="mx-0.5 h-5 w-px bg-line" />
        <button
          onClick={closeAll}
          title="Close all windows"
          className="grid h-8 w-8 place-items-center rounded-xl text-text-subtle transition-colors hover:bg-surface-hover hover:text-text"
        >
          <Icon name="close" size={12} />
        </button>
      </div>
    </motion.div>
  );
}

/* ── grouping ───────────────────────────────────────────────────── */

function filterNodes(nodes: EnvironmentNode[], filter: Filter): EnvironmentNode[] {
  if (filter === 'all') return nodes;
  if (filter === 'connected') return nodes.filter((n) => n.connected);
  return nodes.filter((n) => n.connected || n.health.status === 'available');
}

const CATEGORY_ORDER: NodeCategory[] = ['hub', 'development', 'cloud', 'ai', 'design', 'productivity', 'browser'];

function groupByCategory(nodes: EnvironmentNode[]): [NodeCategory, EnvironmentNode[]][] {
  return CATEGORY_ORDER
    .map((category) => [category, nodes.filter((n) => n.entry.category === category)] as [NodeCategory, EnvironmentNode[]])
    .filter(([, list]) => list.length > 0);
}
