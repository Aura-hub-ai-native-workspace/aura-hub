import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { cn } from '@aura/core';
import { Icon, IconButton } from '@aura/ui';
import { useEditorStore } from './editorStore';
import type { BottomPanelTab } from './editorTypes';
import { ProjectTerminal } from './ProjectTerminal';

const TABS: { key: BottomPanelTab; label: string }[] = [
  { key: 'terminal', label: 'Terminal' },
  { key: 'problems', label: 'Problems' },
  { key: 'output', label: 'Output' },
  { key: 'tasks', label: 'Tasks' },
];

/**
 * Bottom Panel — Terminal, Problems, Output, Tasks. Terminal is the user's real
 * shell in the project folder; the others are not wired up yet.
 *
 * The terminal is started the first time the panel opens on it and then kept
 * mounted — hidden while the panel is collapsed or another tab shows — so a
 * running dev server or build is not killed by tidying the layout.
 */
export function BottomPanel({ cwd }: { cwd?: string }) {
  const open = useEditorStore((s) => s.bottomPanelOpen);
  const height = useEditorStore((s) => s.bottomPanelHeight);
  const tab = useEditorStore((s) => s.bottomPanelTab);
  const setTab = useEditorStore((s) => s.setBottomPanelTab);
  const toggle = useEditorStore((s) => s.toggleBottomPanel);
  const setHeight = useEditorStore((s) => s.setBottomPanelHeight);
  const dragState = useRef<{ startY: number; startHeight: number } | null>(null);
  const [terminalStarted, setTerminalStarted] = useState(false);

  useEffect(() => {
    if (open && tab === 'terminal') setTerminalStarted(true);
  }, [open, tab]);

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

  const terminalVisible = open && tab === 'terminal';

  return (
    <div className="flex shrink-0 flex-col border-t border-line bg-surface/40" style={open ? { height } : undefined}>
      {!open && (
        <div className="flex h-8 shrink-0 items-center px-3">
          <button onClick={toggle} className="flex items-center gap-1.5 text-[11.5px] font-medium text-text-muted transition-colors hover:text-text">
            <Icon name="terminal" size={13} />
            Terminal
          </button>
        </div>
      )}
      {open && (
        <>
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
        </>
      )}
      <div className={cn('min-h-0 flex-1 p-2', !terminalVisible && 'hidden')}>
        {terminalStarted && (cwd
          ? <ProjectTerminal cwd={cwd} visible={terminalVisible} />
          : <p className="py-6 text-center text-[12px] text-text-subtle">This project has no folder on this machine, so there is nowhere to open a terminal.</p>)}
      </div>
      {open && tab !== 'terminal' && (
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <ComingSoon label={TABS.find((t) => t.key === tab)?.label ?? ''} />
        </div>
      )}
    </div>
  );
}

function ComingSoon({ label }: { label: string }) {
  return <p className="py-6 text-center text-[12px] text-text-subtle">{label} isn't wired up yet.</p>;
}
