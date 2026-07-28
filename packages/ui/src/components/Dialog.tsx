import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { cn, popVariants, scrimVariants } from '@aura/core';
import { IconButton } from './IconButton';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const SIZES = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl' } as const;

/** Centered modal with scrim, focus trap-lite (Esc to close) and portal. */
export function Dialog({ open, onClose, title, description, children, footer, size = 'md', className }: DialogProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[100] grid place-items-center p-6">
          <motion.div
            variants={scrimVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            onClick={onClose}
            className="absolute inset-0 bg-scrim backdrop-blur-sm"
          />
          <motion.div
            role="dialog"
            aria-modal="true"
            variants={popVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            className={cn(
              'relative w-full rounded-3xl border border-line bg-surface shadow-lg',
              SIZES[size],
              className,
            )}
          >
            {(title || description) && (
              <div className="flex items-start justify-between gap-4 p-6 pb-4">
                <div>
                  {title && <h2 className="text-[16px] font-semibold text-text">{title}</h2>}
                  {description && <p className="mt-1 text-[13px] text-text-muted">{description}</p>}
                </div>
                <IconButton icon="close" label="Close" size="sm" onClick={onClose} />
              </div>
            )}
            {children && <div className="px-6 pb-2 text-[13px] text-text">{children}</div>}
            {footer && <div className="flex justify-end gap-2 p-6 pt-4">{footer}</div>}
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
