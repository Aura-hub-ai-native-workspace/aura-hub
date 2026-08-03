/**
 * AURA Hub — Motion System
 * ------------------------------------------------------------------
 * Natural spring physics, not duration curves. Everything in AURA
 * moves like a physical object with mass — nothing "plays an
 * animation". These presets are the vocabulary; components choose a
 * word from it, never invent their own timing.
 *
 * Consumed by Framer Motion. Because these are plain objects they are
 * also tree-shakeable and unit-testable.
 */

import type { Transition, Variants } from 'framer-motion';

/** Spring presets — tuned for a 120Hz "weightless but grounded" feel. */
export const spring = {
  /** Snappy — buttons, toggles, small affordances. */
  snappy: { type: 'spring', stiffness: 520, damping: 34, mass: 0.7 },
  /** Smooth — panels, cards, the default for most surfaces. */
  smooth: { type: 'spring', stiffness: 320, damping: 34, mass: 0.9 },
  /** Gentle — large surfaces, page-level transitions. */
  gentle: { type: 'spring', stiffness: 210, damping: 30, mass: 1 },
  /** Fluid — the collapsible chrome (sidebar, context panel). */
  fluid: { type: 'spring', stiffness: 260, damping: 32, mass: 0.95 },
} satisfies Record<string, Transition>;

/** Duration-based fallbacks for opacity-only fades (springs on opacity feel muddy). */
export const ease = {
  out: { duration: 0.28, ease: [0.16, 1, 0.3, 1] as const },
  inOut: { duration: 0.36, ease: [0.65, 0, 0.35, 1] as const },
} satisfies Record<string, Transition>;

/** Page / route transition — content lifts in from below with a soft fade. */
export const pageVariants: Variants = {
  initial: { opacity: 0, y: 12, filter: 'blur(6px)' },
  animate: { opacity: 1, y: 0, filter: 'blur(0px)', transition: spring.gentle },
  exit: { opacity: 0, y: -8, filter: 'blur(4px)', transition: ease.out },
};

/** Staggered container — dashboards, lists, grids reveal in sequence. */
export const staggerContainer: Variants = {
  initial: {},
  animate: { transition: { staggerChildren: 0.045, delayChildren: 0.04 } },
};

/** Individual staggered child. */
export const staggerItem: Variants = {
  initial: { opacity: 0, y: 14 },
  animate: { opacity: 1, y: 0, transition: spring.smooth },
};

/** Overlay scrim (dialogs, command palette). */
export const scrimVariants: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: ease.out },
  exit: { opacity: 0, transition: ease.out },
};

/** Dialog / popover surface — scales up from 96% with spring. */
export const popVariants: Variants = {
  initial: { opacity: 0, scale: 0.96, y: 8 },
  animate: { opacity: 1, scale: 1, y: 0, transition: spring.smooth },
  exit: { opacity: 0, scale: 0.98, y: 4, transition: ease.out },
};

/**
 * Project immersion — you don't "open a page", you *enter* the space.
 * The workspace materialises from slightly too-close and out-of-focus,
 * settling into place. The section it replaces recedes.
 */
export const enterSpaceVariants: Variants = {
  initial: { opacity: 0, scale: 1.06, filter: 'blur(12px)' },
  animate: { opacity: 1, scale: 1, filter: 'blur(0px)', transition: { ...spring.gentle, mass: 1.1 } },
  exit: { opacity: 0, scale: 0.985, filter: 'blur(8px)', transition: ease.out },
};

/**
 * Boot choreography timings (seconds). Kept here so the whole intro
 * reads as one deliberate ~2s sequence rather than scattered magic
 * numbers. A premium OS boot, never a game splash.
 */
export const boot = {
  total: 2.15,
  logoIn: 0.55,
  lineDraw: 0.7,
  messageStep: 0.34,
  fadeOut: 0.45,
} as const;

/** Ambient "breathing" — the environment is alive but never fidgets. */
export const breathe = {
  animate: { opacity: [0.5, 1, 0.5], scale: [1, 1.12, 1] },
  transition: { duration: 3.2, repeat: Infinity, ease: 'easeInOut' as const },
} as const;
