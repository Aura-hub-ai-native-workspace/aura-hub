import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { cn, popVariants, scrimVariants } from '@aura/core';
import { Icon } from '@aura/ui';
import type { IconName } from '@aura/ui';
import { PANEL_META, useLayoutStore, type LayoutNode, type PanelKind } from './layoutStore';

/**
 * WindowSwitcher — ⌘⇧K. A focused, arrow-navigable list of every window
 * currently open (docked tabs across the whole split tree, plus floating
 * panels) — distinct from the general ⌘K command palette, which searches
 * every tool whether it's open or not.
 */
interface WindowEntry {
  kind: PanelKind;
  location: 'docked' | 'floating';
  leafId?: string;
  floatingId?: string;
}

function collectDocked(node: LayoutNode | null, out: WindowEntry[]): void {
  if (!node) return;
  if (node.kind === 'leaf') {
    for (const kind of node.tabs) out.push({ kind, location: 'docked', leafId: node.id });
    return;
  }
  collectDocked(node.first, out);
  collectDocked(node.second, out);
}

export function WindowSwitcher({ open, onClose }: { open: boolean; onClose: () => void }) {
  const root = useLayoutStore((s) => s.root);
  const floating = useLayoutStore((s) => s.floating);
  const setActive = useLayoutStore((s) => s.setActive);
  const [index, setIndex] = useState(0);

  const entries = useMemo(() => {
    const out: WindowEntry[] = [];
    collectDocked(root, out);
    for (const f of floating) out.push({ kind: f.kind, location: 'floating', floatingId: f.id });
    return out;
  }, [root, floating]);

  useEffect(() => {
    if (open) setIndex(0);
  }, [open]);

  const select = (entry: WindowEntry) => {
    // Docked tabs get real focus (setActive). Floating panels have no
    // stacking/bring-to-front concept yet (see Phase 4's own note) — since
    // they already render as an always-visible overlay, closing the
    // switcher is enough to reveal one; a real "bring to front" is a
    // reasonable follow-up, not attempted here.
    if (entry.location === 'docked' && entry.leafId) setActive(entry.leafId, entry.kind);
    onClose();
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setIndex((i) => Math.min(i + 1, entries.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const entry = entries[index];
        if (entry) select(entry);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, entries, index]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[110] flex justify-center pt-[18vh]">
          <motion.div
            variants={scrimVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            onClick={onClose}
            className="absolute inset-0 bg-scrim backdrop-blur-sm"
          />
          <motion.div
            variants={popVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            role="listbox"
            aria-label="Open windows"
            className="relative h-fit w-full max-w-sm overflow-hidden rounded-2xl border border-line bg-surface shadow-lg"
          >
            <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-text-subtle">Open windows</span>
              <kbd className="rounded-md border border-line bg-surface-active px-1.5 py-0.5 text-[10px] text-text-subtle">Esc</kbd>
            </div>
            {entries.length === 0 ? (
              <div className="px-4 py-8 text-center text-[12.5px] text-text-muted">No windows are open yet.</div>
            ) : (
              <div className="max-h-[50vh] overflow-y-auto py-1">
                {entries.map((entry, i) => {
                  const meta = PANEL_META[entry.kind];
                  return (
                    <button
                      key={`${entry.kind}:${entry.leafId ?? entry.floatingId}`}
                      onClick={() => select(entry)}
                      onMouseEnter={() => setIndex(i)}
                      className={cn(
                        'flex w-full items-center gap-2.5 px-4 py-2 text-left text-[13px] transition-colors',
                        i === index
                          ? 'bg-accent/10 text-accent-700 dark:text-accent-200'
                          : 'text-text hover:bg-surface-hover',
                      )}
                    >
                      <Icon name={meta.icon as IconName} size={14} />
                      <span className="flex-1 truncate">{meta.label}</span>
                      {entry.location === 'floating' && (
                        <Icon name="panel" size={12} className="text-text-subtle" />
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
