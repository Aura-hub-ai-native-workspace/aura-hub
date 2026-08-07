import type { ReactNode } from 'react';
import { Icon, type IconName } from '@aura/ui';

/**
 * ErrorState — the honest failure placeholder. Shown wherever a real
 * operation failed, as distinct from EmptyState (which means "nothing
 * here yet"). AURA never disguises a failure as an empty state.
 */
export function ErrorState({
  icon = 'bug',
  title,
  description,
  action,
  compact,
}: {
  icon?: IconName;
  title: string;
  description?: string;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={`grid place-items-center text-center ${compact ? 'py-10' : 'py-20'}`}>
      <div className="max-w-sm">
        <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl border border-danger/30 bg-danger/10 text-danger">
          <Icon name={icon} size={24} />
        </div>
        <div className="text-[15px] font-semibold text-text">{title}</div>
        {description && <p className="mx-auto mt-1.5 max-w-xs text-[12.5px] leading-relaxed text-text-muted">{description}</p>}
        {action && <div className="mt-4 flex justify-center">{action}</div>}
      </div>
    </div>
  );
}
