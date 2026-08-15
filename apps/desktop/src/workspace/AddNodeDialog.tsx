/**
 * AddNodeDialog — place a capability node in the Workspace.
 * ==================================================================
 * Reads the existing 110-entry catalogue from `@aura/connected-environment`.
 * It creates no registry of its own: everything listed here is a real
 * `CatalogEntry` that the environment scanner already knows how to probe
 * (or, honestly, knows it cannot — see `TransportKind`).
 *
 * Adding a node places it on the canvas. It does **not** claim the tool is
 * installed or connected; the next scan answers that.
 */

import { useMemo, useState } from 'react';
import { CATALOG, type CatalogEntry, type NodeCategory } from '@aura/connected-environment';
import { Dialog, Icon } from '@aura/ui';
import { CATEGORY_ICON } from '../environment/presentation';
import { useHubStore } from './hubStore';

const CATEGORY_ORDER: NodeCategory[] = [
  'development',
  'ai',
  'cloud',
  'browser',
  'design',
  'productivity',
  'hub',
];

const CATEGORY_LABEL: Record<NodeCategory, string> = {
  development: 'Development',
  ai: 'AI',
  cloud: 'Cloud',
  browser: 'Browser',
  design: 'Design',
  productivity: 'Productivity',
  hub: 'AURA',
};

export function AddNodeDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const placed = useHubStore((s) => s.placed);
  const add = useHubStore((s) => s.add);

  const placedIds = useMemo(() => new Set(placed.map((p) => p.nodeId)), [placed]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (e: CatalogEntry) =>
      !q ||
      e.name.toLowerCase().includes(q) ||
      e.id.includes(q) ||
      e.summary.toLowerCase().includes(q) ||
      e.capabilities.some((c) => c.includes(q));

    return CATEGORY_ORDER.map((category) => ({
      category,
      entries: CATALOG.filter((e) => e.category === category && match(e)),
    })).filter((g) => g.entries.length > 0);
  }, [query]);

  const total = groups.reduce((n, g) => n + g.entries.length, 0);

  return (
    <Dialog open={open} onClose={onClose} title="Add a capability node">
      <div className="flex h-[62vh] min-h-0 flex-col">
        <div className="flex shrink-0 items-center gap-2 rounded-xl border border-line bg-canvas px-3 py-2">
          <Icon name="search" size={15} className="text-text-subtle" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search 110 systems — docker, github, postgres, ollama…"
            data-testid="add-node-search"
            className="flex-1 bg-transparent text-[13px] text-text outline-none placeholder:text-text-subtle"
          />
          <span className="shrink-0 text-[11px] text-text-subtle">{total}</span>
        </div>

        <div className="mt-3 min-h-0 flex-1 overflow-y-auto pr-1">
          {groups.length === 0 ? (
            <p className="py-10 text-center text-[12.5px] text-text-muted">
              Nothing in the catalogue matches “{query}”.
            </p>
          ) : (
            groups.map((group) => (
              <section key={group.category} className="mb-4">
                <h3 className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-text-subtle">
                  {CATEGORY_LABEL[group.category]}
                </h3>
                <div className="space-y-1">
                  {group.entries.map((entry) => (
                    <EntryRow
                      key={entry.id}
                      entry={entry}
                      placed={placedIds.has(entry.id)}
                      onAdd={() => add(entry.id)}
                    />
                  ))}
                </div>
              </section>
            ))
          )}
        </div>
      </div>
    </Dialog>
  );
}

function EntryRow({ entry, placed, onAdd }: { entry: CatalogEntry; placed: boolean; onAdd: () => void }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-transparent px-2.5 py-2 transition-colors hover:border-line hover:bg-surface-hover">
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-surface-active text-text-muted">
        <Icon name={CATEGORY_ICON[entry.category]} size={15} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[12.5px] font-medium text-text">{entry.name}</span>
          {/* An entry AURA cannot drive says so here rather than at the point of failure. */}
          {!entry.probe && !entry.endpoint && entry.transport !== 'internal' && (
            <span className="shrink-0 rounded-md bg-surface-active px-1.5 py-0.5 text-[9.5px] text-text-subtle">
              catalogued only
            </span>
          )}
        </div>
        <p className="truncate text-[11px] text-text-subtle">{entry.summary}</p>
      </div>
      <button
        onClick={onAdd}
        disabled={placed}
        data-testid={`add-node-${entry.id}`}
        className="shrink-0 rounded-lg border border-line bg-surface px-2.5 py-1 text-[11px] font-medium text-text-muted transition-colors hover:bg-surface-hover hover:text-text disabled:opacity-40"
      >
        {placed ? 'Added' : 'Add'}
      </button>
    </div>
  );
}
