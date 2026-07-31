import { useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { cn } from '@aura/core';
import { Icon, IconButton } from '@aura/ui';
import { useEditorStore } from './editorStore';
import type { BottomPanelTab } from './editorTypes';

const TABS: { key: BottomPanelTab; label: string }[] = [
  { key: 'terminal', label: 'Terminal' },
  { key: 'problems', label: 'Problems' },
  { key: 'output', label: 'Output' },
  { key: 'tasks', label: 'Tasks' },
];

/** Bottom Panel — Terminal, Problems, Output, Tasks. Only Terminal has a real (placeholder) surface today. */
export function BottomPanel() {
  const open = useEditorStore((s) => s.bottomPanelOpen);
  const height = useEditorStore((s) => s.bottomPanelHeight);
  const tab = useEditorStore((s) => s.bottomPanelTab);
  const setTab = useEditorStore((s) => s.setBottomPanelTab);
  const toggle = useEditorStore((s) => s.toggleBottomPanel);
  const setHeight = useEditorStore((s) => s.setBottomPanelHeight);
  const dragState = useRef<{ startY: number; startHeight: number } | null>(null);

  function onDragStart(e: ReactPointerEvent<HTMLDivElement>) {
    dragState.current = { startY: e.clientY, startHeight: height };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function onDragMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!dragState.current) return;
    setHeight(dragState.current.startHeight + (dragState.current.startY - e.clientY));
  }
  function onDragEnd() {
    dragState.current = null;
  }

  if (!open) {
    return (
      <div className="flex h-8 shrink-0 items-center border-t border-line bg-surface/40 px-3">
        <button onClick={toggle} className="flex items-center gap-1.5 text-[11.5px] font-medium text-text-muted transition-colors hover:text-text">
          <Icon name="terminal" size={13} />
          Terminal
        </button>
      </div>
    );
  }

  return (
    <div className="flex shrink-0 flex-col border-t border-line bg-surface/40" style={{ height }}>
      <div onPointerDown={onDragStart} onPointerMove={onDragMove} onPointerUp={onDragEnd} className="h-1 shrink-0 cursor-row-resize" />
      <div className="flex h-8 shrink-0 items-center justify-between border-b border-line px-2">
        <div className="flex items-center gap-1">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                'rounded-md px-2.5 py-1 text-[11.5px] font-medium transition-colors',
                tab === t.key ? 'bg-surface-active text-text' : 'text-text-muted hover:text-text',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        <IconButton icon="close" label="Close panel" size="sm" onClick={toggle} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {tab === 'terminal' ? <TerminalPlaceholder /> : <ComingSoon label={TABS.find((t) => t.key === tab)?.label ?? ''} />}
      </div>
    </div>
  );
}

function TerminalPlaceholder() {
  return (
    <div className="h-full rounded-lg bg-canvas/60 p-3 font-mono text-[12px] leading-relaxed text-text-muted">
      <p>
        <span className="text-positive">➜</span> <span className="text-accent">aura-hub</span> <span className="text-text-subtle">git:(main)</span>
      </p>
      <p className="mt-1 text-text-subtle">A real shell attaches here once the terminal runtime lands.</p>
      <p className="mt-2 flex items-center gap-1">
        <span className="text-positive">➜</span>
        <span className="h-3.5 w-1.5 animate-pulse bg-text-subtle" />
      </p>
    </div>
  );
}

function ComingSoon({ label }: { label: string }) {
  return <p className="py-6 text-center text-[12px] text-text-subtle">{label} isn't wired up yet.</p>;
}
