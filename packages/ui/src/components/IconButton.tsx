import { forwardRef } from 'react';
import { motion, type HTMLMotionProps } from 'framer-motion';
import { cn, spring } from '@aura/core';
import { Icon, type IconName } from '../icons/Icon';

export interface IconButtonProps extends Omit<HTMLMotionProps<'button'>, 'ref'> {
  icon: IconName;
  label: string;
  size?: 'sm' | 'md' | 'lg';
  active?: boolean;
}

const SIZES = {
  sm: 'h-7 w-7 rounded-lg',
  md: 'h-9 w-9 rounded-xl',
  lg: 'h-10 w-10 rounded-xl',
} as const;

/** Square, icon-only affordance. `label` is required for a11y. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, size = 'md', active, className, ...rest },
  ref,
) {
  return (
    <motion.button
      ref={ref}
      aria-label={label}
      title={label}
      whileTap={{ scale: 0.92 }}
      transition={spring.snappy}
      className={cn(
        'inline-flex items-center justify-center outline-none transition-colors duration-150',
        'text-text-muted hover:text-text hover:bg-surface-hover',
        'focus-visible:ring-2 focus-visible:ring-accent/30',
        active && 'bg-accent-50 text-accent-700 dark:bg-accent/15 dark:text-accent-200',
        SIZES[size],
        className,
      )}
      {...rest}
    >
      <Icon name={icon} size={size === 'sm' ? 16 : 18} />
    </motion.button>
  );
});
