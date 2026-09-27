/**
 * Agent Workspace v2 — right panel: the agent execution timeline.
 * =====================================================================
 * This panel receives no user input. It renders the `V2Timeline`
 * produced by `buildV2Timeline` from REAL run records, with:
 *
 *   • an empty state that says what the panel is for (no fake timeline)
 *   • an objective header when the backend recorded one
 *   • the live timeline — AURA cards bracket the worker cards (spec §6)
 *   • an in-flight indicator only while the backend says work is moving
 *   • an honest "live updates paused" line when the stream reconnects
 *
 * Scrolling is internal (fixed-viewport canvas, see ScreenRouter).
 */
import { useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { cn, spring } from '@aura/core';
import { Icon } from '@aura/ui';
import { V2StatusPill } from './StatusPillV2';
import { V2TimelineCard } from './TimelineCard';
import type { V2Timeline } from './types';

export function V2TimelinePanel({
  timeline,
  agentUp,
  streamPaused,
}: {
  timeline: V2Timeline;
  /** Liveness of the Central Agent service. null = not yet asked. */
  agentUp: boolean | null;
  /** True when the SSE stream dropped and is reconnecting. */
  streamPaused: boolean;
}) {
  const { cards, objective, inFlight } = timeline;
  const scrollRef = useRef<HTMLOListElement>(null);
  const lastCardId = cards[cards.length - 1]?.id;

  // Follow-along while work is moving; never yank the view when the
  // user has scrolled to inspect an earlier card.
  useEffect(() => {
    if (!inFlight) return;
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [lastCardId, inFlight]); // eslint-disable-line react-hooks/exhaustive-deps

  const idle = cards.length === 0;

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-testid="v2-timeline-panel"
      aria-label="AURA agent execution timeline"
    >
      {/* Panel header: identity of what this panel is */}
      <div className="flex shrink-0 items-center justify-between gap-3 px-5 pt-4">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-text">
            Agent Workspace
          </h2>
          <p className="mt-0.5 truncate text-[11px] text-text-subtle">
            Live orchestration — AURA coordinates the workers; they never talk to you directly.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {streamPaused && (
            <span
              className="inline-flex items-center gap-1.5 rounded-full border border-[rgba(255,181,71,0.5)] bg-[rgba(255,181,71,0.1)] px-2.5 py-1 text-[10.5px] font-semibold text-ws-warn"
              role="status"
              data-testid="v2-stream-paused"
            >
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-neon-warning aura-breathe" />
              Live updates paused
            </span>
          )}
          {agentUp === false && (
            <span
              className="inline-flex items-center gap-1.5 rounded-full border border-[rgba(255,93,122,0.5)] bg-[rgba(255,93,122,0.1)] px-2.5 py-1 text-[10.5px] font-semibold text-ws-bad"
              role="status"
            >
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-neon-danger" />
              Central Agent offline
            </span>
          )}
          {inFlight && (
            <span
              className="inline-flex items-center gap-1.5 rounded-full border border-[rgba(32,211,255,0.5)] bg-[rgba(32,211,255,0.1)] px-2.5 py-1 text-[10.5px] font-semibold text-ws-ink-cyan"
              role="status"
              data-testid="v2-in-flight"
            >
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-neon-cyan aura-breathe" />
              Working
            </span>
          )}
        </div>
      </div>

      {/* Objective */}
      {objective && !idle && (
        <div className="shrink-0 px-5 pt-3" data-testid="v2-objective">
          <div className="rounded-xl border border-[rgba(125,146,255,0.22)] bg-ws-soft px-4 py-2.5">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-text-subtle">
              Objective
            </p>
            <p className="mt-0.5 truncate text-[12.5px] text-text-muted" title={objective}>
              {objective}
            </p>
          </div>
        </div>
      )}

      {/* Body */}
      <ol
        ref={scrollRef}
        className="m-0 flex-1 space-y-3 overflow-y-auto p-5"
        aria-label="Execution timeline"
        data-testid="v2-timeline"
      >
        {idle ? (
          <li className="flex h-full min-h-[260px] flex-col items-center justify-center text-center">
            <span
              aria-hidden
              className="grid h-16 w-16 place-items-center rounded-2xl border border-[rgba(122,92,255,0.45)] bg-[rgba(122,92,255,0.12)] text-ws-ink-violet shadow-glow-violet"
            >
              <Icon name="spark" size={30} />
            </span>
            <h3 className="mt-4 text-[19px] font-semibold tracking-[-0.01em] text-text">
              Ready to build.
            </h3>
            <p className="mt-2 max-w-[440px] text-[13px] leading-relaxed text-text-muted">
              Tell AURA what you want to create, change, debug or review in the
              composer on the left. Your request is planned, delegated to the
              workers it needs, supervised while it runs, and verified before
              anything is called done — and you will see every step here.
            </p>
            {agentUp === false && (
              <p className="mt-4 max-w-[420px] text-[12px] leading-relaxed text-ws-bad">
                The Central Agent service is not reachable right now. AURA cannot
                plan or run requests until it is back up.
              </p>
            )}
          </li>
        ) : (
          <AnimatePresence initial={false}>
            {cards.map((card) => (
              <motion.li
                key={card.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={spring.snappy}
              >
                {/* Timeline spine dot, echoing the reference's vertical rhythm */}
                <div
                  aria-hidden
                  className={cn(
                    'mb-1.5 flex items-center gap-2 px-1',
                  )}
                >
                  <span
                    className={cn(
                      'h-1.5 w-1.5 rounded-full',
                      card.status === 'completed' ? 'bg-neon-success'
                        : card.status === 'failed' ? 'bg-neon-danger'
                        : card.status === 'waiting-for-approval' ? 'bg-neon-warning'
                        : card.actor === 'aura' ? 'bg-neon-violet'
                          : 'bg-neon-cyan',
                      inFlight && !['completed', 'failed', 'cancelled'].includes(card.status) && 'aura-breathe',
                    )}
                  />
                  <span className="h-px flex-1 bg-gradient-to-r from-[rgba(125,146,255,0.22)] to-transparent" />
                </div>
                <V2TimelineCard card={card} />
              </motion.li>
            ))}
          </AnimatePresence>
        )}
      </ol>

      {/* Legend: the 11 states, once, quietly. Collapsible by the
          eye: it is the spec's vocabulary, useful for the first
          seconds, not a repeated header. */}
      <div
        className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-[rgba(125,146,255,0.16)] px-5 py-2.5"
        data-testid="v2-legend"
      >
        {(['planning', 'queued', 'analyzing', 'coding', 'researching', 'executing', 'waiting-for-approval', 'verifying', 'completed', 'failed', 'cancelled'] as const).map((s) => (
          <V2StatusPill key={s} status={s} live={false} />
        ))}
      </div>
    </div>
  );
}
