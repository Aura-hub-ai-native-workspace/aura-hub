/**
 * ProjectIntro — the folder-opening moment shown the first time a project is
 * opened. The message depends on how the project came to be: one AURA just
 * created from an idea, or an existing folder being opened for the first time.
 * It shows once per project (the service decides and persists that), never
 * on a route change, and can be skipped.
 */
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';

export const INTRO_MESSAGE = {
  new: "Let's make your idea into working product",
  existing: 'Build it better than before',
} as const;

const SHOW_MS = 2600;

export function ProjectIntro({ kind, projectName, onDone }: { kind: 'new' | 'existing'; projectName: string; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, SHOW_MS);
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' || e.key === 'Enter') onDone(); };
    window.addEventListener('keydown', key);
    return () => { clearTimeout(t); window.removeEventListener('keydown', key); };
  }, [onDone]);

  // A portal to <body>: the project view sits inside a transformed page
  // wrapper, which would otherwise anchor `fixed` to the page, not the window.
  return createPortal(
    <AnimatePresence>
      <motion.div
        key="intro"
        role="dialog"
        aria-modal="true"
        aria-label={INTRO_MESSAGE[kind]}
        data-testid="project-intro"
        data-kind={kind}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.35 }}
        onClick={onDone}
        className="fixed inset-0 z-[120] grid cursor-pointer place-items-center bg-canvas/95 backdrop-blur-md"
      >
        <div className="pointer-events-none absolute left-1/2 top-1/2 h-80 w-80 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent/15 blur-3xl" />
        <div className="relative flex flex-col items-center gap-7 px-8 text-center">
          {/* The folder: its lid swings open, and light rises from inside. */}
          <div className="relative h-24 w-32" style={{ perspective: 600 }}>
            <motion.div
              className="absolute inset-x-0 bottom-0 h-20 rounded-xl border border-accent/40 bg-surface shadow-[0_12px_40px_-12px] shadow-accent"
              initial={{ y: 6 }} animate={{ y: 0 }} transition={{ duration: 0.6 }}
            />
            <motion.div
              className="absolute bottom-16 left-0 h-3 w-12 rounded-t-lg border border-b-0 border-accent/40 bg-surface"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.2 }}
            />
            <motion.div
              className="absolute inset-x-1 bottom-12 h-14 origin-bottom rounded-lg bg-gradient-to-t from-accent/70 to-transparent blur-[2px]"
              initial={{ opacity: 0, scaleY: 0 }} animate={{ opacity: 1, scaleY: 1 }} transition={{ delay: 0.7, duration: 0.9 }}
            />
            <motion.div
              className="absolute inset-x-0 bottom-0 h-16 origin-bottom rounded-xl border border-accent/50 bg-surface-hover"
              style={{ transformStyle: 'preserve-3d' }}
              initial={{ rotateX: 0 }} animate={{ rotateX: -62 }} transition={{ delay: 0.5, duration: 0.9, ease: [0.2, 0.8, 0.2, 1] }}
            />
          </div>
          <div>
            <motion.h1
              className="text-[26px] font-semibold tracking-[-0.02em] text-text"
              initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 1.0, duration: 0.6 }}
            >
              {INTRO_MESSAGE[kind]}
            </motion.h1>
            <motion.p
              className="mt-2 text-[13px] text-text-muted"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 1.4, duration: 0.6 }}
            >
              {projectName}
            </motion.p>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>,
    document.body,
  );
}
