/**
 * Agent Workspace v2 — one timeline card.
 * =====================================================================
 * Renders a single `V2Card` (see `timelineModel.ts`) with:
 *   • actor identity + icon
 *   • task/action line
 *   • status pill (spec §5 vocabulary)
 *   • timestamp (the backend's own `at`, when present)
 *   • description / failure detail
 *   • agent-to-agent exchange (spec §6)
 *   • generated artifacts
 *   • governed tool calls
 *   • verification evidence
 *   • expandable execution facts
 *
 * Presentational only: it renders whatever fields the model gave it and
 * shows nothing the model did not record. `detailsOpen` is internal UI
 * state; every other value comes from the card.
 */
import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { cn, spring } from '@aura/core';
import { Icon, type IconName } from '@aura/ui';
import { V2StatusPill } from './StatusPillV2';
import type { V2Card, V2ActorKind } from './types';

const ACTOR: Record<V2ActorKind, { icon: IconName; tile: string; label: string }> = {
  aura: {
    icon: 'spark',
    tile: 'border-[rgba(122,92,255,0.6)] bg-[rgba(122,92,255,0.16)] text-neon-violet shadow-glow-violet',
    label: 'Central',
  },
  worker: {
    icon: 'cpu',
    tile: 'border-[rgba(77,124,255,0.45)] bg-[rgba(13,19,38,0.7)] text-neon-blue',
    label: 'Worker',
  },
  tool: {
    icon: 'command',
    tile: 'border-[rgba(32,211,255,0.45)] bg-[rgba(13,19,38,0.7)] text-neon-cyan',
    label: 'Tools',
  },
};

/** Backend `at` → local clock. Absent stays absent (never invented). */
function clock(at?: string | null): string | null {
  if (!at) return null;
  const d = new Date(at);
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function Section({ title, icon, children, testId }: {
  title: string;
  icon: IconName;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <div
      className="mt-3 rounded-lg border border-[rgba(125,146,255,0.18)] bg-[rgba(13,19,38,0.55)] px-3 py-2.5"
      data-testid={testId}
    >
      <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-subtle">
        <Icon name={icon} size={12} />
        {title}
      </p>
      {children}
    </div>
  );
}

export function V2TimelineCard({ card }: { card: V2Card }) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const actor = ACTOR[card.actor];
  const time = clock(card.at);
  const hasFacts = card.facts.filter(Boolean).length > 0;
  const hasTools = card.tools.length > 0;
  const hasArtifacts = card.artifacts.length > 0;
  const hasVerification = card.verification != null;
  const hasExchange = card.exchange != null;
  const denied = card.tools.filter((t) => t.decision === 'DENY').length;

  return (
    <div
      data-testid="v2-card"
      data-actor={card.actor}
      data-status={card.status}
      className={cn(
        'rounded-2xl border bg-gradient-to-b from-[rgba(16,24,43,0.75)] to-[rgba(9,13,26,0.55)] p-4 shadow-card',
        card.status === 'failed'
          ? 'border-[rgba(255,93,122,0.42)]'
          : card.status === 'waiting-for-approval'
            ? 'border-[rgba(255,181,71,0.4)]'
            : card.actor === 'aura'
              ? 'border-[rgba(122,92,255,0.32)]'
              : 'border-[rgba(125,146,255,0.24)]',
      )}
    >
      {/* Header: identity + task + timestamp + status */}
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className={cn('grid h-11 w-11 shrink-0 place-items-center rounded-xl border', actor.tile)}
        >
          <Icon name={actor.icon} size={20} />
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[13.5px] font-semibold text-text">{card.name}</span>
            <span className="rounded border border-line px-1.5 py-0.5 text-[9.5px] font-medium uppercase tracking-wide text-text-subtle">
              {actor.label}
            </span>
            {time && (
              <span className="text-[11px] tabular-nums text-text-subtle">{time}</span>
            )}
          </span>
          <span className="mt-0.5 block text-[12.5px] leading-snug text-text-muted">
            {card.action}
          </span>
        </span>

        <V2StatusPill status={card.status} />
      </div>

      {/* Description / failure detail */}
      {card.detail && (
        <p
          className={cn(
            'mt-2 whitespace-pre-wrap rounded-lg px-3 py-2 text-[12px] leading-relaxed',
            card.status === 'failed'
              ? 'border border-[rgba(255,93,122,0.3)] bg-[rgba(255,93,122,0.08)] text-neon-danger'
              : 'text-text-subtle',
          )}
          data-testid="v2-card-detail"
        >
          {card.detail}
        </p>
      )}

      {/* Agent-to-agent exchange (spec §6) */}
      {hasExchange && (
        <div
          className="mt-3 rounded-lg border border-[rgba(125,146,255,0.18)] bg-[rgba(13,19,38,0.55)] px-3 py-2.5"
          data-testid="v2-exchange"
        >
          <div className="space-y-2 text-[11.5px] leading-relaxed">
            <div className="flex gap-2">
              <span className="shrink-0 font-semibold text-neon-violet">{card.exchange!.from}</span>
              <span className="min-w-0 text-text-muted">{card.exchange!.text}</span>
            </div>
            {card.exchange!.reply && (
              <div className="flex gap-2 border-l border-[rgba(125,146,255,0.25)] pl-3">
                <span className="shrink-0 font-semibold text-neon-blue">{card.exchange!.from}</span>
                <span className="min-w-0 text-text-subtle">{card.exchange!.reply.text}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Artifacts */}
      {hasArtifacts && (
        <Section title="Generated artifacts" icon="file" testId="v2-artifacts">
          <ul className="space-y-1">
            {card.artifacts.map((a) => (
              <li key={a} className="flex items-center gap-1.5 truncate font-mono text-[11px] text-text-muted">
                <Icon name="file" size={11} className="text-text-subtle" />
                <span className="truncate">{a}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* Tool calls */}
      {hasTools && (
        <Section
          title={`Tool calls · ${card.tools.length}${denied > 0 ? ` · ${denied} denied` : ''}`}
          icon="command"
          testId="v2-tools"
        >
          <ul className="space-y-1">
            {card.tools.map((t) => (
              <li key={t.key} className="flex items-center gap-2 font-mono text-[11px]">
                <span
                  className={cn(
                    'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase',
                    t.decision === 'DENY'
                      ? 'bg-[rgba(255,93,122,0.15)] text-neon-danger'
                      : t.decision === 'ALLOW'
                        ? 'bg-[rgba(31,211,138,0.12)] text-neon-success'
                        : 'bg-[rgba(13,19,38,0.55)] text-text-muted',
                  )}
                >
                  {t.decision || '—'}
                </span>
                <span className="shrink-0 text-text-muted">{t.tool || t.actionType}</span>
                <span className="min-w-0 truncate text-text-subtle">{t.target}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* Verification evidence */}
      {hasVerification && (
        <Section
          title="Verification evidence"
          icon={card.verification!.state === 'passed' ? 'check' : 'close'}
          testId="v2-verification"
        >
          <p className="text-[11.5px] leading-relaxed text-text-muted">
            <span
              className={cn(
                'mr-1 font-semibold',
                card.verification!.state === 'passed' ? 'text-neon-success' : 'text-neon-danger',
              )}
            >
              {card.verification!.state === 'passed' ? 'Verified' : 'Not verified'}
            </span>
            {card.verification!.detail || (
              'Recorded by the backend as the task verification outcome.'
            )}
          </p>
        </Section>
      )}

      {/* Expandable execution details */}
      {hasFacts && (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setDetailsOpen((v) => !v)}
            aria-expanded={detailsOpen}
            data-testid="v2-card-details-toggle"
            className="neon-focus inline-flex items-center gap-1 rounded text-[10.5px] font-semibold uppercase tracking-wide text-text-subtle transition-colors hover:text-text"
          >
            <Icon name={detailsOpen ? 'chevron-down' : 'chevron-right'} size={11} />
            {detailsOpen ? 'Hide execution details' : 'Execution details'}
          </button>

          <AnimatePresence initial={false}>
            {detailsOpen && (
              <motion.ul
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={spring.snappy}
                className="overflow-hidden"
              >
                <div className="mt-2 space-y-1 border-l border-[rgba(125,146,255,0.25)] pl-3">
                  {card.facts.filter(Boolean).map((f) => (
                    <li key={f} className="truncate font-mono text-[11px] text-text-subtle">
                      {f}
                    </li>
                  ))}
                </div>
              </motion.ul>
            )}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}
