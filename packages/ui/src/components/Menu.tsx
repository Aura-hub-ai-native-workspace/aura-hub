import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { cn, popVariants } from '@aura/core';
import { Icon, type IconName } from '../icons/Icon';

export interface MenuItem {
  id: string;
  label: string;
  icon?: IconName;
  shortcut?: string;
  tone?: 'default' | 'danger';
  onSelect: () => void;
}

export interface MenuProps {
  trigger: ReactNode;
  items: (MenuItem | 'separator')[];
  align?: 'start' | 'end';
  className?: string;
}

/**
 * Dropdown menu (also serves as the base for context menus). Click-outside
 * and Escape close it; the trigger is any element you pass in.
 */
export function Menu({ trigger, items, align = 'start', className }: MenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className={cn('relative inline-flex', className)}>
      <span onClick={() => setOpen((o) => !o)}>{trigger}</span>
      <AnimatePresence>
        {open && (
          <motion.div
            variants={popVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            role="menu"
            className={cn(
              'absolute top-full z-50 mt-2 min-w-[200px] rounded-2xl border border-line bg-surface p-1.5 shadow-lg',
              align === 'end' ? 'right-0' : 'left-0',
            )}
          >
            {items.map((item, i) =>
              item === 'separator' ? (
                <div key={`sep-${i}`} className="my-1 h-px bg-line" />
              ) : (
                <button
                  key={item.id}
                  role="menuitem"
                  onClick={() => {
                    item.onSelect();
                    setOpen(false);
                  }}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-[13px] transition-colors',
                    item.tone === 'danger'
                      ? 'text-danger hover:bg-danger/10'
                      : 'text-text hover:bg-surface-hover',
                  )}
                >
                  {item.icon && <Icon name={item.icon} size={16} className="text-text-muted" />}
                  <span className="flex-1">{item.label}</span>
                  {item.shortcut && (
                    <span className="text-[11px] text-text-subtle">{item.shortcut}</span>
                  )}
                </button>
              ),
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
