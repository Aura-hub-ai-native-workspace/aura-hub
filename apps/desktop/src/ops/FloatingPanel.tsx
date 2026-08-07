/**
 * FloatingPanel — a panel detached from the split tree.
 * ------------------------------------------------------------------
 * In-page only: absolutely positioned within the Workspace canvas, not
 * a native OS window (see the Windows & Tools design review — true
 * multi-window support doesn't exist anywhere in this app's Tauri
 * config/Rust/frontend and is out of scope here). Renders through the
 * same lazy-loaded PanelContent registry every docked panel uses.
 */
import { type PointerEvent as ReactPointerEvent } from 'react';
import { Icon, type IconName } from '@aura/ui';
import { PANEL_META, useLayoutStore, type FloatingPanelState } from './layoutStore';
import { PanelContent } from './panels';

export function FloatingPanel({ panel }: { panel: FloatingPanelState }) {
  const closeFloating = useLayoutStore((s) => s.closeFloating);
  const dockFloating = useLayoutStore((s) => s.dockFloating);
  const moveFloating = useLayoutStore((s) => s.moveFloating);
  const resizeFloating = useLayoutStore((s) => s.resizeFloating);
  const meta = PANEL_META[panel.kind];

  const onDragTitle = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startY = e.clientY;
    const originX = panel.x;
    const originY = panel.y;
    const onMove = (ev: PointerEvent) => {
      moveFloating(panel.id, Math.max(0, originX + (ev.clientX - startX)), Math.max(0, originY + (ev.clientY - startY)));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const onResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startY = e.clientY;
    const originW = panel.width;
    const originH = panel.height;
    const onMove = (ev: PointerEvent) => {
      resizeFloating(panel.id, originW + (ev.clientX - startX), originH + (ev.clientY - startY));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  // An empty/unmatched leaf id falls back to the first available leaf (or a
  // fresh root if the canvas is empty) inside dockFloating itself — no leaf
  // lookup needed here.
  const dockBack = () => dockFloating(panel.id, '');

  return (
    <div
      className="absolute z-20 flex flex-col overflow-hidden rounded-xl border border-line-strong bg-surface shadow-lg"
      style={{ left: panel.x, top: panel.y, width: panel.width, height: panel.height }}
    >
      <div
        onPointerDown={onDragTitle}
        className="flex h-8 shrink-0 cursor-grab items-center gap-1.5 border-b border-line bg-surface-active/60 px-2 active:cursor-grabbing"
      >
        <Icon name={meta.icon as IconName} size={12} />
        <span className="flex-1 truncate text-[11px] font-medium text-text">{meta.label}</span>
        <button
          onClick={dockBack}
          title="Dock back into the workspace"
          className="grid h-5 w-5 place-items-center rounded text-text-subtle transition-colors hover:bg-surface-hover hover:text-text"
        >
          <Icon name="panel" size={11} />
        </button>
        <button
          onClick={() => closeFloating(panel.id)}
          title="Close"
          className="grid h-5 w-5 place-items-center rounded text-text-subtle transition-colors hover:bg-surface-hover hover:text-text"
        >
          <Icon name="close" size={11} />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <PanelContent kind={panel.kind} />
      </div>
      <div onPointerDown={onResize} className="absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize" />
    </div>
  );
}
