import type { ReactNode } from 'react';
import { cn } from '@aura/core';

/**
 * PanelBody — shared chrome for every panel's content: consistent
 * padding + independent scroll. The tab bar itself lives in
 * PanelWorkspace; panels only render their body.
 */
export function PanelBody({ children, className, padded = true }: { children: ReactNode; className?: string; padded?: boolean }) {
  return (
    <div className={cn('h-full min-h-0 overflow-y-auto', padded && 'p-3', className)}>
      {children}
    </div>
  );
}

export function PanelHeader({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="mb-3 flex items-baseline gap-2">
      <span className="text-[12px] font-semibold text-text">{title}</span>
      {hint && <span className="truncate text-[10.5px] text-text-subtle">{hint}</span>}
    </div>
  );
}
