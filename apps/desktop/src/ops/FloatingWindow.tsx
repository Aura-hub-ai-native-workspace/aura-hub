/**
 * FloatingWindow — one independent window on the Workspace canvas.
 * ------------------------------------------------------------------
 * In-page only: absolutely positioned within the canvas, not a native OS
 * window (true multi-window doesn't exist anywhere in this app's Tauri
 * config/Rust/frontend — see the Workspace V2 reconstruction plan).
 * Draggable, resizable from any edge or corner, minimizable, maximizable,
 * closable, and focusable — click anywhere on it to bring it to front.
 * Renders through the same lazy-loaded PanelContent registry every window
 * kind uses.
 *
 * Motion (Workspace V3): mount/unmount and focus/recede use the existing
 * spring vocabulary from motion.ts — nothing here invents new timing.
 * Resize stays direct/unsprung on purpose (springing an active resize
 * would fight the user's hand); minimize plays a short "collapse toward
 * the tray" animation before the store actually hides it.
 */
import { memo, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { motion } from 'framer-motion';
import { cn, spring, SHADOW } from '@aura/core';
import { Icon, type IconName } from '@aura/ui';
import { PANEL_META, useLayoutStore, type WindowState } from './layoutStore';
import { PanelContent } from './panels';

const SNAP_BAND = 32;
const EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const;
type Edge = (typeof EDGES)[number];

const EDGE_CURSOR: Record<Edge, string> = {
  n: 'cursor-ns-resize', s: 'cursor-ns-resize',
  e: 'cursor-ew-resize', w: 'cursor-ew-resize',
  ne: 'cursor-nesw-resize', sw: 'cursor-nesw-resize',
  nw: 'cursor-nwse-resize', se: 'cursor-nwse-resize',
};

export const FloatingWindow = memo(function FloatingWindow({
  window: win,
  canvasRef,
}: {
  window: WindowState;
  canvasRef: RefObject<HTMLDivElement | null>;
}) {
  const closeWindow = useLayoutStore((s) => s.closeWindow);
  const focusWindow = useLayoutStore((s) => s.focusWindow);
  const minimizeWindow = useLayoutStore((s) => s.minimizeWindow);
  const toggleMaximize = useLayoutStore((s) => s.toggleMaximize);
  const moveWindow = useLayoutStore((s) => s.moveWindow);
  const setRect = useLayoutStore((s) => s.setRect);
  const focusedWindowId = useLayoutStore((s) => s.focusedWindowId);
  const meta = PANEL_META[win.kind];
  const [snapPreview, setSnapPreview] = useState<'left' | 'right' | 'top' | null>(null);
  const [dragging, setDragging] = useState(false);
  const [minimizing, setMinimizing] = useState(false);
  const focused = focusedWindowId === win.id;

  const canvasRect = () => canvasRef.current?.getBoundingClientRect() ?? { width: 1200, height: 800, left: 0, top: 0 };

  const onDragTitle = (e: ReactPointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    focusWindow(win.id);
    e.currentTarget.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startY = e.clientY;
    const wasMaximized = win.maximized;
    const originX = wasMaximized ? Math.max(0, e.clientX - win.width / 2) : win.x;
    const originY = wasMaximized ? 0 : win.y;
    if (wasMaximized) setRect(win.id, { x: originX, y: originY, width: win.width, height: win.height });
    setDragging(true);

    const onMove = (ev: PointerEvent) => {
      const nx = originX + (ev.clientX - startX);
      const ny = originY + (ev.clientY - startY);
      moveWindow(win.id, nx, ny);
      const cr = canvasRect();
      const localX = ev.clientX - cr.left;
      const localY = ev.clientY - cr.top;
      if (localY < SNAP_BAND) setSnapPreview('top');
      else if (localX < SNAP_BAND) setSnapPreview('left');
      else if (localX > cr.width - SNAP_BAND) setSnapPreview('right');
      else setSnapPreview(null);
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setDragging(false);
      const cr = canvasRect();
      const localX = ev.clientX - cr.left;
      const localY = ev.clientY - cr.top;
      if (localY < SNAP_BAND) {
        toggleMaximize(win.id);
      } else if (localX < SNAP_BAND) {
        setRect(win.id, { x: 0, y: 0, width: cr.width / 2, height: cr.height });
      } else if (localX > cr.width - SNAP_BAND) {
        setRect(win.id, { x: cr.width / 2, y: 0, width: cr.width / 2, height: cr.height });
      }
      setSnapPreview(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const onResize = (edge: Edge) => (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    focusWindow(win.id);
    e.currentTarget.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startY = e.clientY;
    const origin = { x: win.x, y: win.y, width: win.width, height: win.height };

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      let { x, y, width, height } = origin;
      if (edge.includes('e')) width = origin.width + dx;
      if (edge.includes('s')) height = origin.height + dy;
      if (edge.includes('w')) { width = origin.width - dx; x = origin.x + dx; }
      if (edge.includes('n')) { height = origin.height - dy; y = origin.y + dy; }
      setRect(win.id, { x, y, width, height });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const handleMinimize = () => setMinimizing(true);

  if (win.minimized) return null;

  const style = win.maximized
    ? { left: 0, top: 0, right: 0, bottom: 0 }
    : { left: win.x, top: win.y, width: win.width, height: win.height };

  // The genie target: translate the window's own center to the canvas'
  // bottom-center (roughly where the tray sits) while shrinking away —
  // not pixel-exact to a specific tray chip, which may not exist yet the
  // first time a window is minimized.
  const cr = canvasRect();
  const centerX = win.x + win.width / 2;
  const centerY = win.y + win.height / 2;
  const minimizeTarget = { x: cr.width / 2 - centerX, y: cr.height - centerY - 24 };

  const animate = minimizing
    ? { opacity: 0, scale: 0.08, x: minimizeTarget.x, y: minimizeTarget.y }
    : {
        opacity: focused ? 1 : 0.95,
        scale: dragging ? 1.015 : 1,
        x: 0,
        y: 0,
        boxShadow: focused ? SHADOW.lg : SHADOW.sm,
      };

  return (
    <>
      {snapPreview && (
        <div
          className="pointer-events-none absolute z-10 rounded-xl border-2 border-accent bg-accent/10"
          style={
            snapPreview === 'top'
              ? { inset: 0 }
              : snapPreview === 'left'
              ? { left: 0, top: 0, bottom: 0, width: '50%' }
              : { right: 0, top: 0, bottom: 0, width: '50%' }
          }
        />
      )}
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }}
        animate={animate}
        exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.16 } }}
        transition={dragging ? spring.snappy : minimizing ? spring.snappy : spring.smooth}
        onAnimationComplete={
          minimizing
            ? () => {
                // Commit the minimize to the store, then clear the local
                // flag immediately — this component instance stays mounted
                // (only its JSX collapses to null below) for as long as the
                // window sits in the tray, so a stale `minimizing` here
                // would otherwise make the *next* restore render at the
                // old shrink-toward-tray target forever.
                minimizeWindow(win.id);
                setMinimizing(false);
              }
            : undefined
        }
        onPointerDownCapture={() => focusWindow(win.id)}
        // Observable identity for verification runs — the same convention the
        // Hub canvas uses for its nodes. No visual effect.
        data-testid="workspace-window"
        data-panel-kind={win.kind}
        className={cn(
          'absolute z-20 flex flex-col overflow-hidden rounded-2xl border bg-surface backdrop-blur-xl',
          focused ? 'border-line-strong' : 'border-line',
        )}
        style={{ ...style, zIndex: win.z }}
      >
        <div
          onPointerDown={onDragTitle}
          onDoubleClick={() => toggleMaximize(win.id)}
          className="flex h-10 shrink-0 cursor-grab items-center gap-2 border-b border-line bg-surface-active/60 px-3 backdrop-blur-sm active:cursor-grabbing"
        >
          <Icon name={meta.icon as IconName} size={13} className="text-text-subtle" />
          <span className="flex-1 truncate text-[12px] font-medium text-text">{meta.label}</span>
          <WindowButton icon="minimize" title="Minimize" onClick={handleMinimize} />
          <WindowButton icon={win.maximized ? 'restore' : 'maximize'} title={win.maximized ? 'Restore' : 'Maximize'} onClick={() => toggleMaximize(win.id)} />
          <WindowButton icon="close" title="Close" onClick={() => closeWindow(win.id)} />
        </div>
        <div className="flex min-h-0 flex-1 flex-col">
          <PanelContent kind={win.kind} />
        </div>
        {!win.maximized && EDGES.map((edge) => <ResizeHandle key={edge} edge={edge} onPointerDown={onResize(edge)} />)}
      </motion.div>
    </>
  );
});

function WindowButton({ icon, title, onClick }: { icon: IconName; title: string; onClick: () => void }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      title={title}
      className="grid h-5 w-5 shrink-0 place-items-center rounded text-text-subtle outline-none transition-all hover:scale-105 hover:bg-surface-hover hover:text-text focus-visible:ring-2 focus-visible:ring-accent/50"
    >
      <Icon name={icon} size={11} />
    </button>
  );
}

const EDGE_STYLE: Record<Edge, string> = {
  n: 'inset-x-0 top-0 h-1.5',
  s: 'inset-x-0 bottom-0 h-1.5',
  w: 'inset-y-0 left-0 w-1.5',
  e: 'inset-y-0 right-0 w-1.5',
  nw: 'left-0 top-0 h-3 w-3',
  ne: 'right-0 top-0 h-3 w-3',
  sw: 'left-0 bottom-0 h-3 w-3',
  se: 'right-0 bottom-0 h-3 w-3',
};

function ResizeHandle({ edge, onPointerDown }: { edge: Edge; onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void }) {
  return (
    <div
      onPointerDown={onPointerDown}
      className={cn('absolute z-10', EDGE_STYLE[edge], EDGE_CURSOR[edge])}
    />
  );
}
