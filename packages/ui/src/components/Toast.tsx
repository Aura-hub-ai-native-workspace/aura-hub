import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { cn, spring } from '@aura/core';
import type { StatusTone } from '@aura/core';
import { Icon, type IconName } from '../icons/Icon';

interface Toast {
  id: string;
  title: string;
  description?: string;
  tone: StatusTone;
  icon?: IconName;
}

interface ToastCtx {
  push: (t: Omit<Toast, 'id'>) => void;
}
const Ctx = createContext<ToastCtx | null>(null);

const TONE_ICON: Record<StatusTone, IconName> = {
  positive: 'check',
  attention: 'bell',
  critical: 'close',
  info: 'spark',
  neutral: 'dot',
};

const TONE_ACCENT: Record<StatusTone, string> = {
  positive: 'text-positive',
  attention: 'text-attention',
  critical: 'text-danger',
  info: 'text-accent',
  neutral: 'text-text-muted',
};

/** Wrap the app once. Exposes `useToast().push(...)`. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((t: Omit<Toast, 'id'>) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((cur) => [...cur, { ...t, id }]);
    setTimeout(() => setToasts((cur) => cur.filter((x) => x.id !== id)), 4200);
  }, []);

  return (
    <Ctx.Provider value={{ push }}>
      {children}
      {typeof document !== 'undefined' &&
        createPortal(
          <div className="pointer-events-none fixed bottom-6 right-6 z-[200] flex w-[340px] flex-col gap-2.5">
            <AnimatePresence>
              {toasts.map((t) => (
                <motion.div
                  key={t.id}
                  layout
                  initial={{ opacity: 0, y: 20, scale: 0.96 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, x: 40, scale: 0.96 }}
                  transition={spring.smooth}
                  className="pointer-events-auto flex items-start gap-3 rounded-2xl border border-line bg-surface/90 p-3.5 shadow-lg backdrop-blur-xl"
                >
                  <span className={cn('mt-0.5', TONE_ACCENT[t.tone])}>
                    <Icon name={t.icon ?? TONE_ICON[t.tone]} size={18} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-semibold text-text">{t.title}</div>
                    {t.description && <div className="mt-0.5 text-[12px] text-text-muted">{t.description}</div>}
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>,
          document.body,
        )}
    </Ctx.Provider>
  );
}

export function useToast(): ToastCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useToast must be used within <ToastProvider>');
  return ctx;
}
