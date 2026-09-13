import type { ReactNode } from 'react';
import { cn } from '@aura/core';

export type GlassTint = 'blue' | 'violet' | 'cyan' | 'green' | 'amber' | 'red' | 'neutral';

const TINT: Record<GlassTint, string> = {
  blue: 'border-[rgba(77,124,255,0.35)] shadow-glow-blue',
  violet: 'border-[rgba(122,92,255,0.38)] shadow-glow-violet',
  cyan: 'border-[rgba(32,211,255,0.32)] shadow-glow-cyan',
  green: 'border-[rgba(31,211,138,0.32)] shadow-glow-green',
  amber: 'border-[rgba(255,181,71,0.35)]',
  red: 'border-[rgba(255,93,122,0.38)]',
  neutral: 'border-[rgba(125,146,255,0.25)]',
};

/**
 * GlassCard — reusable neon glass surface.
 * Layered gradient + 1px luminous border + single box-shadow glow.
 * No backdrop-blur by default (perf); opt in with `blur` on small cards.
 */
export function GlassCard({
  tint = 'neutral',
  blur = false,
  className,
  children,
  ...rest
}: {
  tint?: GlassTint;
  blur?: boolean;
  className?: string;
  children: ReactNode;
} & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'relative rounded-lg border bg-gradient-to-b from-[rgba(20,28,52,0.92)] to-[rgba(9,13,26,0.94)] shadow-card',
        'before:pointer-events-none before:absolute before:inset-x-4 before:top-0 before:h-px before:bg-gradient-to-r before:from-transparent before:via-[rgba(160,180,255,0.5)] before:to-transparent',
        blur && 'backdrop-blur-md',
        TINT[tint],
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}
