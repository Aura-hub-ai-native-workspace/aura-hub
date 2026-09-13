import { useState, type ReactNode } from 'react';
import { cn } from '@aura/core';
import { Icon } from '@aura/ui';

/**
 * WorkspaceShell — conversation, with the capability graph beside it.
 *
 * The two panes are not peers. The conversation is the content and
 * always holds the screen; the graph is support, and it collapses at
 * every width rather than only on a narrow one. That asymmetry is the
 * point: a person who just wants to talk should be able to put the
 * machinery away, and a person debugging an orchestration should be
 * able to bring it back without leaving the conversation they are
 * debugging.
 *
 * Collapsing hides the rail; it never unmounts the conversation, so a
 * run in flight keeps streaming either way. Ambient background is
 * static gradients only (no large blur) for low-end GPUs.
 */
export function WorkspaceShell({ left, right }: { left: ReactNode; right: ReactNode }) {
  const [railOpen, setRailOpen] = useState(true);

  return (
    <div className="neon-shell relative flex h-full min-h-0 flex-col overflow-hidden text-text">
      <div aria-hidden className="neon-grid pointer-events-none absolute inset-0" />
      <div aria-hidden className="aura-drift pointer-events-none absolute -left-24 -top-24 h-72 w-72 rounded-full bg-[radial-gradient(circle,rgba(77,124,255,0.22),transparent_65%)]" />
      <div aria-hidden className="aura-drift pointer-events-none absolute -right-20 top-10 h-80 w-80 rounded-full bg-[radial-gradient(circle,rgba(122,92,255,0.2),transparent_65%)]" />

      <div
        className={cn(
          'relative mx-auto grid min-h-0 w-full max-w-[1760px] flex-1 grid-cols-1 gap-3 overflow-hidden p-3 lg:gap-4 lg:p-4',
          railOpen
            ? 'lg:grid-cols-[minmax(320px,26%)_minmax(0,1fr)]'
            : 'lg:grid-cols-[minmax(0,1fr)]',
        )}
      >
        {railOpen && (
          <div
            data-testid="capability-rail"
            className="min-h-0 overflow-y-auto rounded-2xl border border-[rgba(125,146,255,0.28)] bg-[rgba(9,13,26,0.82)] p-4 shadow-card"
          >
            {left}
          </div>
        )}

        <div className="relative flex min-h-0 flex-col overflow-hidden rounded-xl border border-[rgba(125,146,255,0.28)] bg-[rgba(9,13,26,0.82)] shadow-card">
          {/* One control, present at every width. The conversation below
              it is unaffected either way. */}
          <button
            type="button"
            onClick={() => setRailOpen((v) => !v)}
            aria-expanded={railOpen}
            data-testid="rail-toggle"
            title={railOpen ? 'Hide the capability graph' : 'Show the capability graph'}
            className="neon-focus absolute right-3 top-3 z-10 inline-flex items-center gap-1.5 rounded-lg border border-[rgba(125,146,255,0.3)] bg-[rgba(9,13,26,0.9)] px-2.5 py-1.5 text-[11.5px] text-text-subtle transition-colors hover:text-text"
          >
            <Icon name="panel" size={13} />
            {railOpen ? 'Hide tools' : 'Show tools'}
          </button>
          {right}
        </div>
      </div>
    </div>
  );
}
