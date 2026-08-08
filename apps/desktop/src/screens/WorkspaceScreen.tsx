/**
 * WorkspaceScreen — the Engineering Operating Environment's home.
 * ------------------------------------------------------------------
 * Two regions: the window canvas (ops/WorkspaceCanvas — its own header
 * carries the "New Window" launcher, so there's no separate persistent
 * Tools rail to duplicate it) and a contextual inspector owned by
 * whichever window currently has focus (replaces the global right
 * sidebar inside the Workspace only — see AppShell.tsx's
 * showRightPanel suppression).
 */
import { AnimatePresence, motion } from 'framer-motion';
import { spring, useAppStore } from '@aura/core';
import { WorkspaceCanvas } from '../ops/WorkspaceCanvas';
import { useLayoutStore } from '../ops/layoutStore';
import { hasInspector, InspectorContent } from '../ops/inspectors';

export function WorkspaceScreen() {
  const windows = useLayoutStore((s) => s.windows);
  const focusedWindowId = useLayoutStore((s) => s.focusedWindowId);
  const rightPanelOpen = useAppStore((s) => s.rightPanelOpen);

  const focusedKind = windows.find((w) => w.id === focusedWindowId)?.kind ?? null;
  const showInspector = rightPanelOpen && hasInspector(focusedKind);

  return (
    <div className="flex h-full min-h-full">
      <div className="min-w-0 flex-1">
        <WorkspaceCanvas />
      </div>
      <AnimatePresence initial={false}>
        {showInspector && (
          <motion.aside
            key="workspace-inspector"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: 300, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={spring.fluid}
            className="shrink-0 overflow-hidden border-l border-line bg-surface/70 backdrop-blur-xl"
          >
            <div className="relative h-full w-[300px] overflow-y-auto">
              <AnimatePresence mode="wait">
                {focusedKind && (
                  <motion.div
                    key={focusedKind}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -6 }}
                    transition={spring.smooth}
                  >
                    <InspectorContent kind={focusedKind} />
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </motion.aside>
        )}
      </AnimatePresence>
    </div>
  );
}
