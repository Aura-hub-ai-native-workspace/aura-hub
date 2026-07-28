import { type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { staggerContainer, staggerItem, cn } from '@aura/core';

/**
 * Shared page frame: generous max width, Apple-grade spacing, an
 * optional title block, and a staggered reveal for its children. Every
 * screen uses this so spacing and rhythm stay identical everywhere.
 */
export function PageContainer({
  title,
  subtitle,
  actions,
  children,
  className,
  wide,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  wide?: boolean;
}) {
  return (
    <div className={cn('mx-auto w-full px-8 py-8 sm:px-10 lg:px-12', wide ? 'max-w-[1400px]' : 'max-w-[1180px]', className)}>
      {(title || actions) && (
        <div className="mb-8 flex items-end justify-between gap-6">
          <div>
            {title && <h1 className="text-[26px] font-semibold tracking-[-0.01em] text-text">{title}</h1>}
            {subtitle && <p className="mt-1.5 text-[14px] text-text-muted">{subtitle}</p>}
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

/** A staggered child wrapper — use around each top-level block on a page. */
export function PageBlock({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <motion.div variants={staggerItem} className={className}>
      {children}
    </motion.div>
  );
}
