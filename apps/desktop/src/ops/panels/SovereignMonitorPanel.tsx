import { useEffect, useState } from 'react';
import { centralAgentClient } from '../../ai/centralAgentClient';

type JournalEntry = { host: string; decision: string; sovereign_block: boolean; timestamp: string };
type Snapshot = { total: number; blocked: number; entries: JournalEntry[] };

export default function SovereignMonitorPanel() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  const poll = () => {
    centralAgentClient.networkJournal()
      .then((s) => { setSnap(s); setError(null); })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'unavailable'));
  };

  useEffect(() => {
    poll();
    const id = setInterval(poll, 5000);
    return () => clearInterval(id);
  }, []);

  const allLocal = snap !== null && snap.blocked === 0;
  const badge = snap === null ? 'bg-surface-active text-fg-muted' : allLocal ? 'bg-fg-success text-white' : 'bg-fg-danger text-white';
  const label = snap === null ? '—' : allLocal ? 'All local' : `${snap.blocked} blocked`;

  return (
    <div className="flex h-full flex-col gap-3 p-3 text-sm">
      <div className="flex items-center justify-between">
        <span className="font-medium text-fg-base">Sovereign Network Monitor</span>
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${badge}`}>{label}</span>
      </div>

      {error && <p className="rounded-lg bg-surface-active px-3 py-2 text-xs text-fg-danger">{error}</p>}

      {snap && (
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-xl bg-surface-subtle px-3 py-2 text-center">
            <div className="text-2xl font-semibold text-fg-base">{snap.total}</div>
            <div className="text-xs text-fg-muted">Total calls</div>
          </div>
          <div className="rounded-xl bg-surface-subtle px-3 py-2 text-center">
            <div className={`text-2xl font-semibold ${snap.blocked > 0 ? 'text-fg-danger' : 'text-fg-success'}`}>{snap.blocked}</div>
            <div className="text-xs text-fg-muted">Blocked</div>
          </div>
        </div>
      )}

      {snap && snap.entries.length > 0 && (
        <div className="flex-1 overflow-y-auto">
          <p className="mb-1 text-xs font-medium text-fg-muted">Recent calls</p>
          <ul className="space-y-1">
            {[...snap.entries].reverse().slice(0, 50).map((e, i) => (
              <li key={i} className="flex items-center justify-between gap-2 rounded-lg bg-surface-subtle px-3 py-1.5">
                <span className="truncate font-mono text-xs text-fg-base">{e.host}</span>
                <span className={`shrink-0 text-xs ${e.sovereign_block ? 'text-fg-danger' : 'text-fg-success'}`}>
                  {e.sovereign_block ? 'blocked' : e.decision}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {snap && snap.entries.length === 0 && (
        <p className="text-center text-xs text-fg-muted py-4">No AI network calls recorded yet.</p>
      )}

      <p className="text-xs text-fg-subtle text-right">Auto-refreshes every 5 s</p>
    </div>
  );
}
