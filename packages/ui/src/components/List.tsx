import { type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { cn, spring, staggerContainer, staggerItem } from '@aura/core';

export interface ListProps {
  children: ReactNode;
  className?: string;
  /** Stagger children in on mount. */
  animated?: boolean;
}

export function List({ children, className, animated = true }: ListProps) {
  return (
    <motion.ul
      variants={animated ? staggerContainer : undefined}
      initial={animated ? 'initial' : undefined}
      animate={animated ? 'animate' : undefined}
      className={cn('flex flex-col', className)}
    >
      {children}
    </motion.ul>
  );
}

export interface ListItemProps {
  leading?: ReactNode;
  trailing?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  onClick?: () => void;
  className?: string;
  animated?: boolean;
}

export function ListItem({ leading, trailing, title, subtitle, onClick, className, animated = true }: ListItemProps) {
  const interactive = Boolean(onClick);
  return (
    <motion.li
      variants={animated ? staggerItem : undefined}
      whileHover={interactive ? { x: 2 } : undefined}
      transition={spring.snappy}
      onClick={onClick}
      className={cn(
        'flex items-center gap-3 rounded-xl px-3 py-2.5',
        interactive && 'cursor-pointer hover:bg-surface-hover',
        className,
      )}
    >
      {leading && <div className="shrink-0">{leading}</div>}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium text-text">{title}</div>
        {subtitle && <div className="truncate text-[11.5px] text-text-muted">{subtitle}</div>}
      </div>
      {trailing && <div className="shrink-0 text-[11.5px] text-text-subtle">{trailing}</div>}
    </motion.li>
  );
}
