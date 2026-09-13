import { cn } from '@aura/core';
import { Icon } from '@aura/ui';
import type { WorkerDescriptor } from '../../../ai/workerClient';
import { workerReadiness } from '../../../workspace/useWorkers';
import { GlassCard } from './GlassCard';

/**
 * WorkerRail — AURA's real AI workers, shown honestly.
 *
 * These cards used to be decorative: six capability tiles with invented
 * role labels ("Reasoning", "Multimodal") whose dot turned green when a
 * binary existed on the machine. A binary existing proves nothing about
 * whether AURA can hand that runtime a task and get a real answer back,
 * so the dot was a claim AURA had not earned.
 *
 * Now every card renders exactly what the backend proved:
 *   • CONNECTED  — AURA dispatched to this runtime and received a real,
 *                  correlated result. Nothing else earns the word.
 *   • the governance tier, which is a separate question: a worker can be
 *     genuinely connected while AURA cannot supervise its actions in
 *     real time, and saying so is the point.
 *   • an honest reason when it is not connected.
 *
 * Presentational only. Connecting is a backend operation that runs a
 * real round-trip; this component just asks for it and waits.
 */

const GOV_LABEL: Record<string, string> = {
  FULLY_GOVERNED: 'Governed in real time',
  CONNECTED_FOR_BASIC_WORK: 'Connected · not governed live',
  UNSUPPORTED: 'No live governance for this runtime',
  NOT_CONNECTED: '',
};

const REASON_LABEL: Record<string, string> = {
  NOT_INSTALLED: 'Not installed',
  RUNTIME_UNAVAILABLE: 'Runtime unavailable',
  ADAPTER_UNKNOWN: 'Unknown runtime',
  INVOCATION_FAILED: 'Could not be run',
  NO_RESPONSE: 'No response',
  RESPONSE_UNCORRELATED: 'No correlated result',
  TIMEOUT: 'Did not answer in time',
  GOVERNANCE_UNSUPPORTED: 'Governance unavailable',
};

function WorkerCard({
  worker,
  busy,
  activity,
  onConnect,
  onDisconnect,
}: {
  worker: WorkerDescriptor;
  busy: boolean;
  /** Live lifecycle from the agent run, when this worker holds a task. */
  activity: string | null;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  const state = busy ? 'CONNECTING' : activity ?? worker.lifecycle;
  const live = !!activity && activity !== 'IDLE' && activity !== 'CONNECTED';
  const tone = worker.connected
    ? worker.governance === 'FULLY_GOVERNED' ? 'positive' : 'attention'
    : 'neutral';

  return (
    <div
      data-testid="worker-card"
      data-worker-id={worker.id}
      data-connected={worker.connected}
      data-governance={worker.governance}
      data-lifecycle={state}
      className="flex flex-col gap-1.5 rounded-md border border-[rgba(125,146,255,0.25)] bg-[rgba(13,19,38,0.85)] px-2.5 py-2.5"
    >
      <div className="flex items-center gap-2">
        <span className="relative grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-white/5 bg-black/30 text-text">
          <Icon name="cpu" size={14} />
          {live && <span className="aura-live absolute inset-0 text-neon-cyan" aria-hidden />}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-text">
          {worker.name}
        </span>
        <span
          className={cn(
            'h-1.5 w-1.5 shrink-0 rounded-full',
            tone === 'positive' ? 'bg-neon-success'
              : tone === 'attention' ? 'bg-neon-warning' : 'bg-white/25',
          )}
          aria-hidden
        />
      </div>

      <span
        className={cn(
          'text-[10.5px] font-semibold uppercase tracking-wide',
          worker.connected ? 'text-neon-success' : 'text-text-subtle',
        )}
      >
        {busy ? 'Proving…' : worker.connected ? 'Connected' : 'Not connected'}
      </span>

      {worker.connected ? (
        <span className="text-[10.5px] text-text-muted">
          {live ? state : GOV_LABEL[worker.governance] || ''}
        </span>
      ) : (
        <span className="text-[10.5px] text-text-muted">
          {REASON_LABEL[worker.reason] ??
            (worker.installed ? 'Never proved' : 'Not installed')}
        </span>
      )}

      {worker.connected ? (
        <button
          type="button"
          onClick={onDisconnect}
          data-testid="worker-disconnect"
          className="neon-focus mt-0.5 rounded px-1 py-0.5 text-left text-[10.5px] text-text-subtle transition-colors hover:text-text"
        >
          Disconnect
        </button>
      ) : (
        <button
          type="button"
          onClick={onConnect}
          disabled={busy || !worker.installed}
          data-testid="worker-connect"
          title={
            worker.installed
              ? 'Prove AURA can dispatch to this worker and receive a real result'
              : worker.installDetail || 'Not installed on this machine'
          }
          className="neon-focus mt-0.5 rounded px-1 py-0.5 text-left text-[10.5px] text-neon-blue transition-colors hover:text-text disabled:cursor-not-allowed disabled:text-text-subtle disabled:opacity-60"
        >
          {worker.installed ? 'Connect' : 'Unavailable'}
        </button>
      )}
    </div>
  );
}

export function WorkerRail({
  workers,
  loading,
  connecting,
  error,
  activity,
  onRefresh,
  onConnect,
  onDisconnect,
}: {
  workers: WorkerDescriptor[];
  loading: boolean;
  connecting: string[];
  error: string | null;
  /** worker node id → live lifecycle, from the agent's own events. */
  activity: Map<string, string>;
  onRefresh: () => void;
  onConnect: (id: string) => void;
  onDisconnect: (id: string) => void;
}) {
  const counts = workerReadiness(workers);

  return (
    <GlassCard className="p-3" data-testid="worker-rail">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-widest text-text-subtle">
          AI Workers
        </span>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          data-testid="worker-refresh"
          className="neon-focus inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] font-medium text-text-muted transition-colors hover:text-text disabled:opacity-50"
        >
          <Icon name="refresh" size={12} />
          {loading ? 'Reading…' : 'Refresh'}
        </button>
      </div>

      {error && (
        <p role="alert" data-testid="worker-error" className="mb-2 rounded-md border border-[rgba(255,93,122,0.45)] bg-[rgba(255,93,122,0.1)] px-2.5 py-1.5 text-[11px] text-neon-danger">
          {error}
        </p>
      )}

      <div className="grid grid-cols-2 gap-2" role="list" aria-label="AI workers">
        {workers.length === 0 && !loading && !error && (
          <p className="col-span-2 py-2 text-center text-[11.5px] text-text-subtle">
            No workers are described by this installation.
          </p>
        )}
        {workers.map((w) => (
          <div key={w.id} role="listitem">
            <WorkerCard
              worker={w}
              busy={connecting.includes(w.id)}
              activity={activity.get(w.id) ?? null}
              onConnect={() => onConnect(w.id)}
              onDisconnect={() => onDisconnect(w.id)}
            />
          </div>
        ))}
      </div>

      <p
        data-testid="worker-readiness"
        className="mt-2.5 border-t border-white/5 pt-2 text-[10.5px] text-text-subtle"
      >
        <span className="font-semibold text-neon-success">{counts.connected}</span>
        {' of '}
        <span className="font-semibold">{counts.total}</span> connected
        {counts.governed > 0 && (
          <>
            {' · '}
            <span className="font-semibold text-neon-success">{counts.governed}</span> governed live
          </>
        )}
        {counts.missing > 0 && (
          <>
            {' · '}
            <span className="font-semibold text-neon-warning">{counts.missing}</span> not installed
          </>
        )}
      </p>
    </GlassCard>
  );
}
