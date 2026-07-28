import { forwardRef, type ReactNode } from 'react';
import { motion, type HTMLMotionProps } from 'framer-motion';
import { cn, spring } from '@aura/core';

export interface CardProps extends Omit<HTMLMotionProps<'div'>, 'ref' | 'title'> {
  /** Adds a hover lift + pointer affordance. */
  interactive?: boolean;
  /** Frosted-glass treatment (use sparingly — over imagery / accent). */
  glass?: boolean;
  padding?: 'none' | 'sm' | 'md' | 'lg';
}

const PADDING = { none: '', sm: 'p-4', md: 'p-5', lg: 'p-7' } as const;

export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { interactive, glass, padding = 'md', className, children, ...rest },
  ref,
) {
  return (
    <motion.div
      ref={ref}
      whileHover={interactive ? { y: -3 } : undefined}
      transition={spring.smooth}
      className={cn(
        'rounded-2xl border border-line',
        glass
          ? 'bg-surface/60 backdrop-blur-xl backdrop-saturate-150'
          : 'bg-surface shadow-sm',
        interactive && 'cursor-pointer hover:shadow-md hover:border-line-strong transition-[box-shadow,border-color]',
        PADDING[padding],
        className,
      )}
      {...rest}
    >
      {children}
    </motion.div>
  );
});

/** Optional structured header for a Card. */
export function CardHeader({
  title,
  subtitle,
  action,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-start justify-between gap-4', className)}>
      <div className="min-w-0">
        <h3 className="text-[14px] font-semibold text-text truncate">{title}</h3>
        {subtitle && <p className="mt-0.5 text-[12px] text-text-muted">{subtitle}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
