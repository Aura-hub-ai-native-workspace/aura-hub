import { cn } from '@aura/core';

export interface SkeletonProps {
  className?: string;
  /** Convenience shape presets. */
  variant?: 'line' | 'block' | 'circle';
}

/**
 * Loading placeholder with a soft shimmer. The shimmer keyframe is
 * defined in global.css so it can be reused outside React too.
 */
export function Skeleton({ className, variant = 'block' }: SkeletonProps) {
  return (
    <div
      className={cn(
        'aura-shimmer bg-surface-active',
        variant === 'line' && 'h-3 rounded-full',
        variant === 'block' && 'rounded-xl',
        variant === 'circle' && 'rounded-full',
        className,
      )}
    />
  );
}

/** A prebuilt skeleton in the shape of a dashboard card. */
export function SkeletonCard({ className }: { className?: string }) {
  return (
    <div className={cn('rounded-2xl border border-line bg-surface p-5', className)}>
      <div className="flex items-center gap-3">
        <Skeleton variant="circle" className="h-10 w-10" />
        <div className="flex-1 space-y-2">
          <Skeleton variant="line" className="w-1/2" />
          <Skeleton variant="line" className="w-1/3" />
        </div>
      </div>
      <div className="mt-5 space-y-2.5">
        <Skeleton variant="line" className="w-full" />
        <Skeleton variant="line" className="w-4/5" />
      </div>
    </div>
  );
}
