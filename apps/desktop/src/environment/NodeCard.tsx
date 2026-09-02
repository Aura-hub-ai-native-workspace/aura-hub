/**
 * NodeCard — one connected system, alive on the canvas.
 * ==================================================================
 * The card is the atom of the environment view. It answers, at a glance:
 * what is this, is it here, what is it doing right now, and what is the
 * single next thing I could do with it.
 *
 * Deliberately not a workflow node. There are no ports, no wires and no
 * canvas graph — connecting boxes with lines is a *builder's* metaphor,
 * and the Hub's premise is that the user does not build the pipeline. The
 * card shows live state and running work instead, which is what someone
 * who delegated the work actually wants to see.
 */

import { memo, useState } from 'react';
import { motion } from 'framer-motion';
import { cn, spring } from '@aura/core';
import { Icon } from '@aura/ui';
import { describeNode, isConnectable, type EnvironmentNode } from '@aura/connected-environment';
import { CATEGORY_ICON, STATUS_LABEL, STATUS_TONE, TONE_DOT, TONE_TEXT } from './presentation';
import { useEnvironmentStore } from './environmentStore';
import type { InstallResultView } from '../ai/fabricClient';

interface NodeCardProps {
  node: EnvironmentNode;
  busy: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  onInspect: () => void;
}

export const NodeCard = memo(function NodeCard({ node, busy, onConnect, onDisconnect, onInspect }: NodeCardProps) {
  const phrase = describeNode(node);
  const tone = STATUS_TONE[node.health.status];
  const running = node.activity.filter((a) => a.state === 'running');
  const connectable = isConnectable(node.entry);
  const isInternal = node.entry.transport === 'internal';
  const storeInstall = useEnvironmentStore((s) => s.install);
  const [gate, setGate] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<InstallResultView | null>(null);
  const [installBusy, setInstallBusy] = useState(false);
  const hasInstallSpec = Boolean(node.entry.install);
  const isMissing = node.health.status === 'not-installed';
  const isInstalling = node.health.status === 'installing';

  const handleInstall = async () => {
    if (busy || isInstalling || installBusy) return;
    setGate(null);
    setError(null);
    setResult(null);
    setInstallBusy(true);
    try {
      const res = await storeInstall(node.id);
      if (res.outcome === 'awaiting-approval') {
        setGate('This needs your approval before anything runs. Open the approval gate to allow it.');
      } else if (res.outcome === 'denied' || res.outcome === 'unsupported') {
        setError(res.detail);
      } else {
        const out = res.output as InstallResultView | undefined;
        if (out) setResult(out);
        else if (res.detail) setError(res.detail);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setInstallBusy(false);
    }
  };

  return (
    <motion.div
      layout
      transition={spring.smooth}
      className={cn(
        'group relative flex flex-col rounded-2xl border bg-surface p-3 text-left transition-colors',
        node.connected ? 'border-line-strong' : 'border-line hover:border-line-strong',
      )}
    >
      <button onClick={onInspect} className="flex items-start gap-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent/50 rounded-lg">
        <span className={cn(
          'mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-xl border',
          node.connected ? 'border-accent/30 bg-accent/10 text-accent' : 'border-line bg-surface-active text-text-subtle',
        )}>
          <Icon name={CATEGORY_ICON[node.entry.category]} size={15} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-[13px] font-semibold text-text">{node.entry.name}</span>
            <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', TONE_DOT[tone])} />
          </span>
          <span className={cn('block truncate text-[11px]', TONE_TEXT[tone])}>
            {STATUS_LABEL[node.health.status]}
            {node.health.version ? ` · ${node.health.version}` : ''}
          </span>
        </span>
      </button>

      <p className="mt-2 line-clamp-2 text-[11px] leading-relaxed text-text-muted">{phrase.nextStep}</p>

      {running.length > 0 && (
        <div className="mt-2 space-y-1.5 rounded-xl border border-accent/25 bg-accent/5 p-2">
          {running.slice(0, 2).map((activity) => (
            <div key={activity.id}>
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-[10.5px] font-medium text-text">{activity.label}</span>
                <span className="shrink-0 text-[10px] tabular-nums text-text-subtle">{activity.progress}%</span>
              </div>
              <div className="mt-1 h-1 overflow-hidden rounded-full bg-surface-active">
                <motion.div
                  className="h-full rounded-full bg-accent"
                  initial={{ width: 0 }}
                  animate={{ width: `${activity.progress}%` }}
                  transition={spring.gentle}
                />
              </div>
            </div>
          ))}
          {running.length > 2 && (
            <p className="text-[10px] text-text-subtle">+{running.length - 2} more running</p>
          )}
        </div>
      )}

      <div className="mt-2.5 flex items-center gap-1.5">
        {isInternal ? (
          <span className="rounded-lg border border-line bg-surface-active px-2 py-1 text-[10.5px] font-medium text-text-subtle">
            Built in
          </span>
        ) : node.connected ? (
          <button
            onClick={onDisconnect}
            className="rounded-lg border border-line px-2 py-1 text-[10.5px] font-medium text-text-muted transition-colors hover:border-line-strong hover:text-text"
          >
            Disconnect
          </button>
        ) : isInstalling ? (
          <button
            disabled
            className="rounded-lg bg-accent px-2.5 py-1 text-[10.5px] font-medium text-white opacity-60"
            data-testid="node-card-installing"
          >
            Installing…
          </button>
        ) : isMissing ? (
          hasInstallSpec ? (
            <button
              onClick={handleInstall}
              disabled={busy || installBusy}
              data-testid="node-card-install"
              className="rounded-lg bg-accent px-2.5 py-1 text-[10.5px] font-medium text-white transition-colors hover:bg-accent-600 disabled:opacity-60"
            >
              {busy || installBusy ? 'Installing…' : 'Install'}
            </button>
          ) : (
            <span className="flex items-center gap-1.5">
              <span className="rounded-lg border border-line bg-surface-active px-2 py-1 text-[10.5px] font-medium text-text-subtle" data-testid="node-card-install-unavailable">
                Install unavailable
              </span>
              <a
                href={node.entry.homepage}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-[10.5px] font-medium text-text-muted transition-colors hover:border-line-strong hover:text-text"
              >
                <Icon name="link" size={10} />
                Open site
              </a>
            </span>
          )
        ) : connectable ? (
          <button
            onClick={onConnect}
            disabled={busy}
            className="rounded-lg bg-accent px-2.5 py-1 text-[10.5px] font-medium text-white transition-colors hover:bg-accent-600 disabled:opacity-60"
          >
            {busy ? 'Checking…' : 'Connect'}
          </button>
        ) : (
          // No Connect where connecting cannot work. An enabled button that
          // does nothing is the exact dishonesty this architecture removes.
          <a
            href={node.entry.homepage}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-[10.5px] font-medium text-text-muted transition-colors hover:border-line-strong hover:text-text"
          >
            <Icon name="link" size={10} />
            Open site
          </a>
        )}
        <button
          onClick={onInspect}
          className="ml-auto grid h-6 w-6 place-items-center rounded-lg text-text-subtle opacity-0 transition-all hover:bg-surface-hover hover:text-text group-hover:opacity-100"
          title={`Inspect ${node.entry.name}`}
        >
          <Icon name="maximize" size={11} />
        </button>
      </div>
      {isMissing && !hasInstallSpec && (
        <p data-testid="node-card-unavailable-reason" className="mt-1.5 text-[10.5px] leading-relaxed text-text-subtle">
          AURA has no verified way to install {node.entry.name} — it will not guess. See the project's site for instructions.
        </p>
      )}
      {isInstalling && (
        <div className="mt-1.5 space-y-1" data-testid="node-card-live-install">
          <p className="text-[10.5px] leading-relaxed text-text-subtle">Installing…</p>
          <div className="flex items-center gap-1 text-[10px] text-text-subtle">
            <span className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse" />
            <span>Preparing → Downloading → Installing → Verifying</span>
          </div>
        </div>
      )}
      {isMissing && hasInstallSpec && gate && (
        <p data-testid="node-card-gate" className="mt-1.5 text-[10.5px] leading-relaxed text-accent">{gate}</p>
      )}
      {(isMissing || isInstalling) && hasInstallSpec && error && (
        <p data-testid="node-card-error" className="mt-1.5 text-[10.5px] leading-relaxed text-attention">{error}</p>
      )}
      {hasInstallSpec && result && (
        <div className="mt-1.5 space-y-1">
          {result.installOutcome === 'guided' && (
            <div data-testid="node-card-guided" data-install-outcome="guided" className="rounded-lg border border-line bg-surface-active p-1.5">
              <p className="text-[10.5px] font-medium text-attention">Your action required</p>
              <p className="mt-0.5 text-[10.5px] leading-relaxed text-text-muted">{result.why} AURA did not run anything.</p>
              {result.command && (
                <code data-testid="node-card-command" className="mt-1 block overflow-x-auto rounded border border-line bg-surface px-1.5 py-1 font-mono text-[10px] text-text">{result.command}</code>
              )}
            </div>
          )}
          {result.installOutcome === 'unverified' && (
            <p data-testid="node-card-unverified" data-install-outcome="unverified" className="text-[10.5px] leading-relaxed text-attention">
              The installer finished but {node.entry.name} still cannot be found. {result.probe?.detail}
            </p>
          )}
          {result.installOutcome === 'failed' && (
            <p data-testid="node-card-failed" data-install-outcome="failed" className="text-[10.5px] leading-relaxed text-attention">
              {node.entry.name} was not installed. {result.why}{result.exitCode !== undefined ? ` (exit ${result.exitCode})` : ''}
            </p>
          )}
          {result.installOutcome === 'installed' && (
            <p data-testid="node-card-installed" data-install-outcome="installed" className="text-[10.5px] leading-relaxed text-positive">
              {node.entry.name} is installed and verified{result.probe?.version ? ` (${result.probe.version})` : ''}.
            </p>
          )}
        </div>
      )}
    </motion.div>
  );
});
