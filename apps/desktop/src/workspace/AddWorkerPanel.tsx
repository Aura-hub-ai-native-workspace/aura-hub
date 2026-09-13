import { useMemo, useState } from 'react';
import { cn } from '@aura/core';
import { Icon } from '@aura/ui';
import type { WorkerDescriptor } from '../ai/workerClient';

/**
 * Add AI Worker — the six runtimes AURA can delegate to, and what is
 * actually true about each on this machine.
 *
 * Opening this performs NO machine scan. The worker roster is already
 * known: `GET /workers` reports the backend's own verdict for each, and
 * that verdict is what every line below restates. "Connected" here means
 * the backend proved a dispatch and a correlated reply — the word is not
 * available to this component to grant.
 *
 * The action offered follows the state, and only the state: a connected
 * worker offers nothing to do, an installed-but-unconnected one offers
 * Connect, and one AURA has no verified way to drive offers a link to
 * the project rather than a button that would fail.
 *
 * When the panel is opened from a worker slot it also offers to PUT a
 * worker in that slot. That action is layout and nothing else: it does
 * not install, does not connect, and does not change what the backend
 * says about the runtime. Every row here comes from the curated adapter
 * roster the backend reports — this panel has no external search and no
 * way to turn a typed string into something AURA would run.
 */

const LIFECYCLE_TONE: Record<string, string> = {
  CONNECTED: 'border-[rgba(31,211,138,0.5)] bg-[rgba(31,211,138,0.12)] text-neon-success',
  DISCOVERED: 'border-[rgba(255,181,71,0.45)] bg-[rgba(255,181,71,0.1)] text-neon-warning',
  NOT_CONNECTED: 'border-white/12 bg-white/5 text-text-muted',
};

const REASON_LABEL: Record<string, string> = {
  NOT_INSTALLED: 'Not installed on this machine',
  RUNTIME_UNAVAILABLE: 'Runtime unavailable',
  ADAPTER_UNKNOWN: 'AURA has no verified way to drive this runtime',
  INVOCATION_FAILED: 'Could not be run',
  NO_RESPONSE: 'Did not answer',
  RESPONSE_UNCORRELATED: 'Replied, but produced no correlated work',
  TIMEOUT: 'Did not answer in time',
  GOVERNANCE_UNSUPPORTED: 'Real-time governance unavailable',
};

function WorkerRow({
  worker,
  busy,
  placed,
  slot,
  hasFreeSlot,
  onConnect,
  onDisconnect,
  onPlace,
}: {
  worker: WorkerDescriptor;
  busy: boolean;
  /** Already occupies one of the six workspace slots. */
  placed: boolean;
  /** The slot this panel was opened for, when it was opened from one. */
  slot: WorkerSlotContext | null;
  hasFreeSlot: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  onPlace?: () => void;
}) {
  const tone = LIFECYCLE_TONE[worker.lifecycle] ?? LIFECYCLE_TONE.NOT_CONNECTED;
  return (
    <li
      data-testid="add-worker-row"
      data-worker-id={worker.id}
      data-connected={worker.connected}
      className="rounded-xl border border-[rgba(125,146,255,0.22)] bg-[rgba(13,19,38,0.6)] px-4 py-3"
    >
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-[rgba(125,146,255,0.28)] bg-[rgba(10,16,34,0.9)] text-[13px] font-semibold text-[#8fb0ff]">
          {worker.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] font-semibold text-text">{worker.name}</span>
          <span className="block text-[11.5px] text-text-muted">
            {worker.capabilities?.includes('coding-agent') ? 'AI coding agent' : 'AI worker'}
          </span>
        </span>
        <span className={cn('shrink-0 rounded-full border px-2.5 py-1 text-[10.5px] font-semibold', tone)}>
          {worker.connected ? 'Connected' : worker.installed ? 'Detected' : 'Not installed'}
        </span>
      </div>

      <ul className="mt-2 space-y-0.5 text-[11.5px]">
        <li className="flex items-baseline gap-1.5">
          <span className={worker.installed ? 'text-neon-success' : 'text-text-subtle'}>
            {worker.installed ? '✓' : '○'}
          </span>
          <span className="text-text-muted">
            {worker.installed ? `Detected${worker.version ? ` · v${worker.version}` : ''}` : 'Not detected on this machine'}
          </span>
        </li>
        <li className="flex items-baseline gap-1.5">
          <span className={worker.connected ? 'text-neon-success' : 'text-text-subtle'}>
            {worker.connected ? '✓' : '○'}
          </span>
          <span className="text-text-muted">
            {worker.connected
              ? `Connected${worker.governance === 'FULLY_GOVERNED' ? ' · governed in real time' : ''}`
              : REASON_LABEL[worker.reason] ?? 'Not connected to AURA'}
          </span>
        </li>
      </ul>

      {!worker.connected && worker.detail && (
        <p className="mt-1.5 line-clamp-2 text-[11px] text-text-subtle">{worker.detail}</p>
      )}

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        {onPlace && (
          <button
            type="button"
            onClick={onPlace}
            disabled={placed || (!hasFreeSlot && !slot)}
            data-testid="add-worker-place"
            data-worker-id={worker.id}
            data-slot-index={slot ? slot.index : undefined}
            title={
              placed
                ? `${worker.name} is already in this workspace.`
                : slot
                  ? `Put ${worker.name} in worker slot ${slot.index + 1}${slot.name ? `, in place of ${slot.name}` : ''}. Nothing is installed or connected.`
                  : hasFreeSlot
                    ? `Put ${worker.name} in the first free worker slot. Nothing is installed or connected.`
                    : 'All 6 workspace worker slots are occupied.'
            }
            className="neon-focus rounded-lg border border-[rgba(122,92,255,0.5)] bg-[rgba(122,92,255,0.14)] px-3 py-1.5 text-[12px] font-semibold text-[#c9bcff] transition-colors hover:bg-[rgba(122,92,255,0.22)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {placed
              ? 'In workspace'
              : slot
                ? `Use in slot ${slot.index + 1}`
                : hasFreeSlot
                  ? 'Add to workspace'
                  : 'No free slot'}
          </button>
        )}
        {worker.connected ? (
          <>
            <span
              data-testid="add-worker-added"
              className="rounded-lg border border-[rgba(31,211,138,0.45)] bg-[rgba(31,211,138,0.1)] px-3 py-1.5 text-[12px] font-semibold text-neon-success"
            >
              Added
            </span>
            <button
              type="button"
              onClick={onDisconnect}
              disabled={busy}
              data-testid="add-worker-disconnect"
              title="Removes AURA's connection. It does not uninstall the software."
              className="neon-focus rounded-lg border border-[rgba(125,146,255,0.3)] px-3 py-1.5 text-[12px] text-text-muted transition-colors hover:text-text disabled:opacity-50"
            >
              Remove from AURA
            </button>
          </>
        ) : worker.installed ? (
          <button
            type="button"
            onClick={onConnect}
            disabled={busy}
            data-testid="add-worker-connect"
            className="neon-focus rounded-lg border border-[rgba(122,92,255,0.5)] bg-[rgba(122,92,255,0.14)] px-3 py-1.5 text-[12px] font-semibold text-[#c9bcff] transition-colors hover:bg-[rgba(122,92,255,0.22)] disabled:opacity-50"
          >
            {busy ? 'Connecting…' : 'Connect'}
          </button>
        ) : (
          // Not installed. AURA does not offer to install a worker from
          // here: that path runs through AURA Everything, where the
          // curated InstallSpec is what authorises it.
          <span data-testid="add-worker-unavailable" className="text-[11.5px] text-text-subtle">
            Install it through AURA Everything, or see the project's own instructions.
          </span>
        )}
      </div>
    </li>
  );
}

/** Which slot the panel was opened for, and what it currently holds. */
export interface WorkerSlotContext {
  index: number;
  /** The worker being replaced, when the slot is not empty. */
  name: string | null;
}

export function AddWorkerPanel({
  workers,
  connecting,
  error,
  slot = null,
  inWorkspace = [],
  hasFreeSlot = false,
  onConnect,
  onDisconnect,
  onPlace,
}: {
  workers: WorkerDescriptor[];
  connecting: string[];
  error: string | null;
  /** Set when the panel was opened from a worker slot. */
  slot?: WorkerSlotContext | null;
  /** Worker ids already holding a workspace slot. */
  inWorkspace?: string[];
  hasFreeSlot?: boolean;
  onConnect: (id: string) => void;
  onDisconnect: (id: string) => void;
  /** Puts a worker in a slot. Layout only — never an install or connect. */
  onPlace?: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? workers.filter((w) => w.name.toLowerCase().includes(q) || w.id.includes(q)) : workers;
  }, [workers, query]);

  return (
    <section aria-label="Add AI Worker" data-testid="add-worker-panel" className="flex min-h-0 flex-col gap-3">
      <div>
        <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-text">Add AI Worker</h2>
        <p className="text-[11.5px] text-text-muted">
          The runtimes AURA can delegate to, and what is true of each here.
        </p>
      </div>

      <label className="flex items-center gap-2 rounded-xl border border-[rgba(125,146,255,0.32)] bg-[rgba(13,19,38,0.85)] px-3 py-2.5 focus-within:border-[rgba(125,146,255,0.6)]">
        <Icon name="search" size={15} className="shrink-0 text-text-subtle" />
        <span className="sr-only">Search workers</span>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          data-testid="add-worker-search"
          placeholder="Search workers…"
          className="neon-focus min-w-0 flex-1 bg-transparent text-[13px] text-text outline-none placeholder:text-text-subtle"
        />
      </label>

      {slot && (
        <p
          data-testid="add-worker-replacing"
          className="rounded-lg border border-[rgba(122,92,255,0.4)] bg-[rgba(122,92,255,0.1)] px-3 py-2 text-[11.5px] text-[#c9bcff]"
        >
          {slot.name
            ? `Choosing a worker puts it in slot ${slot.index + 1}, in place of ${slot.name}. Nothing is uninstalled or disconnected.`
            : `Choosing a worker puts it in slot ${slot.index + 1}.`}
        </p>
      )}

      {onPlace && !slot && !hasFreeSlot && (
        <p
          data-testid="add-worker-full"
          className="rounded-lg border border-[rgba(255,181,71,0.42)] bg-[rgba(255,181,71,0.1)] px-3 py-2 text-[11.5px] text-neon-warning"
        >
          All 6 workspace worker slots are occupied. Use Replace on a worker in the
          graph to swap one.
        </p>
      )}

      {error && (
        <p role="alert" className="rounded-lg border border-[rgba(255,93,122,0.45)] bg-[rgba(255,93,122,0.1)] px-3 py-2 text-[12px] text-neon-danger">
          {error}
        </p>
      )}

      <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto">
        {shown.map((w) => (
          <WorkerRow
            key={w.id}
            worker={w}
            busy={connecting.includes(w.id)}
            placed={inWorkspace.includes(w.id)}
            slot={slot}
            hasFreeSlot={hasFreeSlot}
            onConnect={() => onConnect(w.id)}
            onDisconnect={() => onDisconnect(w.id)}
            onPlace={onPlace ? () => onPlace(w.id) : undefined}
          />
        ))}
        {shown.length === 0 && (
          <li className="py-6 text-center text-[12px] text-text-subtle">
            No worker matches that name.
          </li>
        )}
      </ul>
    </section>
  );
}
