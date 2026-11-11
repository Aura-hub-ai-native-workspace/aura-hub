import { useEffect, useState } from 'react';
import { Card, CardHeader } from '@aura/ui';
import { listCrashRecords, type CrashRecord } from './crashRecords';

const SOURCE: Record<string, string> = {
  shell: 'App',
  window: 'Window',
  service: 'Background service',
};

/** Settings → Updates: problems recorded on this computer. */
export function CrashRecordsPanel() {
  const [records, setRecords] = useState<CrashRecord[] | null>(null);
  useEffect(() => { void listCrashRecords().then(setRecords); }, []);
  if (records === null) return null; // not the desktop app
  return (
    <Card>
      <CardHeader title="Problems recorded" subtitle="Kept on this computer only. Nothing is sent." />
      {records.length === 0 ? (
        <p className="pt-3 text-[12.5px] text-text-subtle">No problems recorded.</p>
      ) : (
        <ul className="divide-y divide-line pt-2" data-testid="crash-records">
          {records.map((r) => (
            <li key={r.file} className="py-2 text-[12px]">
              <div className="flex items-center justify-between gap-3">
                <span className="font-medium text-text">{SOURCE[r.source] ?? r.source}</span>
                <span className="shrink-0 text-text-subtle">{new Date(r.atMs).toLocaleString()}</span>
              </div>
              <p className="mt-0.5 truncate text-text-muted">{r.summary}</p>
              <p className="mt-0.5 select-all truncate font-mono text-[11px] text-text-subtle">{r.file}</p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
