/**
 * NodeInspector — everything the Hub knows about one node.
 * ==================================================================
 * Opened in a floating window so several nodes can be inspected side by
 * side while the mission keeps running behind them. Shows identity,
 * capabilities, health, permissions, current work and the log — the full
 * contract from the domain's `EnvironmentNode`, with nothing summarized
 * away and nothing added that was not measured.
 */

import { useState, type ReactNode } from 'react';
import { cn } from '@aura/core';
import { Icon } from '@aura/ui';
import {
  describeCapability,
  describeNode,
  isConnectable,
  type EnvironmentNode,
  type NodePermissions,
} from '@aura/connected-environment';
import { fabricClient, type InstallResultView } from '../ai/fabricClient';
import { STATUS_LABEL, STATUS_TONE, TONE_DOT, TONE_TEXT } from './presentation';
import { useEnvironmentStore } from './environmentStore';

const TRANSPORT_EXPLAINER: Record<EnvironmentNode['entry']['transport'], string> = {
  internal: 'Runs inside AURA Hub. No network, no credentials, no quota.',
  'local-process': 'Reached by running its command on this machine. Your code never leaves the device.',
  http: 'Reached over a local HTTP endpoint.',
  'api-key': 'Reached with a key you supply. Connect it once in AI Settings and the Hub reuses it.',
  oauth: 'Would need an account connection. No connector has been built for this service yet.',
};

export function NodeInspector({
  node,
  busy,
  onConnect,
  onDisconnect,
  onPermissions,
}: {
  node: EnvironmentNode;
  busy: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  onPermissions: (partial: Partial<NodePermissions>) => void;
}) {
  const phrase = describeNode(node);
  const tone = STATUS_TONE[node.health.status];
  const connectable = isConnectable(node.entry);
  const canInstall = node.health.status === 'not-installed' && !!node.entry.install;
  const isInstalling = node.health.status === 'installing';

  return (
    <div className="space-y-3 p-3">
      <InstallPanel node={node} />

      {/* identity + health */}
      <section>
        <div className="flex items-center gap-2">
          <span className={cn('h-2 w-2 rounded-full', TONE_DOT[tone])} />
          <span className={cn('text-[12px] font-semibold', TONE_TEXT[tone])}>{STATUS_LABEL[node.health.status]}</span>
          {node.health.version && <span className="text-[11px] text-text-subtle">· {node.health.version}</span>}
          {node.health.latencyMs !== undefined && (
            <span className="ml-auto text-[10.5px] tabular-nums text-text-subtle">{node.health.latencyMs}ms</span>
          )}
        </div>
        <p className="mt-1.5 text-[12px] leading-relaxed text-text">{phrase.headline}</p>
        <p className="mt-0.5 text-[11.5px] leading-relaxed text-text-muted">{phrase.nextStep}</p>
      </section>

      <div className="flex flex-wrap items-center gap-1.5">
        {node.connected ? (
          <button
            onClick={onDisconnect}
            className="rounded-lg border border-line px-2.5 py-1 text-[11px] font-medium text-text-muted transition-colors hover:border-line-strong hover:text-text"
          >
            Disconnect
          </button>
        ) : isInstalling ? (
          <span
            data-testid="node-inspector-installing"
            className="rounded-lg bg-accent px-2.5 py-1 text-[11px] font-medium text-white opacity-60"
          >
            Installing…
          </span>
        ) : canInstall ? null : node.health.status === 'not-installed' ? null : !connectable ? null : (
          <button
            onClick={onConnect}
            disabled={busy}
            className="rounded-lg bg-accent px-2.5 py-1 text-[11px] font-medium text-white transition-colors hover:bg-accent-600 disabled:opacity-60"
          >
            {busy ? 'Checking…' : 'Connect'}
          </button>
        )}
        <a
          href={node.entry.homepage}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-[11px] font-medium text-text-muted transition-colors hover:border-line-strong hover:text-text"
        >
          <Icon name="link" size={11} />
          {new URL(node.entry.homepage).host}
        </a>
      </div>

      <Section label="What it does">
        <p className="text-[11.5px] leading-relaxed text-text-muted">{node.entry.summary}</p>
        <p className="mt-1.5 text-[11px] leading-relaxed text-text-subtle">{TRANSPORT_EXPLAINER[node.entry.transport]}</p>
      </Section>

      <Section label={`Capabilities · ${node.entry.capabilities.length}`}>
        <ul className="space-y-1">
          {node.entry.capabilities.map((cap) => (
            <li key={cap} className="flex items-start gap-1.5">
              <Icon name="dot" size={10} className="mt-1 shrink-0 text-accent" />
              <span className="text-[11.5px] leading-snug text-text-muted">
                <span className="font-medium text-text">{cap}</span> — {describeCapability(cap).toLowerCase()}
              </span>
            </li>
          ))}
        </ul>
      </Section>

      <Section label="Permissions">
        <p className="mb-2 text-[11px] leading-relaxed text-text-subtle">
          Least privilege by default. Nothing widens without you choosing it here.
        </p>
        <div className="space-y-1">
          <Permission label="Read project files" value={node.permissions.read} onChange={(read) => onPermissions({ read })} />
          <Permission label="Modify project files" value={node.permissions.write} onChange={(write) => onPermissions({ write })} />
          <Permission label="Run commands" value={node.permissions.execute} onChange={(execute) => onPermissions({ execute })} />
          <Permission label="Act without confirming each step" value={node.permissions.autonomous} onChange={(autonomous) => onPermissions({ autonomous })} />
        </div>
      </Section>

      {node.activity.length > 0 && (
        <Section label={`Running now · ${node.activity.length}`}>
          <ul className="space-y-1.5">
            {node.activity.map((a) => (
              <li key={a.id} className="rounded-lg border border-line bg-surface-active/50 p-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-[11.5px] font-medium text-text">{a.label}</span>
                  <span className="shrink-0 text-[10.5px] tabular-nums text-text-subtle">{a.progress}%</span>
                </div>
                <p className="mt-0.5 text-[10.5px] text-text-subtle">{a.state}</p>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section label={node.log.length ? `Log · ${node.log.length}` : 'Log'}>
        {node.log.length === 0 ? (
          <p className="text-[11px] text-text-subtle">Nothing recorded yet — the log fills as the Hub talks to this node.</p>
        ) : (
          <ul className="space-y-1">
            {[...node.log].reverse().slice(0, 12).map((entry) => (
              <li key={entry.id} className="flex items-start gap-1.5">
                <span
                  className={cn(
                    'mt-1 h-1.5 w-1.5 shrink-0 rounded-full',
                    entry.level === 'error' ? 'bg-danger' : entry.level === 'warn' ? 'bg-attention' : 'bg-text-subtle',
                  )}
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-[11px] leading-snug text-text-muted">{entry.message}</span>
                  <span className="block text-[10px] text-text-subtle">{new Date(entry.at).toLocaleTimeString()}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

/**
 * Installation, and the two rules that matter here.
 *
 * 1. Clicking this button IS the authorization.
 *
 *    The install used to travel `fabricClient.invoke`, which made it a
 *    *request* — and `system.modify` floors a request to
 *    `require-approval`, so the person who had just clicked "Install pnpm"
 *    was told to go to Mission Control and approve their own click. The
 *    floor was not wrong; the channel was. `invokeAsUser` presents the
 *    window's own token, policy sees an attested user action, and the
 *    consent the floor exists to obtain is the click that already
 *    happened. Nothing is skipped for a model: an agent asking for the
 *    same capability is gated exactly as before.
 *
 *    The precedent is `acceptMissionTask` — accepting a proposal is
 *    already treated as the operator's authorization for the write,
 *    derived server-side. This applies the same idea to a second button.
 *
 * 2. A `guided` result means AURA ran NOTHING — it is a handoff to the
 *    user, not a failure, and rendering it as an error would misreport
 *    what happened. So every branch below keys off `installOutcome`,
 *    never off the invocation's `ok`/`outcome`, which is `failed` for a
 *    guided result by the compatibility contract in §25.1.
 */
function InstallPanel({ node }: { node: EnvironmentNode }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<InstallResultView | null>(null);
  const [gate, setGate] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const rescan = useEnvironmentStore((s) => s.scan);

  const spec = node.entry.install;
  const missing = node.health.status === 'not-installed';

  // Nothing to offer: either it is already here, or AURA has no verified
  // way to install it. Both are honest silences rather than a dead button.
  if (!missing || !spec) return null;

  const install = async () => {
    setBusy(true);
    setError(null);
    setGate(null);
    setResult(null);
    setAttempted(true);
    try {
      const res = await fabricClient.invokeAsUser('system.install', { nodeId: node.id });
      if (res.outcome === 'awaiting-approval') {
        // Reachable, but no longer the ordinary path: browser preview has
        // no shell to mint a token, and an operator may have raised
        // `system.install` in workspace policy. Both are legitimate
        // reasons to still need an answer, so say so plainly rather than
        // pretending the click was enough.
        setGate('Your workspace policy asks for this to be approved separately. Open the approval gate to allow it.');
      } else if (res.outcome === 'denied' || res.outcome === 'unsupported') {
        setError(res.detail);
      } else {
        const output = (res.output as InstallResultView) ?? null;
        setResult(output);
        if (!res.output) setError(res.detail);
        // Verified present — bring the rest of the app's view of this
        // machine up to date without making the user go and press Scan.
        // Only on `installed`: a guided handoff installed nothing, and an
        // unverified run is precisely the case where re-probing already
        // failed.
        if (output?.installOutcome === 'installed') void rescan(true);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Every ending except success can be tried again, and the button says so.
  const retryable =
    attempted && !busy && (!!error || result?.installOutcome === 'failed' || result?.installOutcome === 'unverified');

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* Clipboard denied — the command is on screen and selectable anyway. */
    }
  };

  return (
    <section data-testid="node-install" className="rounded-xl border border-line bg-surface-active p-2.5">
      {!result && !gate && (
        <div className="flex items-center gap-2">
          <button
            onClick={install}
            disabled={busy}
            data-testid="node-install-start"
            data-install-state={busy ? 'installing' : 'idle'}
            className="rounded-lg bg-accent px-2.5 py-1 text-[11px] font-medium text-white transition-colors hover:bg-accent-600 disabled:opacity-60"
          >
            {busy ? `Installing ${node.entry.name}…` : `Install ${node.entry.name}`}
          </button>
          <span className="text-[10.5px] text-text-subtle">
            {spec.privilege === 'root'
              ? 'Needs administrator rights — AURA will show you the command to run.'
              : busy
                ? 'Running the installer now.'
                : 'Starts as soon as you click.'}
          </span>
        </div>
      )}

      {gate && (
        <p data-testid="node-install-gate" className="text-[11.5px] leading-relaxed text-accent">{gate}</p>
      )}

      {error && (
        <p data-testid="node-install-error" className="mt-1 text-[11.5px] leading-relaxed text-attention">{error}</p>
      )}

      {result?.installOutcome === 'guided' && (
        <div data-testid="node-install-guided" data-install-outcome="guided">
          <div className="flex items-center gap-1.5">
            <Icon name="link" size={12} className="text-attention" />
            <span className="text-[11.5px] font-semibold text-attention">Your action required</span>
          </div>
          <p className="mt-1 text-[11.5px] leading-relaxed text-text-muted">
            {result.why} AURA did not run anything.
          </p>
          <div className="mt-1.5 flex items-center gap-1.5">
            <code
              data-testid="node-install-command"
              className="min-w-0 flex-1 overflow-x-auto rounded-lg border border-line bg-surface px-2 py-1 font-mono text-[11px] text-text"
            >
              {result.command}
            </code>
            <button
              onClick={() => copy(result.command ?? '')}
              className="shrink-0 rounded-lg border border-line px-2 py-1 text-[11px] font-medium text-text-muted transition-colors hover:border-line-strong hover:text-text"
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-text-subtle">
            Run it in a terminal, then scan again — the Hub only calls {node.entry.name} available once it
            can actually find it.
          </p>
        </div>
      )}

      {result?.installOutcome === 'unverified' && (
        <p data-testid="node-install-unverified" data-install-outcome="unverified" className="text-[11.5px] leading-relaxed text-attention">
          The installer finished without an error, but {node.entry.name} still cannot be found — so AURA is
          not reporting it as installed. {result.probe?.detail}
        </p>
      )}

      {result?.installOutcome === 'failed' && (
        <p data-testid="node-install-failed" data-install-outcome="failed" className="text-[11.5px] leading-relaxed text-attention">
          {node.entry.name} was not installed. {result.why}
          {result.exitCode !== undefined && ` (exit ${result.exitCode})`}
        </p>
      )}

      {result?.installOutcome === 'installed' && (
        <p data-testid="node-install-installed" data-install-outcome="installed" className="text-[11.5px] leading-relaxed text-positive">
          {node.entry.name} is installed and verified
          {result.probe?.version ? ` (${result.probe.version})` : ''}. The environment has been refreshed.
        </p>
      )}

      {retryable && (
        <button
          onClick={install}
          data-testid="node-install-retry"
          className="mt-1.5 rounded-lg border border-line px-2 py-1 text-[11px] font-medium text-text-muted transition-colors hover:border-line-strong hover:text-text"
        >
          Try again
        </button>
      )}
    </section>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-surface-active/40 p-2.5">
      <h4 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-subtle">{label}</h4>
      {children}
    </section>
  );
}

function Permission({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!value)}
      className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-surface-hover"
    >
      <span
        className={cn(
          'grid h-4 w-4 shrink-0 place-items-center rounded border transition-colors',
          value ? 'border-accent bg-accent text-white' : 'border-line text-transparent',
        )}
      >
        <Icon name="check" size={9} />
      </span>
      <span className="text-[11.5px] text-text-muted">{label}</span>
    </button>
  );
}
