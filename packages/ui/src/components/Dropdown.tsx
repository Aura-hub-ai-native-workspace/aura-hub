import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { cn, popVariants } from '@aura/core';
import { Icon } from '../icons/Icon';

export interface DropdownOption {
  value: string;
  label: string;
}

export interface DropdownProps {
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  size?: 'sm' | 'md';
  disabled?: boolean;
}

/** A value-selecting dropdown (the "select" primitive). Fully custom UI. */
export function Dropdown({ value, options, onChange, placeholder = 'Select…', className, size = 'md', disabled = false }: DropdownProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  return (
    <div ref={ref} className={cn('relative', className)}>
      <button
        onClick={() => !disabled && setOpen((o) => !o)}
        disabled={disabled}
        className={cn(
          'flex w-full items-center justify-between gap-2 rounded-xl border border-line bg-surface text-left transition-colors',
          'hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30',
          disabled && 'cursor-not-allowed opacity-50 hover:bg-surface',
          size === 'sm' ? 'h-8 px-3 text-[12px]' : 'h-9 px-3.5 text-[13px]',
        )}
      >
        <span className={cn('truncate', selected ? 'text-text' : 'text-text-subtle')}>
          {selected?.label ?? placeholder}
        </span>
        <Icon name="chevron-down" size={15} className={cn('text-text-muted transition-transform', open && 'rotate-180')} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.ul
            variants={popVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            className="absolute z-50 mt-2 max-h-64 w-full overflow-auto rounded-2xl border border-line bg-surface p-1.5 shadow-lg"
          >
            {options.map((opt) => (
              <li key={opt.value}>
                <button
                  onClick={() => {
                    onChange(opt.value);
                    setOpen(false);
                  }}
                  className={cn(
                    'flex w-full items-center justify-between rounded-xl px-2.5 py-2 text-left text-[13px] transition-colors hover:bg-surface-hover',
                    opt.value === value ? 'text-accent-700 dark:text-accent-200' : 'text-text',
                  )}
                >
                  {opt.label}
                  {opt.value === value && <Icon name="check" size={15} className="text-accent" />}
                </button>
              </li>
            ))}
          </motion.ul>
        )}
      </AnimatePresence>
    </div>
  );
}
