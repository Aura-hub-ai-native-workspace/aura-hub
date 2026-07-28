import { motion } from 'framer-motion';
import { cn, spring } from '@aura/core';
import auraLogo from '../assets/aura-logo.png';

/**
 * AURA identity — the ONE official logo, used everywhere.
 *
 * There is no alternate or geometric glyph: every surface renders the
 * same official asset (`assets/aura-logo.png`) so the mark stays exact
 * and instantly recognisable across the OS, boot, nav and empty states.
 * Do not recreate or restyle the mark — only size and place it.
 */

export const AURA_LOGO_SRC = auraLogo;

export interface AuraLogoProps {
  size?: number;
  className?: string;
}

/** The bare official mark. Transparent background; works on any surface. */
export function AuraLogo({ size = 28, className }: AuraLogoProps) {
  return (
    <img
      src={auraLogo}
      alt="AURA"
      width={size}
      height={size}
      draggable={false}
      className={cn('select-none object-contain', className)}
      style={{ width: size, height: size }}
    />
  );
}

/**
 * The mark used in the nav rail / chrome. Renders the official logo at a
 * consistent footprint with a gentle hover response — no coloured tile
 * behind it, so the brand colour is never altered.
 */
export function AuraTile({ size = 36, className }: { size?: number; className?: string }) {
  return (
    <motion.div
      whileHover={{ scale: 1.06 }}
      transition={spring.snappy}
      className={cn('grid shrink-0 place-items-center', className)}
      style={{ width: size, height: size }}
    >
      <AuraLogo size={size} />
    </motion.div>
  );
}

/** Full lockup: official mark + wordmark. */
export function AuraLockup({
  size = 34,
  tagline = true,
  className,
}: {
  size?: number;
  tagline?: boolean;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center gap-3', className)}>
      <AuraLogo size={size} />
      <div className="leading-tight">
        <div className="text-[15px] font-semibold tracking-[-0.01em] text-text">AURA Hub</div>
        {tagline && (
          <div className="text-[10px] font-medium uppercase tracking-[0.24em] text-text-subtle">Environment</div>
        )}
      </div>
    </div>
  );
}
