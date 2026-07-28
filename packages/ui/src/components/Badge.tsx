import { cn } from '@aura/core';
import type { StatusTone } from '@aura/core';
import type { ReactNode } from 'react';

const TONES: Record<StatusTone, string> = {
  positive: 'bg-positive/10 text-positive dark:bg-positive/15',
  attention: 'bg-attention/12 text-attention dark:bg-attention/15',
  critical: 'bg-danger/10 text-danger dark:bg-danger/15',
  info: 'bg-accent-50 text-accent-700 dark:bg-accent/15 dark:text-accent-200',
  neutral: 'bg-surface-active text-text-muted',
};

export interface BadgeProps {
  tone?: StatusTone;
  dot?: boolean;
  children: ReactNode;
  className?: string;
}

export function Badge({ tone = 'neutral', dot, children, className }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium tracking-wide',
        TONES[tone],
        className,
      )}
    >
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}
