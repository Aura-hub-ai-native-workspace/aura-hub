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
import type { InstallResultView } from '../ai/fabricClient';
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
      <UninstallPanel node={node} />

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
 *    This panel calls the store's direct human path (`environmentClient`
 *    → Python `/environment/install`), never the Fabric. No AI approval
 *    gate is shown for a direct click. Agent requests still travel
 *    `fabricClient.invoke('system.install')` → policy → approval, and a
 *    human click never grants an agent anything.
 *
 * 2. A `guided` result means AURA ran NOTHING — it is a handoff to the
 *    user, not a failure, and rendering it as an error would misreport
 *    what happened. So every branch below keys off `installOutcome`,
 *    never off a generic ok/failed flag.
 */
function InstallPanel({ node }: { node: EnvironmentNode }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<InstallResultView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const rescan = useEnvironmentStore((s) => s.scan);
  const installDirect = useEnvironmentStore((s) => s.install);

  const spec = node.entry.install;
  const missing = node.health.status === 'not-installed';

  // Nothing to offer: either it is already here, or AURA has no verified
  // way to install it. Both are honest silences rather than a dead button.
  if (!missing || !spec) return null;

  const install = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    setAttempted(true);
    try {
      // Direct human path — the click itself is the authorization.
      // No AI approval gate is shown here. Security (allow-list, argv-only,
      // probe verification) still runs in the Python backend.
      const res = await installDirect(node.id);
      if (res.outcome === 'denied' || res.outcome === 'unsupported') {
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
      {!result && (
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

function UninstallPanel({ node }: { node: EnvironmentNode }) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rescan = useEnvironmentStore((s) => s.scan);
  const uninstallDirect = useEnvironmentStore((s) => s.uninstall);

  const isInstalled = node.health.status !== 'not-installed' && node.health.status !== 'installing' && node.health.status !== 'uninstalling';
  if (!isInstalled || !node.entry.install || node.entry.transport === 'internal') return null;
  if (node.health.status === 'uninstalling') {
    return (
      <section data-testid="node-uninstall" className="rounded-xl border border-line bg-surface-active p-2.5">
        <p className="text-[11.5px] text-text-muted">Uninstalling… Verifying removal…</p>
      </section>
    );
  }

  const uninstall = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await uninstallDirect(node.id);
      const output = res.output as { uninstallOutcome?: string } | undefined;
      if (output?.uninstallOutcome === 'uninstalled') {
        setResult(`${node.entry.name} was removed.`);
        void rescan(true);
      } else {
        setError(res.detail || 'Removal could not be verified.');
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <section data-testid="node-uninstall" className="rounded-xl border border-line bg-surface-active p-2.5">
      {!confirming && !result && !error && (
        <div className="flex items-center gap-2">
          <button
            onClick={() => setConfirming(true)}
            disabled={busy}
            data-testid="node-uninstall-start"
            className="rounded-lg border border-line px-2.5 py-1 text-[11px] font-medium text-text-muted transition-colors hover:border-line-strong hover:text-text disabled:opacity-60"
          >
            Uninstall {node.entry.name}
          </button>
          <span className="text-[10.5px] text-text-subtle">Removes it from this machine, then verifies.</span>
        </div>
      )}
      {confirming && (
        <div data-testid="node-uninstall-confirm">
          <p className="text-[11.5px] font-semibold text-text">Uninstall {node.entry.name}?</p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-text-muted">Remove {node.entry.name} from this machine.</p>
          <div className="mt-2 flex items-center gap-1.5">
            <button
              onClick={() => setConfirming(false)}
              disabled={busy}
              className="rounded-lg border border-line px-2.5 py-1 text-[11px] font-medium text-text-muted disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              onClick={uninstall}
              disabled={busy}
              data-testid="node-uninstall-confirm"
              className="rounded-lg bg-attention px-2.5 py-1 text-[11px] font-medium text-white disabled:opacity-60"
            >
              {busy ? 'Uninstalling…' : 'Uninstall'}
            </button>
          </div>
        </div>
      )}
      {result && <p className="text-[11.5px] text-positive">{result}</p>}
      {error && <p className="text-[11.5px] text-attention">{error}</p>}
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
