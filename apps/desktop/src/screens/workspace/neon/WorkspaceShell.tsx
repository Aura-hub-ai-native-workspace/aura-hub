import type { ReactNode } from 'react';

/**
 * WorkspaceShell — the capability graph beside the conversation.
 *
 * The graph is how a person sees which tools and AI workers are connected,
 * so it is always on screen; there is no control to hide it. On a narrow
 * window the two panes stack and share the height.
 */
export function WorkspaceShell({ left, right, railOpen = true }: { left: ReactNode; right: ReactNode; railOpen?: boolean }) {
  return (
    <div className="neon-shell relative flex h-full min-h-0 flex-col overflow-hidden text-text">
      <div aria-hidden className="neon-grid pointer-events-none absolute inset-0" />
      <div aria-hidden className="aura-drift pointer-events-none absolute -left-24 -top-24 h-72 w-72 rounded-full bg-[radial-gradient(circle,rgba(124, 124, 124,0.22),transparent_65%)]" />
      <div aria-hidden className="aura-drift pointer-events-none absolute -right-20 top-10 h-80 w-80 rounded-full bg-[radial-gradient(circle,rgba(119, 119, 119,0.2),transparent_65%)]" />

      <div className={`relative mx-auto grid min-h-0 w-full max-w-[1760px] flex-1 overflow-hidden p-3 ${railOpen
        ? 'grid-cols-1 grid-rows-[minmax(0,2fr)_minmax(0,3fr)] gap-3 lg:grid-cols-[minmax(320px,28%)_minmax(0,1fr)] lg:grid-rows-1'
        : 'grid-cols-1 grid-rows-[minmax(0,1fr)]'}`}>
        <div
          data-testid="capability-rail"
          hidden={!railOpen}
          className={`${railOpen ? 'flex' : 'hidden'} min-h-0 flex-col overflow-hidden rounded-2xl border border-[rgba(152, 152, 152,0.28)] bg-[var(--ws-panel)] shadow-card`}
        >
          {left}
        </div>

        <div className="relative flex min-h-0 flex-col overflow-hidden rounded-xl border border-[rgba(152, 152, 152,0.28)] bg-[var(--ws-panel)] shadow-card">
          {right}
        </div>
      </div>
    </div>
  );
}
