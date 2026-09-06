import { useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { cn, spring } from '@aura/core';
import { Icon, type IconName } from '@aura/ui';
import { GlassCard, type GlassTint } from './GlassCard';
import { StatusPill, type StepStatus } from './StatusPill';

export interface TimelineStep {
  id: string;
  actor: string;
  detail: string;
  timestamp: string;
  status: StepStatus;
  tint: GlassTint;
  icon: IconName;
  body?: ReactNode;
  ctaLabel?: string;
  onCta?: () => void;
}

/**
 * TimelineStepCard — one execution row: avatar, actor, status text,
 * timestamp, pill, expandable body, optional CTA. Pure presentational.
 */
export function TimelineStepCard({ step }: { step: TimelineStep }) {
  const [open, setOpen] = useState(true);
  const expandable = !!step.body;

  return (
    <GlassCard tint={step.tint} className="p-4 transition-shadow duration-150">
      <div className="flex items-center gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-[rgba(125,146,255,0.3)] bg-[rgba(10,16,34,0.9)] text-text">
          <Icon name={step.icon} size={18} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold text-text">
            {step.actor}
            <span className="ml-2 truncate font-normal text-text-muted">{step.detail}</span>
          </span>
        </span>
        <span className="hidden shrink-0 text-[11px] tabular-nums text-text-subtle sm:block">
          {step.timestamp}
        </span>
        <StatusPill status={step.status} />
        {expandable && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label={open ? `Collapse ${step.actor} details` : `Expand ${step.actor} details`}
            className="neon-focus grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-[rgba(125,146,255,0.25)] text-text-muted transition-colors duration-150 hover:bg-white/5 hover:text-text"
          >
            <Icon name="chevron-down" size={14} className={cn('transition-transform duration-150', !open && '-rotate-90')} />
          </button>
        )}
      </div>

      <AnimatePresence initial={false}>
        {expandable && open && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={spring.snappy}
            className="overflow-hidden"
          >
            <div className="mt-3 flex flex-wrap items-start justify-between gap-3 rounded-md border border-white/5 bg-black/20 p-3">
              <div className="min-w-0 flex-1 text-[12px] leading-relaxed text-text-muted">
                {step.body}
              </div>
              {step.ctaLabel && (
                <button
                  type="button"
                  onClick={step.onCta}
                  className="neon-focus inline-flex shrink-0 items-center gap-1.5 rounded-md border border-[rgba(125,146,255,0.3)] bg-[rgba(77,124,255,0.12)] px-3 py-2 text-[12px] font-medium text-text transition-colors duration-150 hover:bg-[rgba(77,124,255,0.2)]"
                >
                  {step.ctaLabel}
                  <Icon name="arrow-right" size={13} />
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </GlassCard>
  );
}
