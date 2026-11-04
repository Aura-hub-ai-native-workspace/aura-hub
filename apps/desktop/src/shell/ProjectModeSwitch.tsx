import { motion } from 'framer-motion';
import { PROJECT_MODES, cn, spring, useAppStore } from '@aura/core';

/**
 * The Overview | Workspace switch of an open project. It lives in the top
 * bar, in the middle, where the search field used to be.
 */
export function ProjectModeSwitch() {
  const mode = useAppStore((s) => s.projectMode);
  const setMode = useAppStore((s) => s.setProjectMode);
  return (
    <div className="relative flex gap-1 rounded-full bg-surface p-1" role="tablist" aria-label="Project">
      {PROJECT_MODES.map((m) => {
        const active = mode === m.key;
        return (
          <button
            key={m.key}
            role="tab"
            aria-selected={active}
            onClick={() => setMode(m.key)}
            className={cn('relative z-10 min-w-[104px] rounded-full px-5 py-1.5 text-[13px] font-medium transition-colors', active ? 'text-on-accent' : 'text-text-muted hover:text-text')}
          >
            {active && <motion.span layoutId="project-mode-pill" transition={spring.smooth} className="absolute inset-0 -z-10 rounded-full bg-accent" />}
            {m.label}
          </button>
        );
      })}
    </div>
  );
}
