import type { ReactNode } from 'react';
import { motion } from 'framer-motion';
import { AuraLogo } from '../brand/AuraLogo';
import { AuroraBackground } from './AuroraBackground';
import { ParticleCanvas } from './ParticleCanvas';

export const ONBOARDING_STEPS = ['welcome', 'activate', 'ready'] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/**
 * OnboardingLayout — the fixed chrome every onboarding screen sits inside:
 * the aurora + particle atmosphere, a quiet persistent brand mark, and a
 * step indicator. Individual screens only ever render their own content
 * column; they never re-declare the background.
 */
export function OnboardingLayout({ step, children }: { step: OnboardingStep; children: ReactNode }) {
  const index = ONBOARDING_STEPS.indexOf(step);

  return (
    <div className="fixed inset-0 z-[300] overflow-hidden text-white">
      <AuroraBackground />
      <ParticleCanvas />

      {/* Persistent brand mark, top-left — quiet, never competing with the hero content. */}
      <motion.div
        initial={{ opacity: 0, y: -6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, delay: 0.15 }}
        className="absolute left-7 top-6 flex items-center gap-2.5"
      >
        <AuraLogo size={22} />
        <span className="text-[12px] font-semibold tracking-[0.02em] text-white/70">AURA</span>
      </motion.div>

      {/* Step dots, bottom-center. */}
      <div className="absolute inset-x-0 bottom-8 flex items-center justify-center gap-2">
        {ONBOARDING_STEPS.map((s, i) => (
          <motion.span
            key={s}
            className="h-1.5 rounded-full bg-white"
            animate={{ width: i === index ? 22 : 6, opacity: i === index ? 0.95 : 0.28 }}
            transition={{ type: 'spring', stiffness: 320, damping: 34 }}
          />
        ))}
      </div>

      {/* Content stage. */}
      <div className="relative z-10 flex h-full w-full items-center justify-center px-6">
        {children}
      </div>
    </div>
  );
}
