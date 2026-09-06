import { useState, type ReactNode } from 'react';
import { cn } from '@aura/core';
import { Icon } from '@aura/ui';

/**
 * WorkspaceShell — neon dual-panel frame.
 * >=1024px: side-by-side (360px rail + timeline). <1024px: stacked with
 * collapsible control panel; composer stays reachable. Ambient background
 * is static gradients only (no large blur) for low-end GPUs.
 */
export function WorkspaceShell({ left, right }: { left: ReactNode; right: ReactNode }) {
  const [railOpen, setRailOpen] = useState(true);

  return (
    <div className="neon-shell relative flex h-full min-h-0 flex-col overflow-hidden text-text">
      <div aria-hidden className="neon-grid pointer-events-none absolute inset-0" />
      <div aria-hidden className="aura-drift pointer-events-none absolute -left-24 -top-24 h-72 w-72 rounded-full bg-[radial-gradient(circle,rgba(77,124,255,0.22),transparent_65%)]" />
      <div aria-hidden className="aura-drift pointer-events-none absolute -right-20 top-10 h-80 w-80 rounded-full bg-[radial-gradient(circle,rgba(122,92,255,0.2),transparent_65%)]" />

      <div className="relative mx-auto grid min-h-0 w-full max-w-[1500px] flex-1 grid-cols-1 gap-3 overflow-hidden p-3 lg:grid-cols-[360px_minmax(0,1fr)] lg:gap-4 lg:p-4">
        {/* Mobile/tablet rail toggle */}
        <div className="flex items-center justify-between lg:hidden">
          <span className="text-[12px] font-semibold uppercase tracking-widest text-text-subtle">
            Control rail
          </span>
          <button
            type="button"
            onClick={() => setRailOpen((v) => !v)}
            aria-expanded={railOpen}
            className="neon-focus inline-flex items-center gap-1.5 rounded-lg border border-[rgba(125,146,255,0.3)] px-2.5 py-1.5 text-[12px] text-text-muted"
          >
            <Icon name={railOpen ? 'chevron-down' : 'panel'} size={14} />
            {railOpen ? 'Hide controls' : 'Show controls'}
          </button>
        </div>

        <div
          className={cn(
            'min-h-0 overflow-y-auto rounded-xl border border-[rgba(125,146,255,0.28)] bg-[rgba(9,13,26,0.82)] p-3 shadow-card',
            !railOpen && 'hidden lg:block',
            'lg:block',
          )}
        >
          {left}
        </div>

        <div className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-[rgba(125,146,255,0.28)] bg-[rgba(9,13,26,0.82)] shadow-card">
          {right}
        </div>
      </div>
    </div>
  );
}
