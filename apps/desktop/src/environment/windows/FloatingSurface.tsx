/**
 * FloatingSurface — one draggable, resizable, snappable window.
 * ==================================================================
 * Content-agnostic: it renders a title bar from the props it is given and
 * whatever children the caller passes. Drag, resize from any edge or
 * corner, snap to half/full on the canvas edges, minimize, maximize,
 * restore, close, and click-to-focus all live here so no caller has to
 * reimplement them.
 *
 * Pointer handling uses window-level listeners rather than pointer
 * capture on the handle, because a fast drag can outrun a small target
 * and drop the capture mid-gesture — the window would stick to the
 * cursor's last known position and stop following the hand.
 */

import { memo, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react';
import { motion } from 'framer-motion';
import { cn, spring, SHADOW } from '@aura/core';
import { Icon, type IconName } from '@aura/ui';
import { MIN_H, MIN_W, useWindowManager, type SurfaceWindow } from './windowManager';

const SNAP_BAND = 30;
const EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const;
type Edge = (typeof EDGES)[number];

const EDGE_CURSOR: Record<Edge, string> = {
  n: 'cursor-ns-resize', s: 'cursor-ns-resize',
  e: 'cursor-ew-resize', w: 'cursor-ew-resize',
  ne: 'cursor-nesw-resize', sw: 'cursor-nesw-resize',
  nw: 'cursor-nwse-resize', se: 'cursor-nwse-resize',
};

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

export interface FloatingSurfaceProps {
  window: SurfaceWindow;
  canvasRef: RefObject<HTMLDivElement | null>;
  title: string;
  icon: IconName;
  /** Small status text beside the title — e.g. "Connected · 27.0.3". */
  subtitle?: string;
  /** Accent dot colour class for the title bar, when the content has a state. */
  toneClass?: string;
  children: ReactNode;
}

export const FloatingSurface = memo(function FloatingSurface({
  window: win,
  canvasRef,
  title,
  icon,
  subtitle,
  toneClass,
  children,
}: FloatingSurfaceProps) {
  const close = useWindowManager((s) => s.close);
  const focus = useWindowManager((s) => s.focus);
  const minimize = useWindowManager((s) => s.minimize);
  const toggleMaximize = useWindowManager((s) => s.toggleMaximize);
  const move = useWindowManager((s) => s.move);
  const setRect = useWindowManager((s) => s.setRect);
  const focusedId = useWindowManager((s) => s.focusedId);
  const [snap, setSnap] = useState<'left' | 'right' | 'top' | null>(null);
  const [dragging, setDragging] = useState(false);
  const focused = focusedId === win.id;

  const canvasRect = () =>
    canvasRef.current?.getBoundingClientRect() ?? { width: 1100, height: 720, left: 0, top: 0 };

  const onDragTitle = (e: ReactPointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    focus(win.id);
    const startX = e.clientX;
    const startY = e.clientY;
    // Un-maximizing mid-drag re-anchors the window under the cursor so it
    // doesn't jump to the old top-left the instant it is grabbed.
    const originX = win.maximized ? Math.max(0, e.clientX - win.width / 2) : win.x;
    const originY = win.maximized ? 0 : win.y;
    if (win.maximized) setRect(win.id, { x: originX, y: originY, width: win.width, height: win.height });
    setDragging(true);

    const onMove = (ev: PointerEvent) => {
      move(win.id, originX + (ev.clientX - startX), originY + (ev.clientY - startY));
      const cr = canvasRect();
      const lx = ev.clientX - cr.left;
      const ly = ev.clientY - cr.top;
      if (ly < SNAP_BAND) setSnap('top');
      else if (lx < SNAP_BAND) setSnap('left');
      else if (lx > cr.width - SNAP_BAND) setSnap('right');
      else setSnap(null);
    };
    const onUp = (ev: PointerEvent) => {
      globalThis.removeEventListener('pointermove', onMove);
      globalThis.removeEventListener('pointerup', onUp);
      setDragging(false);
      const cr = canvasRect();
      const lx = ev.clientX - cr.left;
      const ly = ev.clientY - cr.top;
      if (ly < SNAP_BAND) toggleMaximize(win.id);
      else if (lx < SNAP_BAND) setRect(win.id, { x: 0, y: 0, width: cr.width / 2, height: cr.height });
      else if (lx > cr.width - SNAP_BAND) setRect(win.id, { x: cr.width / 2, y: 0, width: cr.width / 2, height: cr.height });
      setSnap(null);
    };
    globalThis.addEventListener('pointermove', onMove);
    globalThis.addEventListener('pointerup', onUp);
  };

  const onResize = (edge: Edge) => (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    focus(win.id);
    const startX = e.clientX;
    const startY = e.clientY;
    const origin = { x: win.x, y: win.y, width: win.width, height: win.height };

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      let { x, y, width, height } = origin;
      if (edge.includes('e')) width = origin.width + dx;
      if (edge.includes('s')) height = origin.height + dy;
      // Dragging a west/north edge past the minimum must stop moving the
      // origin too, or the window slides sideways while refusing to shrink.
      if (edge.includes('w')) { width = Math.max(MIN_W, origin.width - dx); x = origin.x + (origin.width - width); }
      if (edge.includes('n')) { height = Math.max(MIN_H, origin.height - dy); y = origin.y + (origin.height - height); }
      setRect(win.id, { x, y, width, height });
    };
    const onUp = () => {
      globalThis.removeEventListener('pointermove', onMove);
      globalThis.removeEventListener('pointerup', onUp);
    };
    globalThis.addEventListener('pointermove', onMove);
    globalThis.addEventListener('pointerup', onUp);
  };

  if (win.minimized) return null;

  const style = win.maximized
    ? { left: 0, top: 0, right: 0, bottom: 0 }
    : { left: win.x, top: win.y, width: win.width, height: win.height };

  return (
    <>
      {snap && (
        <div
          className="pointer-events-none absolute z-10 rounded-xl border-2 border-accent bg-accent/10"
          style={
            snap === 'top' ? { inset: 0 }
              : snap === 'left' ? { left: 0, top: 0, bottom: 0, width: '50%' }
              : { right: 0, top: 0, bottom: 0, width: '50%' }
          }
        />
      )}
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{
          opacity: focused ? 1 : 0.96,
          scale: dragging ? 1.012 : 1,
          boxShadow: focused ? SHADOW.lg : SHADOW.sm,
        }}
        exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.15 } }}
        transition={dragging ? spring.snappy : spring.smooth}
        onPointerDownCapture={() => focus(win.id)}
        className={cn(
          'absolute flex flex-col overflow-hidden rounded-2xl border bg-surface backdrop-blur-xl',
          focused ? 'border-line-strong' : 'border-line',
        )}
        style={{ ...style, zIndex: win.z }}
      >
        <div
          onPointerDown={onDragTitle}
          onDoubleClick={() => toggleMaximize(win.id)}
          className="flex h-9 shrink-0 cursor-grab items-center gap-2 border-b border-line bg-surface-active/60 px-3 active:cursor-grabbing"
        >
          {toneClass && <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', toneClass)} />}
          <Icon name={icon} size={13} className="shrink-0 text-text-subtle" />
          <span className="truncate text-[12px] font-medium text-text">{title}</span>
          {subtitle && <span className="truncate text-[10.5px] text-text-subtle">{subtitle}</span>}
          <span className="ml-auto flex items-center gap-0.5">
            <TitleButton icon="minimize" title="Minimize" onClick={() => minimize(win.id)} />
            <TitleButton
              icon={win.maximized ? 'restore' : 'maximize'}
              title={win.maximized ? 'Restore' : 'Maximize'}
              onClick={() => toggleMaximize(win.id)}
            />
            <TitleButton icon="close" title="Close" onClick={() => close(win.id)} />
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        {!win.maximized && EDGES.map((edge) => (
          <div
            key={edge}
            onPointerDown={onResize(edge)}
            className={cn('absolute z-10', EDGE_STYLE[edge], EDGE_CURSOR[edge])}
          />
        ))}
      </motion.div>
    </>
  );
});

function TitleButton({ icon, title, onClick }: { icon: IconName; title: string; onClick: () => void }) {
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
