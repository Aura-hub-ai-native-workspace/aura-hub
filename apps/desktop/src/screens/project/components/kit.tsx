import { type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { cn, spring, staggerContainer, staggerItem, type StatusTone } from '@aura/core';
import { Card, Icon, type IconName } from '@aura/ui';

/**
 * Project section kit — small, reusable compositions built on top of the
 * (frozen) @aura/ui design system. Every project section is assembled
 * from these, so spacing, rhythm and motion stay identical across the
 * twelve environments a project contains.
 */

/** Section frame: consistent width + spacing + staggered reveal. */
export function SectionView({
  eyebrow,
  title,
  hint,
  actions,
  children,
  className,
}: {
  eyebrow?: string;
  title?: string;
  hint?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('mx-auto w-full max-w-[1360px] px-8 py-7 sm:px-10 lg:px-12', className)}>
      {(title || actions) && (
        <div className="mb-6 flex items-end justify-between gap-6">
          <div>
            {eyebrow && (
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-text-subtle">{eyebrow}</div>
            )}
            {title && <h2 className="text-[19px] font-semibold tracking-[-0.01em] text-text">{title}</h2>}
            {hint && <p className="mt-1 text-[13px] text-text-muted">{hint}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2.5">{actions}</div>}
        </div>
      )}
      <motion.div variants={staggerContainer} initial="initial" animate="animate">
        {children}
      </motion.div>
    </div>
  );
}

/** Staggered child wrapper. */
export function Block({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <motion.div variants={staggerItem} className={className}>
      {children}
    </motion.div>
  );
}

export const toneText: Record<StatusTone, string> = {
  positive: 'text-positive',
  attention: 'text-attention',
  critical: 'text-danger',
  info: 'text-accent',
  neutral: 'text-text-subtle',
};
export const toneBg: Record<StatusTone, string> = {
  positive: 'bg-positive',
  attention: 'bg-attention',
  critical: 'bg-danger',
  info: 'bg-accent',
  neutral: 'bg-text-subtle',
};

/** Compact KPI tile. */
export function StatTile({
  icon,
  label,
  value,
  sub,
  tone = 'neutral',
}: {
  icon: IconName;
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: StatusTone;
}) {
  return (
    <Card padding="md">
      <div className="flex items-start gap-3">
        <span className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-surface-active', toneText[tone])}>
          <Icon name={icon} size={18} />
        </span>
        <div className="min-w-0">
          <div className="text-[21px] font-semibold leading-none text-text">{value}</div>
          <div className="mt-1.5 text-[11.5px] text-text-subtle">{label}</div>
          {sub && <div className="mt-0.5 text-[11px] text-text-muted">{sub}</div>}
        </div>
      </div>
    </Card>
  );
}

/** Labelled meter bar. */
export function Meter({ label, value, tone = 'info' }: { label: string; value: number; tone?: StatusTone }) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between text-[12px]">
        <span className="text-text-muted">{label}</span>
        <span className="font-medium text-text tabular-nums">{value}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-active">
        <motion.div
          className={cn('h-full rounded-full', toneBg[tone])}
          initial={{ width: 0 }}
          animate={{ width: `${Math.max(0, Math.min(100, value))}%` }}
          transition={spring.gentle}
        />
      </div>
    </div>
  );
}

