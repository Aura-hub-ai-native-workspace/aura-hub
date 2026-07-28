import { motion } from 'framer-motion';
import { cn, spring } from '@aura/core';
import type { StatusTone } from '@aura/core';

const TONE_BAR: Record<StatusTone, string> = {
  positive: 'bg-positive',
  attention: 'bg-attention',
  critical: 'bg-danger',
  info: 'bg-accent',
  neutral: 'bg-text-subtle',
};

export interface ProgressProps {
  value: number; // 0–100
  tone?: StatusTone;
  className?: string;
  showLabel?: boolean;
}

/** Linear progress — spring-animated fill. */
export function Progress({ value, tone = 'info', className, showLabel }: ProgressProps) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-active">
        <motion.div
          className={cn('h-full rounded-full', TONE_BAR[tone])}
          initial={{ width: 0 }}
          animate={{ width: `${clamped}%` }}
          transition={spring.gentle}
        />
      </div>
      {showLabel && (
        <span className="w-9 text-right text-[11px] tabular-nums text-text-muted">{Math.round(clamped)}%</span>
      )}
    </div>
  );
}

export interface RingProps {
  value: number;
  size?: number;
  stroke?: number;
  tone?: StatusTone;
  className?: string;
  children?: React.ReactNode;
}

/** Circular progress ring — used on project overview cards. */
export function Ring({ value, size = 56, stroke = 5, tone = 'info', className, children }: RingProps) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, value));
  const strokeColor = {
    positive: 'stroke-positive',
    attention: 'stroke-attention',
    critical: 'stroke-danger',
    info: 'stroke-accent',
    neutral: 'stroke-text-subtle',
  }[tone];

  return (
    <div className={cn('relative inline-grid place-items-center', className)} style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} className="fill-none stroke-surface-active" />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          strokeWidth={stroke}
          strokeLinecap="round"
          className={cn('fill-none', strokeColor)}
          strokeDasharray={c}
          initial={{ strokeDashoffset: c }}
          animate={{ strokeDashoffset: c - (clamped / 100) * c }}
          transition={spring.gentle}
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center">{children}</div>
    </div>
  );
}
