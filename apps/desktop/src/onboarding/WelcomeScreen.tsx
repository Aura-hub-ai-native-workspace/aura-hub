import { motion, type Variants } from 'framer-motion';
import { AuraGlyphField } from './AuraGlyphField';

const container: Variants = {
  initial: {},
  animate: { transition: { staggerChildren: 0.09, delayChildren: 0.15 } },
};
const item: Variants = {
  initial: { opacity: 0, y: 16, filter: 'blur(6px)' },
  animate: { opacity: 1, y: 0, filter: 'blur(0px)', transition: { type: 'spring', stiffness: 210, damping: 28, mass: 1 } },
};

export function WelcomeScreen({ onBegin }: { onBegin: () => void }) {
  return (
    <motion.div
      variants={container}
      initial="initial"
      animate="animate"
      className="flex w-full max-w-[560px] flex-col items-center text-center"
    >
      <motion.div variants={item}>
        <AuraGlyphField />
      </motion.div>

      <motion.h1
        variants={item}
        className="mt-2 bg-gradient-to-b from-white to-white/70 bg-clip-text text-[44px] font-semibold leading-[1.05] tracking-[-0.02em] text-transparent"
      >
        Welcome to AURA
      </motion.h1>

      <motion.p variants={item} className="mt-5 max-w-md text-[16px] font-medium leading-relaxed text-white/85">
        Your AI-Native Operating Environment.
      </motion.p>
      <motion.p variants={item} className="mt-2 max-w-md text-[13.5px] leading-relaxed text-white/50">
        Not another assistant. A workspace that understands your projects, your tools, and your workflow.
      </motion.p>

      <motion.div variants={item} className="mt-10">
        <motion.button
          onClick={onBegin}
          whileHover={{ scale: 1.03, boxShadow: '0 0 42px -6px rgba(92,134,255,0.75)' }}
          whileTap={{ scale: 0.97 }}
          transition={{ type: 'spring', stiffness: 420, damping: 28 }}
          className="relative rounded-2xl bg-gradient-to-b from-[#6f95ff] to-[#3b6bff] px-9 py-3.5 text-[14.5px] font-semibold text-white shadow-[0_0_28px_-6px_rgba(92,134,255,0.65)]"
        >
          Begin
        </motion.button>
      </motion.div>

      <motion.p variants={item} className="mt-6 text-[11.5px] font-medium uppercase tracking-[0.16em] text-white/35">
        Built for developers. Powered by your AI.
      </motion.p>
    </motion.div>
  );
}
