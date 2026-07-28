import { useEffect } from 'react';

export interface HotkeyOptions {
  meta?: boolean; // ⌘ on mac / Ctrl on win — normalized below
  shift?: boolean;
  alt?: boolean;
  /** Fire even when focus is in an input/textarea. */
  allowInInput?: boolean;
}

/**
 * useHotkey — declarative global keyboard shortcut.
 * `meta: true` matches ⌘ on macOS and Ctrl elsewhere, which is what
 * users of a cross-platform "OS" expect.
 */
export function useHotkey(key: string, handler: (e: KeyboardEvent) => void, opts: HotkeyOptions = {}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inField = target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
      if (inField && !opts.allowInInput) return;

      const metaMatch = opts.meta ? e.metaKey || e.ctrlKey : !(e.metaKey || e.ctrlKey);
      const shiftMatch = opts.shift ? e.shiftKey : !e.shiftKey;
      const altMatch = opts.alt ? e.altKey : !e.altKey;

      if (e.key.toLowerCase() === key.toLowerCase() && metaMatch && shiftMatch && altMatch) {
        handler(e);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [key, handler, opts.meta, opts.shift, opts.alt, opts.allowInInput]);
}
