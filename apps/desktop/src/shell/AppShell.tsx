import { AnimatePresence, motion } from 'framer-motion';
import { spring, useAppStore } from '@aura/core';
import { LeftNav } from './LeftNav';
import { CommandBar } from './CommandBar';
import { RightPanel } from './RightPanel';
import { StatusBar } from './StatusBar';
import { ScreenRouter } from '../screens/ScreenRouter';

/**
 * AppShell — the fixed frame of the operating environment.
 *
 *   ┌──────────────────────────────────────────────┐
 *   │ [ Left Nav ] │ Command Bar                    │
 *   │              ├────────────────────┬───────────┤
 *   │              │ Main Workspace     │ Context   │
 *   │              │                    │ Panel     │
 *   ├──────────────┴────────────────────┴───────────┤
 *   │ Status Bar                                     │
 *   └──────────────────────────────────────────────┘
 *
 * Every region is independently scrollable; the frame never moves.
 */
export function AppShell() {
  const rightPanelOpen = useAppStore((s) => s.rightPanelOpen);

  return (
    <div
      className="flex h-screen w-screen flex-col overflow-hidden"
      style={{ background: 'var(--canvas-wash)' }}
    >
      <div className="flex min-h-0 flex-1">
        <LeftNav />

        <div className="flex min-w-0 flex-1 flex-col">
          <CommandBar />

          <div className="flex min-h-0 flex-1">
            {/* Main workspace — the stage where screens live. */}
            <main className="min-w-0 flex-1 overflow-y-auto">
              <ScreenRouter />
            </main>

            {/* Right context panel — collapsible, spring-animated width. */}
            <AnimatePresence initial={false}>
              {rightPanelOpen && (
                <motion.aside
                  key="right-panel"
                  initial={{ width: 0, opacity: 0 }}
                  animate={{ width: 320, opacity: 1 }}
                  exit={{ width: 0, opacity: 0 }}
                  transition={spring.fluid}
                  className="shrink-0 overflow-hidden border-l border-line bg-surface/70 backdrop-blur-xl"
                >
                  <div className="h-full w-[320px] overflow-y-auto">
                    <RightPanel />
                  </div>
                </motion.aside>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>

      <StatusBar />
    </div>
  );
}
