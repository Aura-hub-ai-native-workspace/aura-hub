import { useCallback, useEffect, useState } from 'react';
import { fetchAgentStatus, signInLabel, type AgentId, type AgentStatus } from './agentsClient';
import { LoginTerminal } from './LoginTerminal';

/**
 * The one sign-in page for every coding agent. Each row says how that agent
 * signs in (OpenCode Go, Kilo Gateway, Chrome, Radius) and opens its own login
 * in the terminal panel below. Claude Code is skipped by design. Status is
 * re-read from disk whenever a sign-in ends; nothing here is required.
 */
export function AgentsSignIn({ tone = 'dark' }: { tone?: 'dark' | 'app' }) {
  const [agents, setAgents] = useState<AgentStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<AgentId | null>(null);

  const refresh = useCallback(() => {
    fetchAgentStatus().then((a) => { setAgents(a); setError(null); }).catch((e) => setError(String(e?.message ?? e)));
  }, []);
  useEffect(refresh, [refresh]);

  const muted = tone === 'dark' ? 'text-white/55' : 'text-text-muted';
  const border = tone === 'dark' ? 'border-white/10 bg-white/[0.04]' : 'border-border bg-surface';

  return (
    <div data-testid="agents-signin" className="w-full">
      {error && <p className="mb-3 text-[12.5px] text-red-300">Could not read agent status: {error}</p>}
      <ul className="space-y-2">
        {(agents ?? []).map((a) => (
          <li key={a.id} data-testid={`signin-row-${a.id}`} className={`flex items-center justify-between gap-3 rounded-xl border px-4 py-3 ${border}`}>
            <div className="min-w-0">
              <div className="text-[14px] font-medium">{a.name}</div>
              <div className={`text-[12px] ${a.signedIn ? 'text-emerald-400' : muted}`}>{signInLabel(a)}</div>
            </div>
            {a.installed && a.signIn !== 'skipped' && (
              <button
                type="button"
                disabled={active !== null && active !== a.id}
                onClick={() => setActive(active === a.id ? null : a.id)}
                className="shrink-0 rounded-full border border-current/20 px-3.5 py-1.5 text-[12.5px] hover:bg-white/10 disabled:opacity-40"
              >
                {active === a.id ? 'Close' : a.signedIn ? 'Sign in again' : `Sign in with ${a.signIn}`}
              </button>
            )}
          </li>
        ))}
        {agents === null && !error && <li className={`text-[13px] ${muted}`}>Checking your agents…</li>}
      </ul>
      {active && (
        <div className="mt-4">
          {agents?.find((a) => a.id === active)?.hint && (
            <p className={`mb-2 text-[12.5px] ${muted}`}>{agents.find((a) => a.id === active)!.hint}</p>
          )}
          <LoginTerminal key={active} agent={active} onExit={() => { setActive(null); refresh(); }} />
        </div>
      )}
    </div>
  );
}
