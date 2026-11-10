import { useEffect, useRef, useState } from 'react';

/**
 * The Code workspace's terminal: the user's own shell, started in the project
 * folder by the desktop shell (src-tauri/src/shell.rs) and shown with xterm.
 *
 * One shell per mount. The panel keeps this mounted while it is collapsed or
 * another tab is showing, so the shell (and whatever runs in it) survives
 * those; it ends when the project's Code view closes, or with "Restart".
 */
export function ProjectTerminal({ cwd, visible }: { cwd: string; visible: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const fitRef = useRef<(() => void) | null>(null);
  const [generation, setGeneration] = useState(0);
  const [ended, setEnded] = useState<number | null>(null);
  const inDesktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

  useEffect(() => {
    if (!host.current || !inDesktop) return;
    const el = host.current;
    let alive = true;
    let id: number | null = null;
    const cleanups: (() => void)[] = [];
    // xterm touches browser globals when it loads, so it is loaded here, in the window only.
    let term: import('@xterm/xterm').Terminal | null = null;
    setEnded(null);

    void (async () => {
      const [{ Terminal }, { FitAddon }, { invoke }, { listen }] = await Promise.all([
        import('@xterm/xterm'), import('@xterm/addon-fit'), import('@tauri-apps/api/core'), import('@tauri-apps/api/event'),
        import('@xterm/xterm/css/xterm.css'),
      ]);
      if (!alive) return;
      const t = new Terminal({
        fontSize: 12.5,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
        cursorBlink: true,
        scrollback: 5000,
        theme: { background: '#0b0b0c' },
      });
      term = t;
      const fit = new FitAddon();
      t.loadAddon(fit);
      t.open(el);
      const refit = () => {
        // A hidden panel has no size; fitting it would shrink the shell to nothing.
        if (el.offsetWidth > 0 && el.offsetHeight > 0) {
          try { fit.fit(); } catch { /* not laid out yet */ }
        }
      };
      fitRef.current = refit;
      refit();
      const observer = new ResizeObserver(refit);
      observer.observe(el);
      cleanups.push(() => observer.disconnect());

      // Output can arrive before `shell_start` returns the id, so it is held until then.
      const early: { id: number; data: string }[] = [];
      cleanups.push(await listen<{ id: number; data: string }>('shell-output', (e) => {
        if (id === null) early.push(e.payload);
        else if (e.payload.id === id) t.write(e.payload.data);
      }));
      cleanups.push(await listen<{ id: number; code: number }>('shell-exit', (e) => {
        if (e.payload.id !== id || !alive) return;
        t.write(`\r\n\x1b[2m[process exited${e.payload.code ? ` with code ${e.payload.code}` : ''}]\x1b[0m\r\n`);
        id = null;
        setEnded(e.payload.code);
      }));
      const input = t.onData((data) => {
        if (id !== null) void invoke('shell_write', { id, data }).catch(() => undefined);
      });
      cleanups.push(() => input.dispose());
      const resize = t.onResize(({ cols, rows }) => {
        if (id !== null) void invoke('shell_resize', { id, cols, rows }).catch(() => undefined);
      });
      cleanups.push(() => resize.dispose());

      try {
        const started = await invoke<number>('shell_start', { cwd, cols: t.cols, rows: t.rows });
        if (!alive) {
          void invoke('shell_stop', { id: started }).catch(() => undefined);
          return;
        }
        id = started;
        for (const chunk of early) if (chunk.id === started) t.write(chunk.data);
        early.length = 0;
        if (visible) t.focus();
      } catch (e) {
        t.write(`\x1b[31mCould not start a terminal: ${String(e)}\x1b[0m\r\n`);
        setEnded(1);
      }
    })();

    return () => {
      alive = false;
      fitRef.current = null;
      cleanups.forEach((c) => c());
      const running = id;
      if (running !== null) void import('@tauri-apps/api/core').then(({ invoke }) => invoke('shell_stop', { id: running })).catch(() => undefined);
      term?.dispose();
    };
    // `visible` is read once for the first focus only; showing or hiding must not restart the shell.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, generation, inDesktop]);

  // Coming back into view: size the terminal to the panel it now has.
  useEffect(() => {
    if (visible) requestAnimationFrame(() => fitRef.current?.());
  }, [visible]);

  if (!inDesktop) {
    return (
      <p className="py-6 text-center text-[12px] text-text-subtle">
        The terminal runs in the AURA Hub desktop app.
      </p>
    );
  }

  return (
    <div className="relative h-full w-full" data-testid="project-terminal">
      <div ref={host} className="h-full w-full overflow-hidden rounded-lg bg-[#0b0b0c] p-2" />
      {ended !== null && (
        <button
          onClick={() => setGeneration((g) => g + 1)}
          className="absolute right-3 top-2 rounded-md border border-line bg-surface px-2 py-1 text-[11px] font-medium text-text-muted hover:text-text"
        >
          Restart terminal
        </button>
      )}
    </div>
  );
}
