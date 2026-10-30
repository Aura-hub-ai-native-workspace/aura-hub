/**
 * Connected Environment — a status table.
 * ------------------------------------------------------------------
 * What this machine has, as the machine reports it. AURA provisions what a
 * task needs on its own, under its own guard. A person can also connect a
 * detected local tool here: that runs the same verified probe and never installs
 * or removes anything. AI coding agents are not offered here (their readiness
 * handshake is separate).
 */
import { useEffect, useMemo, useState } from 'react';
import { Button, Icon } from '@aura/ui';
import { CATEGORY_LABEL } from './presentation';
import { useEnvironmentStore } from './environmentStore';
import { MACHINE_STATUSES, statusCounts, statusRows, unprobedCount, type MachineStatus, type StatusRow } from './environmentStatus';

const TONE: Record<MachineStatus, string> = {
  'Installed and available': 'bg-positive',
  'Installed but not connected': 'bg-accent',
  'Installed but unhealthy': 'bg-attention',
  'Not installed': 'bg-text-subtle',
  'Detection incomplete': 'bg-attention',
  Unknown: 'bg-text-subtle',
};

const when = (iso: string | null) => {
  if (!iso) return 'not checked';
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? 'not checked' : t.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
};

export function EnvironmentStatusTable({ rows, scanning, lastScanAt, error, unprobed = 0, onRecheck, onConnect, connecting = [] }: {
  rows: StatusRow[]; scanning: boolean; lastScanAt: string | null; error: string | null; unprobed?: number; onRecheck: () => void;
  /** Connect a detected local tool by id (a verified probe). Omitted means read-only. */
  onConnect?: (id: string) => void;
  connecting?: string[];
}) {
  const [filter, setFilter] = useState<MachineStatus | 'all'>('all');
  const counts = useMemo(() => statusCounts(rows), [rows]);
  const shown = filter === 'all' ? rows : rows.filter((r) => r.status === filter);
  return (
    <div className="mx-auto w-full max-w-[1100px] px-6 py-7" data-testid="environment-status">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-[20px] font-semibold tracking-[-0.01em] text-text">Connected Environment</h1>
          <p className="mt-1 max-w-xl text-[12.5px] text-text-muted">
            What this machine has, as it reports it. AURA sets up routine tools on its own when a task needs them;
            anything that needs your permission or sign-in is raised on the task, not here.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[11px] text-text-subtle">Last checked: {when(lastScanAt)}</span>
          <Button size="sm" variant="secondary" icon="refresh" loading={scanning} onClick={onRecheck}>Re-check</Button>
        </div>
      </div>

      {error && <div className="mt-4 rounded-xl border border-attention/30 bg-attention/5 px-3 py-2 text-[12px] text-text-muted">The last check did not finish: {error}</div>}

      <div className="mt-5 flex flex-wrap gap-1.5" role="tablist" aria-label="Filter by status">
        <button onClick={() => setFilter('all')} aria-pressed={filter === 'all'}
          className={`rounded-lg border px-2.5 py-1 text-[11.5px] ${filter === 'all' ? 'border-accent text-text' : 'border-line text-text-muted'}`}>All {rows.length}</button>
        {MACHINE_STATUSES.filter((s) => counts[s] > 0).map((s) => (
          <button key={s} onClick={() => setFilter(s)} aria-pressed={filter === s}
            className={`rounded-lg border px-2.5 py-1 text-[11.5px] ${filter === s ? 'border-accent text-text' : 'border-line text-text-muted'}`}>{s} {counts[s]}</button>
        ))}
      </div>

      <div className="mt-4 overflow-hidden rounded-xl border border-line">
        <table className="w-full text-left text-[12.5px]">
          <thead className="bg-surface-hover/60 text-[11px] uppercase tracking-wide text-text-subtle">
            <tr><th className="px-4 py-2.5 font-medium">Tool / capability</th><th className="px-4 py-2.5 font-medium">Machine status</th><th className="hidden px-4 py-2.5 font-medium md:table-cell">Details</th><th className="hidden px-4 py-2.5 font-medium lg:table-cell">Checked</th></tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id} className="border-t border-line" data-testid="env-row">
                <td className="px-4 py-2.5"><div className="font-medium text-text">{r.name}</div><div className="text-[11px] text-text-subtle">{(CATEGORY_LABEL as Record<string, string>)[r.category] ?? r.category}{r.version ? ` · ${r.version}` : ''}</div></td>
                <td className="px-4 py-2.5"><span className="inline-flex items-center gap-2 text-text"><span className={`h-2 w-2 rounded-full ${TONE[r.status]}`} />{r.status}</span>
                  {onConnect && r.connectable && r.status === 'Installed but not connected' && (
                    <Button size="sm" variant="secondary" className="ml-3" loading={connecting.includes(r.id)}
                      onClick={() => onConnect(r.id)} aria-label={`Connect ${r.name}`}>Connect</Button>
                  )}</td>
                <td className="hidden max-w-[360px] px-4 py-2.5 text-text-muted md:table-cell"><span className="line-clamp-2">{r.detail}</span></td>
                <td className="hidden px-4 py-2.5 text-[11.5px] text-text-subtle lg:table-cell">{when(r.checkedAt)}</td>
              </tr>
            ))}
            {shown.length === 0 && <tr><td colSpan={4} className="px-4 py-8 text-center text-text-subtle"><Icon name="search" size={14} className="mr-1.5 inline" />{rows.length ? 'Nothing with that status.' : 'No check has finished yet.'}</td></tr>}
          </tbody>
        </table>
      </div>
      {unprobed > 0 && (
        <p data-testid="env-unprobed" className="mt-3 text-[11.5px] text-text-subtle">
          {unprobed} catalogued {unprobed === 1 ? 'entry has' : 'entries have'} nothing to detect on this machine (or have not been probed), so {unprobed === 1 ? 'it is' : 'they are'} not listed.
        </p>
      )}
    </div>
  );
}

export function ConnectedEnvironment() {
  const nodes = useEnvironmentStore((s) => s.nodes);
  const scanning = useEnvironmentStore((s) => s.scanning);
  const lastScanAt = useEnvironmentStore((s) => s.lastScanAt);
  const scanError = useEnvironmentStore((s) => s.scanError);
  const scan = useEnvironmentStore((s) => s.scan);
  // Connect is the store's probe-only action: it never installs or removes anything.
  const connectNode = useEnvironmentStore((state) => state.connect);
  const connecting = useEnvironmentStore((s) => s.busy);
  // One check on first view. Statuses start unmeasured on every launch by design.
  useEffect(() => { void scan(); }, [scan]);
  const rows = useMemo(() => statusRows(nodes), [nodes]);
  const unprobed = useMemo(() => unprobedCount(nodes), [nodes]);
  return (
    <div className="h-full min-h-0 overflow-y-auto bg-app">
      <EnvironmentStatusTable rows={rows} scanning={scanning} lastScanAt={lastScanAt} error={scanError} unprobed={unprobed}
        onRecheck={() => void scan(true)} onConnect={(id) => void connectNode(id)} connecting={connecting} />
    </div>
  );
}
