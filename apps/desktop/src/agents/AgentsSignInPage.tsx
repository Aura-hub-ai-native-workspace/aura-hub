import { useCallback, useEffect, useState } from 'react';
import { AuraLogo } from '../brand/AuraLogo';
import { fetchAgentStatus, removeAgentFromWorkspace, runAgentSetup, type AgentId, type AgentStatus } from './agentsClient';
import { useAgentChoice } from './agentChoice';
import { LoginTerminal } from './LoginTerminal';

/** How each agent signs in, in plain words. */
const METHOD: Record<AgentId, string> = {
  opencode: 'OpenCode Go account',
  'kilo-code': 'Kilo Gateway account',
  freebuff: 'Freebuff account in your browser',
  'claude-code': 'Anthropic account — sign in later',
  'codex-cli': 'ChatGPT account in your browser',
  agy: 'Google account in your browser',
  pi: 'Radius account',
};

const MONO: Record<AgentId, string> = {
  opencode: 'OC', 'kilo-code': 'K', freebuff: 'FB', 'claude-code': 'CC', 'codex-cli': 'CX', agy: 'AG', pi: 'PI',
};

type Phase = 'connected' | 'pending' | 'later' | 'missing';
const phaseOf = (a: AgentStatus): Phase =>
  !a.installed ? 'missing' : a.signIn === 'skipped' ? 'later' : a.signedIn ? 'connected' : 'pending';

const ASSURANCES = [
  ['Each agent signs in with its own provider', 'OpenCode Go, Kilo Gateway, ChatGPT, Google, Radius — the provider’s own sign-in, nothing in between.'],
  ['Your credentials stay on this device', 'Each agent stores its own sign-in locally. AURA only checks whether one exists.'],
  ['One shared context', 'Every connected agent reads and writes the same common-context, so work carries over.'],
] as const;

function Badge({ phase }: { phase: Phase }) {
  const map: Record<Phase, [string, string]> = {
    connected: ['Connected', 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'],
    pending: ['Not connected', 'border-white/10 bg-white/[0.04] text-white/60'],
    later: ['Later', 'border-white/10 bg-transparent text-white/45'],
    missing: ['Not installed', 'border-amber-500/30 bg-amber-500/10 text-amber-300'],
  };
  const [label, cls] = map[phase];
  return <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11.5px] font-medium ${cls}`}>{label}</span>;
}

/**
 * The one sign-in page for AURA's coding agents.
 *
 * A conventional, two-column account page: what this is and why it is safe on
 * the left; the accounts on the right, one row per agent, with the provider's
 * real sign-in opening inline under the row. Claude Code is deferred by design.
 * Agents can be removed from the workspace and others added from the same card.
 */
export function AgentsSignInPage({ onContinue, onSkip, continueLabel = 'Continue' }: {
  onContinue: () => void;
  onSkip?: () => void;
  continueLabel?: string;
}) {
  const [agents, setAgents] = useState<AgentStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<AgentId | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const available = useAgentChoice((s) => s.available);
  const loadChoice = useAgentChoice((s) => s.load);

  const refresh = useCallback(() => {
    void loadChoice();
    fetchAgentStatus().then((a) => { setAgents(a); setError(null); }).catch((e) => setError(String(e?.message ?? e)));
  }, [loadChoice]);

  const remove = async (id: AgentId) => {
    setBusy(id);
    try { await removeAgentFromWorkspace(id); refresh(); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };
  const add = async (id: AgentId) => {
    setBusy(`add:${id}`);
    let failed: string | null = null;
    try {
      await runAgentSetup((e) => { if (e.agent === id && e.status === 'failed') failed = e.detail ?? 'setup failed'; }, undefined, id);
    } catch (e) { failed = (e as Error).message; }
    if (failed) setError(`Could not add ${id}: ${failed}`);
    setBusy(null);
    refresh();
  };
  useEffect(refresh, [refresh]);

  const eligible = (agents ?? []).filter((a) => phaseOf(a) !== 'later');
  const connected = eligible.filter((a) => a.signedIn).length;
  const pct = eligible.length ? Math.round((connected / eligible.length) * 100) : 0;

  return (
    <div className="fixed inset-0 z-[310] overflow-y-auto bg-[#0a0a0b] text-white" data-testid="agents-signin-page">
      <div className="mx-auto grid min-h-full w-full max-w-[1080px] grid-cols-1 items-start gap-10 px-8 py-14 md:grid-cols-12 md:py-20">
        {/* Left: what this is */}
        <aside className="md:col-span-5 md:pt-2">
          <div className="flex items-center gap-2.5">
            <AuraLogo size={22} />
            <span className="text-[13px] font-semibold tracking-[0.01em] text-white/80">AURA Hub</span>
          </div>
          <h1 className="mt-10 text-[30px] font-semibold leading-[1.15] tracking-[-0.02em]">Sign in to your agents</h1>
          <p className="mt-3 max-w-sm text-[14px] leading-relaxed text-white/55">
            Connect the coding agents AURA works with. You can connect them now or later from Settings.
          </p>
          <ul className="mt-10 space-y-6">
            {ASSURANCES.map(([title, body]) => (
              <li key={title} className="flex gap-3">
                <svg width="16" height="16" viewBox="0 0 16 16" className="mt-0.5 shrink-0 text-white/50" aria-hidden>
                  <path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <div>
                  <div className="text-[13.5px] font-medium text-white/90">{title}</div>
                  <div className="mt-0.5 text-[12.5px] leading-relaxed text-white/45">{body}</div>
                </div>
              </li>
            ))}
          </ul>
        </aside>

        {/* Right: accounts */}
        <section className="md:col-span-7">
          <div className="rounded-xl border border-white/10 bg-[#111113]">
            <div className="flex items-end justify-between border-b border-white/[0.07] px-6 pb-4 pt-5">
              <div>
                <h2 className="text-[15px] font-semibold">Accounts</h2>
                <p className="mt-0.5 text-[12.5px] text-white/45" data-testid="connected-count">
                  {agents ? `${connected} of ${eligible.length} connected` : 'Checking your agents…'}
                </p>
              </div>
              <div className="h-1 w-28 overflow-hidden rounded-full bg-white/[0.08]" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Agents connected">
                <div className="h-full rounded-full bg-white transition-[width] duration-500" style={{ width: `${pct}%` }} />
              </div>
            </div>

            {error && <p className="px-6 py-4 text-[12.5px] text-red-300">Could not read your agents: {error}</p>}

            <ul className="divide-y divide-white/[0.07]">
              {(agents ?? []).map((a) => {
                const phase = phaseOf(a);
                const open = active === a.id;
                const actionable = phase === 'pending' || phase === 'connected';
                return (
                  <li key={a.id} data-testid={`account-${a.id}`}>
                    <div className="flex items-center gap-4 px-6 py-4">
                      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-white/10 bg-white/[0.04] text-[12px] font-semibold tracking-[0.02em] text-white/80" aria-hidden>
                        {MONO[a.id]}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-[14px] font-medium">{a.name}</span>
                          <Badge phase={phase} />
                        </div>
                        <div className="mt-0.5 truncate text-[12.5px] text-white/45">{METHOD[a.id]}</div>
                      </div>
                      {!open && (
                        <button type="button" onClick={() => remove(a.id)} disabled={busy !== null || active !== null}
                          aria-label={`Remove ${a.name} from the workspace`}
                          className="shrink-0 text-[12px] font-medium text-white/40 hover:text-white/80 disabled:opacity-40">
                          {busy === a.id ? 'Removing…' : 'Remove'}
                        </button>
                      )}
                      {actionable && (
                        <button
                          type="button"
                          onClick={() => setActive(open ? null : a.id)}
                          disabled={active !== null && !open}
                          aria-expanded={open}
                          className={phase === 'pending' && !open
                            ? 'shrink-0 rounded-md bg-white px-3.5 py-1.5 text-[12.5px] font-semibold text-black hover:bg-white/90 disabled:opacity-40'
                            : 'shrink-0 rounded-md border border-white/15 px-3.5 py-1.5 text-[12.5px] font-medium text-white/80 hover:bg-white/[0.06] disabled:opacity-40'}
                        >
                          {open ? 'Cancel' : phase === 'connected' ? 'Reconnect' : 'Sign in'}
                        </button>
                      )}
                    </div>
                    {open && (
                      <div className="border-t border-white/[0.07] bg-black/30 px-6 pb-5 pt-4">
                        <ol className="mb-3 space-y-1 text-[12.5px] text-white/60">
                          <li>1. Follow the {a.name} sign-in below{a.hint ? ` — ${a.hint}` : ''}.</li>
                          <li>2. If a browser window opens, approve access there, then return to AURA.</li>
                          <li>3. This row turns to Connected when the sign-in completes.</li>
                        </ol>
                        <LoginTerminal agent={a.id} onExit={() => { setActive(null); refresh(); }} />
                      </div>
                    )}
                  </li>
                );
              })}
              {agents === null && !error && (
                Array.from({ length: 6 }, (_, i) => (
                  <li key={i} className="flex items-center gap-4 px-6 py-4" aria-hidden>
                    <span className="h-9 w-9 rounded-lg bg-white/[0.05]" />
                    <span className="h-3 w-40 rounded bg-white/[0.05]" />
                  </li>
                ))
              )}
            </ul>

            {available.length > 0 && (
              <div className="border-t border-white/[0.07] px-6 py-4" data-testid="add-agents">
                <div className="text-[12.5px] font-medium text-white/70">Add an agent</div>
                <div className="mt-2.5 flex flex-wrap gap-2">
                  {available.map((x) => (
                    <button key={x.id} type="button" onClick={() => add(x.id)} disabled={busy !== null || active !== null}
                      className="inline-flex items-center gap-1.5 rounded-md border border-white/15 px-3 py-1.5 text-[12.5px] text-white/80 hover:bg-white/[0.06] disabled:opacity-40">
                      <span aria-hidden>+</span>{busy === `add:${x.id}` ? `Adding ${x.name}…` : x.name}
                    </button>
                  ))}
                </div>
                <p className="mt-2 text-[11.5px] text-white/35">Adding installs the agent if needed and connects it to common-context.</p>
              </div>
            )}

            <div className="flex items-center justify-between border-t border-white/[0.07] px-6 py-4">
              {onSkip ? (
                <button type="button" onClick={onSkip} className="text-[12.5px] font-medium text-white/55 hover:text-white">Skip for now</button>
              ) : <span />}
              <button type="button" onClick={onContinue} disabled={active !== null}
                className="rounded-md bg-white px-4 py-2 text-[13px] font-semibold text-black hover:bg-white/90 disabled:opacity-40">
                {continueLabel}
              </button>
            </div>
          </div>
          <p className="mt-4 text-center text-[11.5px] text-white/35">
            Signing in uses each provider’s own terms and privacy policy.
          </p>
        </section>
      </div>
    </div>
  );
}
