/**
 * ToolPlacement — choose which of the machine's tools sit in the Workspace's
 * three slots. Layout only: it lists what is already detected and writes
 * nothing but the layout. There is no catalog and nothing to install or
 * connect here; a tool that is not on the machine is set up by AURA when a
 * task needs it.
 */
import { useMemo } from 'react';
import { Button } from '@aura/ui';
import { useEnvironmentStore } from './environmentStore';
import { statusRows } from './environmentStatus';

export function ToolPlacement({ onAddToWorkspace, inWorkspace = [], hasFreeSlot, replacing }: {
  onAddToWorkspace: (nodeId: string) => void;
  inWorkspace?: string[];
  hasFreeSlot: boolean;
  replacing?: { index: number; name: string } | null;
}) {
  const nodes = useEnvironmentStore((s) => s.nodes);
  const rows = useMemo(() => statusRows(nodes).filter((r) => r.status.startsWith('Installed')), [nodes]);
  const canPlace = hasFreeSlot || !!replacing;
  return (
    <div className="space-y-3 p-4" data-testid="tool-placement">
      <p className="text-[12px] text-text-muted">
        {replacing ? `Choose a tool to replace ${replacing.name}.` : 'Choose a detected tool for the empty slot.'} Only tools found on this machine are listed.
      </p>
      {rows.length === 0 && <p className="text-[12px] text-text-subtle">No installed tools have been detected yet. Open Connected Environment to see the latest check.</p>}
      <ul className="space-y-1.5">
        {rows.map((r) => {
          const placed = inWorkspace.includes(r.id);
          return (
            <li key={r.id} className="flex items-center justify-between gap-3 rounded-xl border border-line px-3 py-2">
              <div className="min-w-0"><div className="truncate text-[12.5px] font-medium text-text">{r.name}</div><div className="text-[11px] text-text-subtle">{r.status}</div></div>
              <Button size="sm" variant="secondary" disabled={placed || !canPlace} onClick={() => onAddToWorkspace(r.id)}>
                {placed ? 'In workspace' : canPlace ? 'Add to workspace' : 'Slots full'}
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
