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
  const canInstall = node.health.status === 'not-installed' && !!node.entry.install;
  const canUninstall = !isInternal && !!node.entry.install && node.health.status !== 'not-installed' && node.health.status !== 'installing' && node.health.status !== 'uninstalling';
  const rescan = useEnvironmentStore((s) => s.scan);
  const installDirect = useEnvironmentStore((s) => s.install);
  const uninstallDirect = useEnvironmentStore((s) => s.uninstall);
  const [installing, setInstalling] = useState(false);
  const [uninstalling, setUninstalling] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmUninstall, setConfirmUninstall] = useState(false);

  const handleInstall = async () => {
    if (installing || busy) return;
    setInstalling(true);
    try {
      // Direct human path — bypasses the AI approval gate. The click itself
      // is the authorization. Security (allow-list, argv-only, probe) still
      // runs in the Python backend. AI path remains via Fabric with approval.
      const res = await installDirect(node.id);
      const output = res.output as { installOutcome?: string } | undefined;
      if (output?.installOutcome === 'installed') {
        await rescan(true);
      }
    } catch {
      /* remain honest — a throw keeps the node not-installed */
    } finally {
      setInstalling(false);
    }
  };

  const handleUninstall = async () => {
    if (uninstalling || busy) return;
    setConfirmUninstall(false);
    setMenuOpen(false);
    setUninstalling(true);
    try {
      const res = await uninstallDirect(node.id);
      const output = res.output as { uninstallOutcome?: string } | undefined;
      if (output?.uninstallOutcome === 'uninstalled') {
        await rescan(true);
      }
    } catch {
      /* remain honest — a throw keeps the current state */
    } finally {
      setUninstalling(false);
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
          <>
            <button
              onClick={onDisconnect}
              className="rounded-lg border border-line px-2 py-1 text-[10.5px] font-medium text-text-muted transition-colors hover:border-line-strong hover:text-text"
            >
              Disconnect
            </button>
            {canUninstall && (
              <div className="relative">
                <button
                  onClick={() => setMenuOpen((v) => !v)}
                  disabled={busy || uninstalling}
                  data-testid="node-card-menu"
                  className="grid h-6 w-6 place-items-center rounded-lg text-text-subtle transition-colors hover:bg-surface-hover hover:text-text disabled:opacity-60"
                  title="More actions"
                >
                  ⋮
                </button>
                {menuOpen && (
                  <div className="absolute bottom-7 right-0 z-10 min-w-32 rounded-lg border border-line bg-surface p-1 shadow-lg">
                    <button
                      onClick={onConnect}
                      disabled={busy}
                      className="block w-full rounded-md px-2 py-1 text-left text-[11px] text-text-muted hover:bg-surface-hover hover:text-text"
                    >
                      Re-verify
                    </button>
                    <button
                      onClick={() => setConfirmUninstall(true)}
                      disabled={busy || uninstalling}
                      data-testid="node-card-uninstall"
                      className="block w-full rounded-md px-2 py-1 text-left text-[11px] text-attention hover:bg-surface-hover"
                    >
                      Uninstall
                    </button>
                  </div>
                )}
              </div>
            )}
          </>
        ) : node.health.status === 'installing' || installing ? (
          <button
            disabled
            data-testid="node-card-installing"
            data-install-state="installing"
            className="rounded-lg bg-accent px-2.5 py-1 text-[10.5px] font-medium text-white opacity-60"
          >
            Installing…
          </button>
        ) : node.health.status === 'uninstalling' || uninstalling ? (
          <button
            disabled
            data-testid="node-card-uninstalling"
            data-install-state="uninstalling"
            className="rounded-lg bg-accent px-2.5 py-1 text-[10.5px] font-medium text-white opacity-60"
          >
            Uninstalling…
          </button>
        ) : canInstall ? (
          <button
            onClick={handleInstall}
            disabled={busy || installing}
            data-testid="node-card-install"
            data-install-state={installing ? 'installing' : 'idle'}
            className="rounded-lg bg-accent px-2.5 py-1 text-[10.5px] font-medium text-white transition-colors hover:bg-accent-600 disabled:opacity-60"
          >
            {installing ? 'Installing…' : 'Install'}
          </button>
        ) : node.health.status === 'not-installed' ? (
          // Not installed and no verified install path — do not offer a
          // misleading Connect. The honest fallbacks are Details and Open site.
          <a
            href={node.entry.homepage}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-[10.5px] font-medium text-text-muted transition-colors hover:border-line-strong hover:text-text"
          >
            <Icon name="link" size={10} />
            Open site
          </a>
        ) : connectable ? (
          <>
            <button
              onClick={onConnect}
              disabled={busy}
              className="rounded-lg bg-accent px-2.5 py-1 text-[10.5px] font-medium text-white transition-colors hover:bg-accent-600 disabled:opacity-60"
            >
              {busy ? 'Checking…' : 'Connect'}
            </button>
            {canUninstall && (
              <div className="relative">
                <button
                  onClick={() => setMenuOpen((v) => !v)}
                  disabled={busy || uninstalling}
                  data-testid="node-card-menu"
                  className="grid h-6 w-6 place-items-center rounded-lg text-text-subtle transition-colors hover:bg-surface-hover hover:text-text disabled:opacity-60"
                  title="More actions"
                >
                  ⋮
                </button>
                {menuOpen && (
                  <div className="absolute bottom-7 right-0 z-10 min-w-32 rounded-lg border border-line bg-surface p-1 shadow-lg">
                    <button
                      onClick={onConnect}
                      disabled={busy}
                      className="block w-full rounded-md px-2 py-1 text-left text-[11px] text-text-muted hover:bg-surface-hover hover:text-text"
                    >
                      Re-verify
                    </button>
                    <button
                      onClick={() => setConfirmUninstall(true)}
                      disabled={busy || uninstalling}
                      data-testid="node-card-uninstall"
                      className="block w-full rounded-md px-2 py-1 text-left text-[11px] text-attention hover:bg-surface-hover"
                    >
                      Uninstall
                    </button>
                  </div>
                )}
              </div>
            )}
          </>
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
      {confirmUninstall && (
        <div className="mt-2 rounded-xl border border-attention/30 bg-attention/5 p-2.5" data-testid="node-card-uninstall-confirm">
          <p className="text-[11.5px] font-semibold text-text">Uninstall {node.entry.name}?</p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-text-muted">
            Remove {node.entry.name} from this machine.
          </p>
          <div className="mt-2 flex items-center gap-1.5">
            <button
              onClick={() => setConfirmUninstall(false)}
              disabled={uninstalling}
              className="rounded-lg border border-line px-2.5 py-1 text-[11px] font-medium text-text-muted transition-colors hover:border-line-strong hover:text-text disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              onClick={handleUninstall}
              disabled={uninstalling || busy}
              data-testid="node-card-uninstall-confirm"
              className="rounded-lg bg-attention px-2.5 py-1 text-[11px] font-medium text-white transition-colors hover:opacity-90 disabled:opacity-60"
            >
              {uninstalling ? 'Uninstalling…' : 'Uninstall'}
            </button>
          </div>
        </div>
      )}
    </motion.div>
  );
});
