/**
 * GapPanel — a missing tool, answered instead of announced.
 * ==================================================================
 * The old failure mode was "tool not found", which puts the research
 * back on the user. Here every gap arrives with a ranked shortlist and
 * the reasoning behind the ranking, so the next step is a click rather
 * than an afternoon.
 *
 * The reasoning is shown, not summarized into a confidence score. A
 * recommendation you can audit is advice; one you cannot is just an
 * opinion delivered with a progress bar.
 */

import { motion } from 'framer-motion';
import { cn, spring } from '@aura/core';
import { Icon } from '@aura/ui';
import { describeCapability, nextBestConnection, type CapabilityGap } from '@aura/connected-environment';

export function GapPanel({
  gaps,
  busy,
  onConnect,
  onInspect,
}: {
  gaps: CapabilityGap[];
  busy: string[];
  onConnect: (id: string) => void;
  onInspect: (id: string) => void;
}) {
  if (!gaps.length) {
    return (
      <div className="rounded-2xl border border-positive/30 bg-positive/5 p-3">
        <div className="flex items-center gap-2">
          <Icon name="check" size={14} className="text-positive" />
          <p className="text-[12px] font-medium text-text">Every step has somewhere to run.</p>
        </div>
        <p className="mt-1 text-[11.5px] leading-relaxed text-text-muted">
          The connected environment covers everything this plan needs.
        </p>
      </div>
    );
  }

  // One prominent suggestion, not a wall of every gap at once: the single
  // connection that unblocks the most work.
  const best = nextBestConnection(gaps);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Icon name="spark" size={13} className="text-accent" />
        <h3 className="text-[12px] font-semibold text-text">
          {gaps.length === 1 ? 'One capability to connect' : `${gaps.length} capabilities to connect`}
        </h3>
      </div>

      {best && (
        <div className="rounded-2xl border border-accent/40 bg-accent/5 p-3">
          <p className="text-[12px] leading-relaxed text-text">
            I found <span className="font-semibold">{best.candidate.entry.name}</span> as the best way to{' '}
            {describeCapability(best.gap.capability).toLowerCase()}. Connect it and{' '}
            {best.gap.taskIds.length === 1 ? 'a step' : `${best.gap.taskIds.length} steps`} unblock immediately.
          </p>
          <button
            onClick={() => onConnect(best.candidate.entry.id)}
            disabled={busy.includes(best.candidate.entry.id)}
            className="mt-2 flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[11.5px] font-medium text-white transition-colors hover:bg-accent-600 disabled:opacity-60"
          >
            <Icon name="link" size={12} />
            {busy.includes(best.candidate.entry.id) ? 'Connecting…' : `Connect ${best.candidate.entry.name}`}
          </button>
        </div>
      )}

      {gaps.map((gap) => (
        <motion.div
          key={gap.capability}
          layout
          transition={spring.smooth}
          className="rounded-2xl border border-line bg-surface p-3"
        >
          <div className="flex items-start gap-2">
            <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-lg bg-surface-active text-text-subtle">
              <Icon name="link" size={12} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[12px] font-semibold text-text">{gap.capability}</p>
              <p className="text-[11px] text-text-subtle">{describeCapability(gap.capability)}</p>
            </div>
            <span className="shrink-0 rounded-md bg-surface-active px-1.5 py-0.5 text-[10px] tabular-nums text-text-muted">
              {gap.taskIds.length} {gap.taskIds.length === 1 ? 'step' : 'steps'}
            </span>
          </div>

          <p className="mt-2 text-[11.5px] leading-relaxed text-text">{gap.message}</p>

          <div className="mt-2.5 space-y-1.5">
            {gap.candidates.slice(0, 3).map((candidate, index) => (
              <div
                key={candidate.entry.id}
                className={cn(
                  'rounded-xl border p-2',
                  index === 0 ? 'border-accent/30 bg-accent/5' : 'border-line bg-surface-active/40',
                )}
              >
                <div className="flex items-center gap-2">
                  <span className="truncate text-[11.5px] font-medium text-text">{candidate.entry.name}</span>
                  {index === 0 && (
                    <span className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide text-accent">
                      Best fit
                    </span>
                  )}
                  <span className="ml-auto shrink-0 text-[10px] tabular-nums text-text-subtle">{candidate.score}</span>
                </div>

                <ul className="mt-1 space-y-0.5">
                  {candidate.rationale.map((reason) => (
                    <li key={reason} className="flex items-start gap-1">
                      <Icon name="dot" size={9} className="mt-1 shrink-0 text-text-subtle" />
                      <span className="text-[10.5px] leading-snug text-text-muted">{reason}</span>
                    </li>
                  ))}
                </ul>

                <div className="mt-1.5 flex items-center gap-1.5">
                  {candidate.connectable ? (
                    <button
                      onClick={() => onConnect(candidate.entry.id)}
                      disabled={busy.includes(candidate.entry.id)}
                      className="rounded-lg bg-accent px-2.5 py-1 text-[10.5px] font-medium text-white transition-colors hover:bg-accent-600 disabled:opacity-60"
                    >
                      {busy.includes(candidate.entry.id) ? 'Checking…' : 'Connect'}
                    </button>
                  ) : (
                    <a
                      href={candidate.entry.homepage}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-[10.5px] font-medium text-text-muted transition-colors hover:border-line-strong hover:text-text"
                    >
                      <Icon name="link" size={10} />
                      Open site
                    </a>
                  )}
                  <button
                    onClick={() => onInspect(candidate.entry.id)}
                    className="rounded-lg border border-line px-2 py-1 text-[10.5px] font-medium text-text-muted transition-colors hover:border-line-strong hover:text-text"
                  >
                    Details
                  </button>
                </div>
              </div>
            ))}
          </div>
        </motion.div>
      ))}
    </div>
  );
}
