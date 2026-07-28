import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { cn, popVariants, scrimVariants } from '@aura/core';
import type { Command } from '@aura/core';
import { Icon, type IconName } from '../icons/Icon';

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  commands: Command[];
  placeholder?: string;
  /** Recently-run command ids (most-recent first). Shown first when idle. */
  recentIds?: string[];
  /** Fired after a command runs — e.g. to record it as recent. */
  onRun?: (command: Command) => void;
}

/** Sections render in this order; anything else falls to the end, stable. */
const SECTION_ORDER = ['Recent', 'Actions', 'Navigate', 'Projects', 'View'];

const SECTION_ICON: Record<string, IconName> = {
  Recent: 'activity',
  Actions: 'command',
  Navigate: 'arrow-right',
  Projects: 'folder',
  View: 'layout',
};

/**
 * The command palette — the heart of the operating environment (⌘/Ctrl-K).
 * Keyboard-first, categorised, recent-aware. Future modules register
 * Commands and appear here for free; nothing about the shell changes.
 */
export function CommandPalette({
  open,
  onClose,
  commands,
  placeholder = 'Search actions, projects, knowledge…',
  recentIds = [],
  onRun,
}: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const q = query.trim().toLowerCase();

  const filtered = useMemo(() => {
    if (!q) return commands;
    return commands.filter((c) => {
      const hay = `${c.title} ${c.section} ${(c.keywords ?? []).join(' ')}`.toLowerCase();
      return q.split(' ').every((part) => hay.includes(part));
    });
  }, [q, commands]);

  // When idle, surface recent commands first (and drop them from their
  // normal section so nothing appears twice).
  const grouped = useMemo(() => {
    const showRecent = !q && recentIds.length > 0;
    const recentCmds = showRecent
      ? (recentIds.map((id) => commands.find((c) => c.id === id)).filter(Boolean) as Command[])
      : [];
    const recentSet = new Set(recentCmds.map((c) => c.id));
    const mainCmds = showRecent ? filtered.filter((c) => !recentSet.has(c.id)) : filtered;

    const map = new Map<string, Command[]>();
    mainCmds.forEach((c) => {
      const arr = map.get(c.section) ?? [];
      arr.push(c);
      map.set(c.section, arr);
    });

    const ordered = [...map.entries()].sort(
      (a, b) =>
        (SECTION_ORDER.indexOf(a[0]) + 1 || 99) - (SECTION_ORDER.indexOf(b[0]) + 1 || 99),
    );
    return showRecent ? ([['Recent', recentCmds], ...ordered] as [string, Command[]][]) : ordered;
  }, [q, filtered, recentIds, commands]);

  const flat = useMemo(() => grouped.flatMap(([, cmds]) => cmds), [grouped]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => setActive(0), [query]);

  // Keep the active row in view as you arrow through.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  useEffect(() => {
    if (!open) return;
    const exec = (cmd: Command) => {
      cmd.run();
      onRun?.(cmd);
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((a) => Math.min(a + 1, flat.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((a) => Math.max(a - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const cmd = flat[active];
        if (cmd) exec(cmd);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, flat, active, onClose, onRun]);

  if (typeof document === 'undefined') return null;

  const runCommand = (cmd: Command) => {
    cmd.run();
    onRun?.(cmd);
    onClose();
  };

  let runningIndex = -1;

  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[150] flex items-start justify-center p-6 pt-[13vh]">
          <motion.div
            variants={scrimVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            onClick={onClose}
            className="absolute inset-0 bg-scrim backdrop-blur-md"
          />
          <motion.div
            variants={popVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            className="relative w-full max-w-xl overflow-hidden rounded-3xl border border-line bg-surface/95 shadow-lg backdrop-blur-2xl"
          >
            {/* Search field */}
            <div className="flex items-center gap-3 border-b border-line px-5">
              <Icon name="search" size={18} className="text-accent" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={placeholder}
                className="h-[54px] w-full bg-transparent text-[15px] text-text outline-none placeholder:text-text-subtle"
              />
              <kbd className="rounded-md border border-line px-1.5 py-0.5 text-[10px] text-text-subtle">ESC</kbd>
            </div>

            {/* Results */}
            <div ref={listRef} className="max-h-[52vh] overflow-y-auto p-2">
              {flat.length === 0 ? (
                <div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
                  <span className="grid h-11 w-11 place-items-center rounded-2xl bg-surface-active text-text-subtle">
                    <Icon name="search" size={20} />
                  </span>
                  <div className="text-[13px] text-text-muted">No matches for “{query}”.</div>
                </div>
              ) : (
                grouped.map(([section, cmds]) => (
                  <div key={section} className="mb-1">
                    <div className="flex items-center gap-1.5 px-3 py-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-text-subtle">
                      <Icon name={SECTION_ICON[section] ?? 'dot'} size={12} />
                      {section}
                    </div>
                    {cmds.map((cmd) => {
                      runningIndex += 1;
                      const idx = runningIndex;
                      const isActive = idx === active;
                      return (
                        <button
                          key={`${section}:${cmd.id}`}
                          data-idx={idx}
                          onMouseMove={() => setActive(idx)}
                          onClick={() => runCommand(cmd)}
                          className={cn(
                            'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors',
                            isActive ? 'bg-accent-50 dark:bg-accent/15' : 'hover:bg-surface-hover',
                          )}
                        >
                          <span
                            className={cn(
                              'grid h-8 w-8 place-items-center rounded-lg transition-colors',
                              isActive ? 'bg-accent text-white' : 'bg-surface-active text-text-muted',
                            )}
                          >
                            <Icon name={cmd.icon as IconName} size={16} />
                          </span>
                          <span className="flex-1 text-[13.5px] font-medium text-text">{cmd.title}</span>
                          {cmd.shortcut && (
                            <span className="flex gap-1">
                              {cmd.shortcut.map((k) => (
                                <kbd
                                  key={k}
                                  className="rounded-md border border-line bg-surface px-1.5 py-0.5 text-[10px] text-text-subtle"
                                >
                                  {k}
                                </kbd>
                              ))}
                            </span>
                          )}
                          <AnimatePresence>
                            {isActive && !cmd.shortcut && (
                              <motion.span
                                initial={{ opacity: 0, x: -4 }}
                                animate={{ opacity: 1, x: 0 }}
                                exit={{ opacity: 0 }}
                                className="text-text-subtle"
                              >
                                <Icon name="arrow-right" size={15} />
                              </motion.span>
                            )}
                          </AnimatePresence>
                        </button>
                      );
                    })}
                  </div>
                ))
              )}
            </div>

            {/* Footer — keyboard legend reinforces the keyboard-first ethos. */}
            <div className="flex items-center justify-between border-t border-line px-4 py-2.5 text-[11px] text-text-subtle">
              <div className="flex items-center gap-1.5">
                <AuraDot />
                <span>AURA Command</span>
              </div>
              <div className="flex items-center gap-3">
                <Legend keys={['↑', '↓']} label="Navigate" />
                <Legend keys={['↵']} label="Open" />
                <Legend keys={['esc']} label="Close" />
              </div>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

function Legend({ keys, label }: { keys: string[]; label: string }) {
  return (
    <span className="flex items-center gap-1">
      {keys.map((k) => (
        <kbd key={k} className="rounded border border-line bg-surface px-1 py-0.5 text-[10px] leading-none">
          {k}
        </kbd>
      ))}
      <span>{label}</span>
    </span>
  );
}

function AuraDot() {
  return <span className="h-1.5 w-1.5 rounded-full bg-accent" />;
}
