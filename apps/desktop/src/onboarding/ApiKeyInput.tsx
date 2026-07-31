import { useEffect, useRef, useState } from 'react';
import { motion, useAnimation } from 'framer-motion';
import { Icon, type IconName } from '@aura/ui';

export type KeyStatus = 'idle' | 'validating' | 'valid' | 'invalid';

export function ApiKeyInput({
  value,
  onChange,
  onSubmit,
  status,
  detectedName,
  detectedIcon,
  errorMessage,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  status: KeyStatus;
  detectedName?: string;
  detectedIcon?: IconName;
  errorMessage?: string;
  disabled?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  const controls = useAnimation();
  const prevStatus = useRef(status);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (status === 'invalid' && prevStatus.current !== 'invalid') {
      void controls.start({ x: [0, -9, 8, -6, 5, 0], transition: { duration: 0.45, ease: 'easeInOut' } });
    }
    prevStatus.current = status;
  }, [status, controls]);

  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) onChange(text.trim());
    } catch {
      inputRef.current?.focus();
    }
  };

  const borderColor =
    status === 'valid' ? 'rgba(52,211,153,0.55)' : status === 'invalid' ? 'rgba(248,113,113,0.55)' : 'rgba(255,255,255,0.12)';
  const glow =
    status === 'valid'
      ? '0 0 0 1px rgba(52,211,153,0.4), 0 0 34px -10px rgba(52,211,153,0.55)'
      : status === 'invalid'
        ? '0 0 0 1px rgba(248,113,113,0.4), 0 0 34px -10px rgba(248,113,113,0.5)'
        : '0 0 0 1px rgba(255,255,255,0.06)';

  return (
    <div>
      <motion.div
        animate={controls}
        className="flex items-center gap-2 rounded-2xl border bg-white/[0.04] px-3 py-2.5 backdrop-blur-xl transition-colors"
        style={{ borderColor, boxShadow: glow }}
      >
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-white/[0.06] text-white/60">
          <Icon name={detectedIcon ?? 'cpu'} size={16} />
        </span>

        <input
          ref={inputRef}
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && onSubmit()}
          placeholder="Paste your API key…"
          disabled={disabled}
          spellCheck={false}
          autoComplete="off"
          className="min-w-0 flex-1 bg-transparent text-[14px] text-white placeholder:text-white/30 focus:outline-none disabled:opacity-50"
        />

        {value && (
          <button onClick={() => onChange('')} className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-white/40 transition-colors hover:bg-white/10 hover:text-white" aria-label="Clear key">
            <Icon name="close" size={14} />
          </button>
        )}
        <button onClick={() => setVisible((v) => !v)} className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-white/40 transition-colors hover:bg-white/10 hover:text-white" aria-label={visible ? 'Hide key' : 'Show key'}>
          <Icon name={visible ? 'eye-off' : 'eye'} size={15} />
        </button>
        <button onClick={paste} className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-white/40 transition-colors hover:bg-white/10 hover:text-white" aria-label="Paste from clipboard">
          <Icon name="clipboard" size={14} />
        </button>

        <div className="grid h-8 w-8 shrink-0 place-items-center">
          {status === 'validating' && <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/20 border-t-white/70" />}
          {status === 'valid' && (
            <motion.span initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: 'spring', stiffness: 420, damping: 22 }} className="grid h-6 w-6 place-items-center rounded-full bg-emerald-400/20 text-emerald-300">
              <Icon name="check" size={13} />
            </motion.span>
          )}
          {status === 'invalid' && (
            <motion.span initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: 'spring', stiffness: 420, damping: 22 }} className="grid h-6 w-6 place-items-center rounded-full bg-red-400/20 text-red-300">
              <Icon name="close" size={13} />
            </motion.span>
          )}
        </div>
      </motion.div>

      <div className="mt-2 flex min-h-[18px] items-center justify-between px-1 text-[11.5px]">
        <span className={status === 'invalid' ? 'text-red-300/90' : 'text-white/35'}>
          {status === 'invalid' ? (errorMessage ?? 'Could not validate this key.') : detectedName ? `Detected: ${detectedName}` : 'We auto-detect the provider from your key.'}
        </span>
        {status === 'valid' && <span className="font-medium text-emerald-300">Valid — ready to activate</span>}
      </div>
    </div>
  );
}
