import { forwardRef, type ReactNode } from 'react';
import { motion, type HTMLMotionProps } from 'framer-motion';
import { cn, spring } from '@aura/core';
import { Icon, type IconName } from '../icons/Icon';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'subtle' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-accent text-white shadow-sm hover:bg-accent-600 active:bg-accent-700 focus-visible:ring-accent/40',
  secondary:
    'bg-surface text-text border border-line hover:bg-surface-hover active:bg-surface-active focus-visible:ring-accent/30',
  ghost:
    'bg-transparent text-text-muted hover:bg-surface-hover hover:text-text focus-visible:ring-accent/20',
  subtle:
    'bg-accent-50 text-accent-700 hover:bg-accent-100 focus-visible:ring-accent/30 dark:bg-accent/10 dark:text-accent-200',
  danger:
    'bg-danger text-white shadow-sm hover:brightness-105 active:brightness-95 focus-visible:ring-danger/40',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-[12px] gap-1.5 rounded-lg',
  md: 'h-9 px-4 text-[13px] gap-2 rounded-xl',
  lg: 'h-11 px-5 text-[14px] gap-2 rounded-2xl',
};

export interface ButtonProps extends Omit<HTMLMotionProps<'button'>, 'ref'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  iconRight?: IconName;
  loading?: boolean;
  block?: boolean;
  children?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', icon, iconRight, loading, block, className, children, disabled, ...rest },
  ref,
) {
  const iconSize = size === 'lg' ? 18 : 16;
  return (
    <motion.button
      ref={ref}
      whileTap={{ scale: 0.97 }}
      transition={spring.snappy}
      disabled={disabled || loading}
      className={cn(
        'relative inline-flex items-center justify-center font-medium select-none',
        'outline-none focus-visible:ring-2 transition-colors duration-150',
        'disabled:opacity-45 disabled:pointer-events-none',
        SIZES[size],
        VARIANTS[variant],
        block && 'w-full',
        className,
      )}
      {...rest}
    >
      {loading ? (
        <span className="h-4 w-4 rounded-full border-2 border-current/30 border-t-current animate-spin" />
      ) : (
        icon && <Icon name={icon} size={iconSize} />
      )}
      {children && <span className="truncate">{children}</span>}
      {iconRight && !loading && <Icon name={iconRight} size={iconSize} />}
    </motion.button>
  );
});
