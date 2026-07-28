import { createContext, useContext, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { cn, spring } from '@aura/core';
import { Icon, type IconName } from '../icons/Icon';

interface TabsCtx {
  value: string;
  onChange: (v: string) => void;
  layoutId: string;
}
const Ctx = createContext<TabsCtx | null>(null);

export interface TabsProps {
  value: string;
  onChange: (v: string) => void;
  children: ReactNode;
  className?: string;
  /** Unique id so multiple Tabs on one page don't share the indicator. */
  layoutId?: string;
}

/** Animated tab group with a shared sliding indicator (Framer layoutId). */
export function Tabs({ value, onChange, children, className, layoutId = 'tabs' }: TabsProps) {
  return (
    <Ctx.Provider value={{ value, onChange, layoutId }}>
      <div
        role="tablist"
        className={cn('inline-flex items-center gap-1 rounded-xl bg-surface-active/70 p-1', className)}
      >
        {children}
      </div>
    </Ctx.Provider>
  );
}

export interface TabProps {
  value: string;
  icon?: IconName;
  children: ReactNode;
}

export function Tab({ value, icon, children }: TabProps) {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('Tab must be used within <Tabs>');
  const active = ctx.value === value;
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={() => ctx.onChange(value)}
      className={cn(
        'relative inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12.5px] font-medium',
        'transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-accent/30',
        active ? 'text-text' : 'text-text-muted hover:text-text',
      )}
    >
      {active && (
        <motion.span
          layoutId={ctx.layoutId}
          transition={spring.smooth}
          className="absolute inset-0 rounded-lg bg-surface shadow-sm"
        />
      )}
      {icon && <Icon name={icon} size={15} className="relative z-10" />}
      <span className="relative z-10">{children}</span>
    </button>
  );
}
