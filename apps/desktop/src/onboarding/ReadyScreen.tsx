import { useEffect } from 'react';
import { motion, useReducedMotion } from 'framer-motion';

const MESSAGES = ['Configuring workspace', 'Warming up the knowledge fabric', 'Launching AURA'];

/**
 * ReadyScreen — the success + boot moment. Doubles as this (first) launch's
 * cinematic boot sequence, so completing onboarding skips the generic
 * BootSequence once — see appStore.completeOnboarding().
 */
export function ReadyScreen({ onComplete }: { onComplete: () => void }) {
  const reduce = useReducedMotion();

  useEffect(() => {
    const t = setTimeout(onComplete, reduce ? 500 : 2600);
    return () => clearTimeout(t);
  }, [onComplete, reduce]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.5 }}
      className="flex w-full max-w-md flex-col items-center text-center"
    >
      {/* Animated checkmark */}
      <div className="relative grid h-24 w-24 place-items-center">
        <motion.div
          className="absolute inset-0 rounded-full"
          style={{ background: 'radial-gradient(circle, rgba(52,211,153,0.35) 0%, rgba(52,211,153,0) 70%)' }}
          initial={{ scale: 0.6, opacity: 0 }}
          animate={{ scale: [0.6, 1.25, 1], opacity: [0, 1, 0.8] }}
          transition={{ duration: 1, ease: 'easeOut' }}
        />
        <motion.svg
          width={72}
          height={72}
          viewBox="0 0 72 72"
          initial="hidden"
          animate="visible"
        >
          <motion.circle
            cx={36}
            cy={36}
            r={32}
            fill="none"
            stroke="rgba(52,211,153,0.9)"
            strokeWidth={2.5}
            strokeLinecap="round"
            variants={{ hidden: { pathLength: 0 }, visible: { pathLength: 1 } }}
            transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
          />
          <motion.path
            d="M22 37.5 31.5 47 50 26"
            fill="none"
            stroke="rgb(52,211,153)"
            strokeWidth={4}
            strokeLinecap="round"
            strokeLinejoin="round"
            variants={{ hidden: { pathLength: 0, opacity: 0 }, visible: { pathLength: 1, opacity: 1 } }}
            transition={{ duration: 0.5, delay: 0.55, ease: [0.16, 1, 0.3, 1] }}
          />
        </motion.svg>
      </div>

      <motion.h1
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.9, duration: 0.5 }}
        className="mt-7 text-[28px] font-semibold tracking-[-0.02em] text-white"
      >
        Your AI Workspace is Ready
      </motion.h1>
      <motion.p
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 1.05, duration: 0.5 }}
        className="mt-2.5 text-[13.5px] text-white/55"
      >
        Everything has been configured successfully.
      </motion.p>

      {/* Launching progress */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 1.3, duration: 0.5 }}
        className="mt-9 w-full max-w-[260px]"
      >
        <div className="h-[3px] w-full overflow-hidden rounded-full bg-white/10">
          <motion.div
            className="h-full rounded-full bg-gradient-to-r from-[#5c86ff] via-[#01c0f7] to-emerald-400"
            initial={{ width: '0%' }}
            animate={{ width: '100%' }}
            transition={{ duration: reduce ? 0.4 : 1.9, ease: [0.16, 1, 0.3, 1], delay: 1.35 }}
          />
        </div>
        <LaunchMessages />
      </motion.div>
    </motion.div>
  );
}

function LaunchMessages() {
  return (
    <div className="mt-3 h-4 overflow-hidden">
      <motion.div
        animate={{ y: [0, -16, -32] }}
        transition={{ duration: 1.9, times: [0, 0.5, 1], ease: 'easeInOut', delay: 1.35 }}
      >
        {MESSAGES.map((m) => (
          <div key={m} className="h-4 text-[11.5px] font-medium uppercase tracking-[0.14em] text-white/35">
            {m}…
          </div>
        ))}
      </motion.div>
    </div>
  );
}
