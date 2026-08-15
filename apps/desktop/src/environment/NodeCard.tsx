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

import { memo } from 'react';
import { motion } from 'framer-motion';
import { cn, spring } from '@aura/core';
import { Icon } from '@aura/ui';
import { describeNode, isConnectable, type EnvironmentNode } from '@aura/connected-environment';
import { CATEGORY_ICON, STATUS_LABEL, STATUS_TONE, TONE_DOT, TONE_TEXT } from './presentation';

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
    </motion.div>
  );
});
