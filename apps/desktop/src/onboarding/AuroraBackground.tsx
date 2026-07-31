import { motion, useReducedMotion } from 'framer-motion';

/**
 * AuroraBackground — the onboarding's signature atmosphere.
 * ------------------------------------------------------------------
 * A fixed near-black canvas with three large, soft, slowly-drifting
 * gradient blooms (AURA blue, cyan, violet) plus a faint vignette and
 * a hairline grid for depth. Deliberately NOT the app's own light/dark
 * theme — first-run is its own cinematic space, always dark, so the
 * brand reads consistently regardless of the user's eventual OS theme
 * preference. Every animation is skipped (blooms render static) under
 * prefers-reduced-motion.
 */
export function AuroraBackground() {
  const reduce = useReducedMotion();

  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden bg-[#07080c]">
      {/* Hairline grid — barely-there structure, reads as "environment" not "poster". */}
      <div
        className="absolute inset-0 opacity-[0.05]"
        style={{
          backgroundImage:
            'linear-gradient(to right, rgba(255,255,255,0.6) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.6) 1px, transparent 1px)',
          backgroundSize: '64px 64px',
        }}
      />

      {/* Bloom 1 — AURA blue, upper-left. */}
      <motion.div
        className="absolute -left-[10%] -top-[15%] h-[62vw] w-[62vw] max-w-[820px] rounded-full blur-[110px]"
        style={{ background: 'radial-gradient(circle, rgba(60,110,255,0.34) 0%, rgba(60,110,255,0) 70%)' }}
        initial={{ opacity: 0.7, scale: 1 }}
        animate={
          reduce
            ? { opacity: 0.7 }
            : { opacity: [0.55, 0.85, 0.55], scale: [1, 1.08, 1], x: [0, 30, 0], y: [0, 20, 0] }
        }
        transition={{ duration: 16, repeat: Infinity, ease: 'easeInOut' }}
      />

      {/* Bloom 2 — cyan, right side. */}
      <motion.div
        className="absolute -right-[12%] top-[8%] h-[54vw] w-[54vw] max-w-[720px] rounded-full blur-[110px]"
        style={{ background: 'radial-gradient(circle, rgba(1,192,247,0.26) 0%, rgba(1,192,247,0) 70%)' }}
        initial={{ opacity: 0.6, scale: 1 }}
        animate={
          reduce
            ? { opacity: 0.6 }
            : { opacity: [0.4, 0.7, 0.4], scale: [1, 1.1, 1], x: [0, -24, 0], y: [0, 26, 0] }
        }
        transition={{ duration: 19, repeat: Infinity, ease: 'easeInOut', delay: 1.2 }}
      />

      {/* Bloom 3 — violet, lower-center. Adds the "aurora" multi-hue sweep. */}
      <motion.div
        className="absolute bottom-[-20%] left-[26%] h-[58vw] w-[58vw] max-w-[760px] rounded-full blur-[120px]"
        style={{ background: 'radial-gradient(circle, rgba(139,92,246,0.22) 0%, rgba(139,92,246,0) 70%)' }}
        initial={{ opacity: 0.5, scale: 1 }}
        animate={
          reduce
            ? { opacity: 0.5 }
            : { opacity: [0.35, 0.6, 0.35], scale: [1, 1.12, 1], x: [0, 18, 0] }
        }
        transition={{ duration: 22, repeat: Infinity, ease: 'easeInOut', delay: 2.4 }}
      />

      {/* Vignette — keeps content readable against the blooms. */}
      <div
        className="absolute inset-0"
        style={{ background: 'radial-gradient(120% 100% at 50% 40%, transparent 40%, rgba(4,5,8,0.55) 100%)' }}
      />
      <div className="absolute inset-0 bg-gradient-to-b from-black/10 via-transparent to-black/40" />
    </div>
  );
}
