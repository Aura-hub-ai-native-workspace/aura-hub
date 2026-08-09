/**
 * NodeInspector — everything the Hub knows about one node.
 * ==================================================================
 * Opened in a floating window so several nodes can be inspected side by
 * side while the mission keeps running behind them. Shows identity,
 * capabilities, health, permissions, current work and the log — the full
 * contract from the domain's `EnvironmentNode`, with nothing summarized
 * away and nothing added that was not measured.
 */

import type { ReactNode } from 'react';
import { cn } from '@aura/core';
import { Icon } from '@aura/ui';
import {
  describeCapability,
  describeNode,
  isConnectable,
  type EnvironmentNode,
  type NodePermissions,
} from '@aura/connected-environment';
import { STATUS_LABEL, STATUS_TONE, TONE_DOT, TONE_TEXT } from './presentation';

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

  return (
    <div className="space-y-3 p-3">
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
        {!connectable ? null : node.connected ? (
          <button
            onClick={onDisconnect}
            className="rounded-lg border border-line px-2.5 py-1 text-[11px] font-medium text-text-muted transition-colors hover:border-line-strong hover:text-text"
          >
            Disconnect
          </button>
        ) : (
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
