import { useEffect, useRef } from 'react';
import type { AgentId } from './agentsClient';

/**
 * The sign-in page's terminal panel: runs one agent's own login in a real
 * pseudo-terminal in the desktop shell (src-tauri/src/pty.rs) and shows it here.
 * Only the shell can start it, and only for the six known agents.
 */
export function LoginTerminal({ agent, onExit }: { agent: AgentId; onExit: (code: number) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const exitRef = useRef(onExit);
  exitRef.current = onExit;

  useEffect(() => {
    if (!host.current) return;
    const el = host.current;
    let alive = true;
    const unlisten: (() => void)[] = [];
    // xterm touches browser globals when it loads, so it is loaded here, in the window only.
    let term: import('@xterm/xterm').Terminal | null = null;
    let fit: import('@xterm/addon-fit').FitAddon | null = null;
    const onWindowResize = () => fit?.fit();

    void (async () => {
      const [{ Terminal }, { FitAddon }, { invoke }, { listen }] = await Promise.all([
        import('@xterm/xterm'), import('@xterm/addon-fit'), import('@tauri-apps/api/core'), import('@tauri-apps/api/event'),
        import('@xterm/xterm/css/xterm.css'),
      ]);
      if (!alive) return;
      term = new Terminal({ fontSize: 13, cursorBlink: true, convertEol: true, theme: { background: '#0b0b0c' } });
      fit = new FitAddon();
      term.loadAddon(fit);
      term.open(el);
      fit.fit();
      window.addEventListener('resize', onWindowResize);
      const t = term;
      unlisten.push(await listen<{ agent: string; data: string }>('agent-login-output', (e) => {
        if (e.payload.agent === agent) t.write(e.payload.data);
      }));
      unlisten.push(await listen<{ agent: string; code: number }>('agent-login-exit', (e) => {
        if (e.payload.agent !== agent || !alive) return;
        t.write(`\r\n[sign-in finished${e.payload.code ? ` with code ${e.payload.code}` : ''}]\r\n`);
        exitRef.current(e.payload.code);
      }));
      const input = t.onData((data) => { void invoke('agent_login_write', { data }).catch(() => undefined); });
      unlisten.push(() => input.dispose());
      const resize = t.onResize(({ cols, rows }) => { void invoke('agent_login_resize', { cols, rows }).catch(() => undefined); });
      unlisten.push(() => resize.dispose());
      try {
        await invoke('agent_login_start', { agent, cols: t.cols, rows: t.rows });
      } catch (e) {
        t.write(`\r\nCould not start the sign-in: ${String(e)}\r\n`);
        exitRef.current(1);
      }
    })();

    return () => {
      alive = false;
      window.removeEventListener('resize', onWindowResize);
      unlisten.forEach((u) => u());
      void import('@tauri-apps/api/core').then(({ invoke }) => invoke('agent_login_stop')).catch(() => undefined);
      term?.dispose();
    };
  }, [agent]);

  return <div ref={host} data-testid="login-terminal" className="h-72 w-full overflow-hidden rounded-xl border border-white/10 bg-[#0b0b0c] p-2" />;
}
