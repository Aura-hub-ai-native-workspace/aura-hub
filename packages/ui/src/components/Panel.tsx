import { type ReactNode } from 'react';
import { cn } from '@aura/core';
import { Icon, type IconName } from '../icons/Icon';

export interface PanelSectionProps {
  title: string;
  icon?: IconName;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}

/**
 * PanelSection — a titled block used to compose the right context panel
 * and other sidebars. Deliberately unopinionated about its body.
 */
export function PanelSection({ title, icon, action, children, className }: PanelSectionProps) {
  return (
    <section className={cn('px-4 py-4', className)}>
      <header className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2 text-text-muted">
          {icon && <Icon name={icon} size={15} />}
          <h4 className="text-[11px] font-semibold uppercase tracking-wider">{title}</h4>
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

/** A subtle key/value row for property panels. */
export function PropertyRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5">
      <span className="text-[12px] text-text-muted">{label}</span>
      <span className="text-[12px] font-medium text-text text-right">{value}</span>
    </div>
  );
}
