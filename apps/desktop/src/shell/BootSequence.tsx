import { useEffect, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useAppStore } from '@aura/core';
import { AuraLogo } from '../brand/AuraLogo';

/**
 * AURA intro — a premium operating-system boot, not a splash.
 *
 *   official logo ▸ "AURA Hub" ▸ "AI Operating Environment" ▸ the
 *   environment reports itself initialising ▸ a seamless dissolve
 *   into Home.
 *
 * Theme-aware: it always adopts the active theme's canvas + typography
 * (never a forced black screen in light mode). Calm — a soft blue aura,
 * no bars, no fake logs, no effects. Fully skipped for reduced-motion.
 */

const MESSAGES = [
  'Initializing Environment',
  'Loading Workspace',
  'Preparing Knowledge Fabric',
  'Environment Ready',
];

// Deliberate, compact choreography (seconds).
const T = {
  logoIn: 0.55,
  wordmark: 0.5,
  subtitle: 0.82,
  lineDraw: 0.66,
  msgStart: 0.98,
  msgStep: 0.3,
  dissolve: 0.46,
};

export function BootSequence({ onComplete }: { onComplete: () => void }) {
  const reduce = useReducedMotion();
  const theme = useAppStore((s) => s.theme);
  const dark = theme === 'dark';
  const [step, setStep] = useState(0);
  const [leaving, setLeaving] = useState(false);

  // Theme-aware palette (fixed boot canvas, not the app surfaces).
  const bg = dark ? '#0F1117' : '#F7F9FC';
  const primary = dark ? 'rgba(255,255,255,0.92)' : '#0F1117';
  const muted = dark ? 'rgba(255,255,255,0.52)' : '#5B6376';
  const faint = dark ? 'rgba(255,255,255,0.40)' : '#7A8296';

  useEffect(() => {
    if (reduce) {
      const t = setTimeout(onComplete, 240);
      return () => clearTimeout(t);
    }
    const timers: number[] = [];
    MESSAGES.forEach((_, i) => {
      timers.push(window.setTimeout(() => setStep(i), (T.msgStart + i * T.msgStep) * 1000));
    });
    const dissolveAt = (T.msgStart + MESSAGES.length * T.msgStep + 0.18) * 1000;
    timers.push(window.setTimeout(() => setLeaving(true), dissolveAt));
    timers.push(window.setTimeout(onComplete, dissolveAt + T.dissolve * 1000));
    return () => timers.forEach(clearTimeout);
  }, [reduce, onComplete]);

  return (
    <AnimatePresence>
      {!leaving && (
        <motion.div
          key="boot"
          initial={{ opacity: 1 }}
          exit={{ opacity: 0, filter: 'blur(6px)' }}
          transition={{ duration: T.dissolve, ease: [0.16, 1, 0.3, 1] }}
          className="fixed inset-0 z-[300] flex flex-col items-center justify-center overflow-hidden"
          style={{ backgroundColor: bg }}
        >
          {/* Soft blue aura behind the mark. */}
          <div className="relative flex items-center justify-center">
            <motion.div
              aria-hidden
              className="absolute h-48 w-48 rounded-full"
              style={{ background: 'radial-gradient(circle, rgba(1,192,247,0.28) 0%, rgba(1,192,247,0) 68%)' }}
              initial={{ opacity: 0, scale: 0.6 }}
              animate={{ opacity: [0, 0.95, 0.7], scale: [0.6, 1.14, 1] }}
              transition={{ duration: 1.5, ease: 'easeOut', times: [0, 0.5, 1] }}
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.88, filter: 'blur(8px)' }}
              animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
              transition={{ duration: T.logoIn, ease: [0.16, 1, 0.3, 1] }}
              className="relative"
            >
              <motion.div
                animate={{ scale: [1, 1.04, 1] }}
                transition={{ duration: 3.6, repeat: Infinity, ease: 'easeInOut' }}
              >
                <AuraLogo size={78} />
              </motion.div>
            </motion.div>
          </div>

          {/* Wordmark */}
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: T.wordmark, duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
            className="mt-7 text-[19px] font-semibold tracking-[-0.01em]"
            style={{ color: primary }}
          >
            AURA Hub
          </motion.div>

          {/* Tagline */}
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: T.subtitle, duration: 0.5 }}
            className="mt-1.5 text-[11px] font-medium uppercase tracking-[0.34em]"
            style={{ color: muted }}
          >
            AI Operating Environment
          </motion.div>

          {/* Thin drawing line */}
          <motion.div
            className="mt-7 h-px overflow-hidden"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: 176, opacity: 1 }}
            transition={{ delay: 0.42, duration: T.lineDraw, ease: [0.16, 1, 0.3, 1] }}
          >
            <div className="h-px w-full bg-gradient-to-r from-transparent via-[#01c0f7] to-transparent" />
          </motion.div>

          {/* Boot messages — one calm line, crossfading in place. */}
          <div className="mt-4 h-5">
            <AnimatePresence mode="wait">
              <motion.div
                key={step}
                initial={{ opacity: 0, y: 5 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -5 }}
                transition={{ duration: 0.26 }}
                className="text-center text-[11.5px] font-medium tracking-wide"
                style={{ color: step === MESSAGES.length - 1 ? primary : faint }}
              >
                {MESSAGES[step]}
                {step < MESSAGES.length - 1 ? '…' : '.'}
              </motion.div>
            </AnimatePresence>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
