import { motion, useReducedMotion } from 'framer-motion';
import { Icon, type IconName } from '@aura/ui';

const NODES: { icon: IconName; label: string; angle: number; color: string; delay: number }[] = [
  { icon: 'code', label: 'Code', angle: -90, color: '#5c86ff', delay: 0 },
  { icon: 'spark', label: 'AI', angle: 30, color: '#01c0f7', delay: 0.5 },
  { icon: 'knowledge', label: 'Knowledge', angle: 150, color: '#a78bfa', delay: 1 },
];

const RADIUS = 108;

/**
 * AuraGlyphField — AURA's own identity mark for "AI + Code + Knowledge",
 * built entirely from the app's existing bespoke icon language (no stock
 * illustration, no imported artwork). Three glyph nodes gently breathe
 * around a glowing core; a thin pulse of light travels each connector
 * toward the center, reading as "everything feeding into one understanding".
 */
export function AuraGlyphField() {
  const reduce = useReducedMotion();

  return (
    <div className="relative h-[240px] w-[240px]" aria-hidden>
      <svg viewBox="-120 -120 240 240" className="absolute inset-0 h-full w-full overflow-visible">
        {NODES.map((n) => {
          const rad = (n.angle * Math.PI) / 180;
          const x = Math.cos(rad) * RADIUS;
          const y = Math.sin(rad) * RADIUS;
          return (
            <g key={n.label}>
              <line x1={0} y1={0} x2={x} y2={y} stroke={n.color} strokeOpacity={0.16} strokeWidth={1.5} />
              {!reduce && (
                <motion.circle
                  r={2.4}
                  fill={n.color}
                  initial={{ opacity: 0, cx: x, cy: y }}
                  animate={{ opacity: [0, 1, 0], cx: [x, 0], cy: [y, 0] }}
                  transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut', delay: n.delay, repeatDelay: 1.4 }}
                />
              )}
            </g>
          );
        })}
      </svg>

      {/* Glowing core. */}
      <motion.div
        className="absolute left-1/2 top-1/2 h-14 w-14 -translate-x-1/2 -translate-y-1/2 rounded-full"
        style={{ background: 'radial-gradient(circle, rgba(92,134,255,0.9) 0%, rgba(92,134,255,0.15) 65%, transparent 75%)' }}
        animate={reduce ? {} : { scale: [1, 1.12, 1], opacity: [0.85, 1, 0.85] }}
        transition={{ duration: 3.2, repeat: Infinity, ease: 'easeInOut' }}
      />
      <div className="absolute left-1/2 top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_0_18px_6px_rgba(255,255,255,0.55)]" />

      {NODES.map((n, i) => {
        const rad = (n.angle * Math.PI) / 180;
        const x = Math.cos(rad) * RADIUS;
        const y = Math.sin(rad) * RADIUS;
        return (
          <motion.div
            key={n.label}
            className="absolute left-1/2 top-1/2 flex h-12 w-12 items-center justify-center rounded-2xl border border-white/15 backdrop-blur-md"
            style={{
              marginLeft: x - 24,
              marginTop: y - 24,
              background: 'linear-gradient(160deg, rgba(255,255,255,0.10), rgba(255,255,255,0.03))',
              boxShadow: `0 0 24px -6px ${n.color}88`,
              color: n.color,
            }}
            initial={{ opacity: 0, scale: 0.8 }}
            animate={reduce ? { opacity: 1, scale: 1 } : { opacity: 1, scale: 1, y: [0, -6, 0] }}
            transition={
              reduce
                ? { duration: 0.5, delay: 0.2 + i * 0.12 }
                : { y: { duration: 3.4, repeat: Infinity, ease: 'easeInOut', delay: n.delay }, opacity: { duration: 0.5, delay: 0.2 + i * 0.12 }, scale: { duration: 0.5, delay: 0.2 + i * 0.12 } }
            }
          >
            <Icon name={n.icon} size={20} strokeWidth={1.6} />
          </motion.div>
        );
      })}
    </div>
  );
}
