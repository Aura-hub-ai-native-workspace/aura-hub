import { useCallback, useEffect, useState } from 'react';
import { Button, Card, CardHeader } from '@aura/ui';
import { PageBlock, PageContainer } from '../PageContainer';
import { AI_BASE, backendFetch } from '../../backend/backendSession';

interface Usage {
  total: number;
  entries: { name: string; bytes: number }[];
}

/** What the folders in the AURA home are, in plain words. */
const LABELS: Record<string, string> = {
  index: 'Project search indexes (rebuilt when a project opens)',
  gov: 'Agent run records',
  'laya-venv': 'Laya runtime',
  conversations: 'Conversations',
  'conversations-workspace': 'Workspace conversations',
  missions: 'Missions',
  'workflow-runs': 'Automation runs',
  logs: 'Logs',
  'engineering-memory': 'Engineering memory',
  worktrees: 'Agent worktrees',
};

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

/** Settings → Storage: how much space AURA uses on this computer, and freeing it. */
export function StorageTab() {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [freed, setFreed] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await backendFetch(`${AI_BASE}/storage`);
      if (!res.ok) throw new Error(`The local service answered ${res.status}.`);
      setUsage(await res.json() as Usage);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const clean = async () => {
    setBusy(true);
    try {
      const res = await backendFetch(`${AI_BASE}/storage/clean`, { method: 'POST' });
      if (!res.ok) throw new Error(`The local service answered ${res.status}.`);
      const body = await res.json() as { freedBytes: number; usage: Usage };
      setFreed(body.freedBytes);
      setUsage(body.usage);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageContainer title="Storage" subtitle="Space AURA Hub uses on this computer.">
      <div className="grid grid-cols-12 gap-5">
        <PageBlock className="col-span-12 lg:col-span-7">
          <Card>
            <CardHeader
              title={usage ? `${formatBytes(usage.total)} in use` : 'Storage'}
              subtitle="Largest first. Your projects' own folders are not counted."
            />
            {error && <p className="pt-3 text-[12.5px] text-danger">{error}</p>}
            {!usage && !error && <p className="pt-3 text-[12.5px] text-text-subtle">Measuring…</p>}
            {usage && (
              <ul className="divide-y divide-line pt-2" data-testid="storage-list">
                {usage.entries.filter((e) => e.bytes > 0).slice(0, 12).map((e) => (
                  <li key={e.name} className="flex items-center justify-between gap-3 py-2 text-[12.5px]">
                    <span className="min-w-0 truncate text-text-muted">{LABELS[e.name] ?? e.name}</span>
                    <span className="shrink-0 tabular-nums text-text">{formatBytes(e.bytes)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </PageBlock>
        <PageBlock className="col-span-12 lg:col-span-5">
          <Card>
            <CardHeader title="Clean up" subtitle="Remove search indexes of projects you no longer have." />
            <p className="pt-3 text-[12.5px] leading-relaxed text-text-muted">
              AURA also does this on its own for indexes unused for two weeks. Conversations, memory and
              your project files are never removed.
            </p>
            <div className="flex items-center gap-3 pt-4">
              <Button onClick={() => void clean()} disabled={busy || !usage}>
                {busy ? 'Cleaning…' : 'Clean up'}
              </Button>
              {freed !== null && (
                <span className="text-[12.5px] text-text-subtle">
                  {freed > 0 ? `Freed ${formatBytes(freed)}.` : 'Nothing to remove.'}
                </span>
              )}
            </div>
          </Card>
        </PageBlock>
      </div>
    </PageContainer>
  );
}
