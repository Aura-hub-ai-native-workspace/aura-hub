import { Button, type ButtonProps } from '@aura/ui';
import { cn } from '@aura/core';

/**
 * GlowButton — primary send/CTA with neon gradient + glow.
 * Blue stays primary; violet is gradient partner only, never standalone.
 * Wraps @aura/ui Button so loading/disabled/a11y behavior is preserved.
 */
export function GlowButton({ className, ...rest }: ButtonProps) {
  return (
    <Button
      variant="primary"
      className={cn(
        'neon-focus border border-[rgba(140,170,255,0.55)]',
        'bg-gradient-to-br from-neon-blue to-neon-violet',
        'shadow-glow-blue hover:brightness-110 active:brightness-95',
        'transition-[filter,box-shadow] duration-150',
        className,
      )}
      {...rest}
    />
  );
}
