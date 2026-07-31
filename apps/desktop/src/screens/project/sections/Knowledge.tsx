import { useMemo, useState } from 'react';
import { Button, Card, CardHeader, Icon, Input } from '@aura/ui';
import { SectionView, Block, StatTile } from '../components/kit';
import { EmptyState } from '../../../components/EmptyState';
import { useProjectData } from './shared';
import { aiClient, type KGNode, type RetrieveResult } from '../../../ai/aiClient';
import { NodeGraphCanvas, type NodeCardData, type NodeCardEdge } from '../../../components/NodeGraphCanvas';

/** Node-group palette for the knowledge graph. */
const KG_COLORS: Record<string, string> = {
  frontend: '#3b82f6', backend: '#22c55e', database: '#f59e0b', config: '#8b5cf6',
  docs: '#06b6d4', memory: '#ec4899', conversation: '#a855f7', code: '#60a5fa',
  service: '#14b8a6', module: '#818cf8', other: '#64748b',
};

/**
 * Knowledge — real code + system indexes, an interactive native 3D knowledge
 * graph (rendered directly from AURA's own entities — no external tools), and
 * a live retrieval explorer.
 */
export function Knowledge({ projectId }: { projectId: string }) {
  const { ready, status, kg } = useProjectData(projectId);
  const [q, setQ] = useState('');
  const [res, setRes] = useState<RetrieveResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);

  const run = async () => {
    if (!q.trim()) return;
    setBusy(true);
    try { setRes(await aiClient.retrieve(q.trim())); } catch { setRes({ entries: [], totalTokens: 0 }); }
    setBusy(false);
  };

  // Aggregate the raw entity/relation graph into one card per real group
  // (frontend/backend/database/…) — a clean, readable diagram regardless
  // of how many hundreds of underlying nodes a project actually has.
  const { cards, cardEdges, byGroup } = useMemo(() => {
    const kgNodes = kg?.nodes ?? [];
    const kgEdges = kg?.edges ?? [];
    const idToGroup = new Map<string, string>();
    const grouped = new Map<string, KGNode[]>();
    for (const n of kgNodes) {
      idToGroup.set(n.id, n.group);
      const list = grouped.get(n.group) ?? [];
      list.push(n);
      grouped.set(n.group, list);
    }
    const groups = [...grouped.keys()].sort();
    const nodes: NodeCardData[] = groups.map((g) => {
      const items = grouped.get(g) ?? [];
      const typeCounts = new Map<string, number>();
      const files = new Set<string>();
      for (const n of items) {
        typeCounts.set(n.type, (typeCounts.get(n.type) ?? 0) + 1);
        if (n.relPath) files.add(n.relPath);
      }
      const topType = [...typeCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '—';
      return {
        id: g,
        title: g,
        group: g,
        rows: [
          { label: 'Nodes', value: String(items.length) },
          { label: 'Files', value: String(files.size) },
          { label: 'Top type', value: topType },
        ],
      };
    });

    const edgeCounts = new Map<string, number>();
    for (const e of kgEdges) {
      const fg = idToGroup.get(e.from);
      const tg = idToGroup.get(e.to);
      if (!fg || !tg || fg === tg) continue;
      edgeCounts.set(`${fg} ${tg}`, (edgeCounts.get(`${fg} ${tg}`) ?? 0) + 1);
    }
    const edges: NodeCardEdge[] = [...edgeCounts.keys()].map((key) => {
      const [from, to] = key.split(' ');
      return { from, to };
    });

    return { cards: nodes, cardEdges: edges, byGroup: grouped };
  }, [kg]);

  if (!ready || !status || status.phase === 'empty') {
    return <SectionView title="Knowledge"><EmptyState icon="knowledge" title="Not indexed yet" description="Open the project to build its indexes." /></SectionView>;
  }

  const selectedItems = selectedGroup ? byGroup.get(selectedGroup) ?? [] : [];

  return (
    <SectionView title="Knowledge" hint="Real code + system indexes, a node-diagram of every group in the graph, and a live retrieval explorer.">
      <Block className="mb-5">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <StatTile icon="knowledge" label="Code chunks" value={status.coding.chunks.toLocaleString()} tone="positive" />
          <StatTile icon="architecture" label="System entities" value={status.fullstack.entities.toLocaleString()} tone="info" />
          <StatTile icon="link" label="Relationships" value={status.fullstack.relations.toLocaleString()} />
          <StatTile icon="cpu" label="Index state" value={<span className="text-[15px]">{status.phase}</span>} tone={status.phase === 'ready' ? 'positive' : 'attention'} />
        </div>
      </Block>

      <Block className="mb-5">
        <Card>
          <CardHeader title="Knowledge graph" subtitle="Every group of entities in this project and how they connect — hover to trace, click a card to inspect, drag to pan, scroll to zoom." />
          {cards.length === 0 ? (
            <div className="mt-4 flex h-[560px] items-center justify-center rounded-2xl border border-line" style={{ background: '#0a0e17' }}>
              <div className="text-center">
                <Icon name="knowledge" size={26} className="mx-auto animate-pulse text-accent" />
                <p className="mt-3 text-[13px] text-text-muted">{status.phase === 'ready' ? 'No graph entities detected.' : 'Building the knowledge graph…'}</p>
              </div>
            </div>
          ) : (
            <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[1fr_320px]">
              <NodeGraphCanvas nodes={cards} edges={cardEdges} groupColors={KG_COLORS} height={600} onSelect={setSelectedGroup} selectedId={selectedGroup} />
              <div>
                {selectedGroup ? (
                  <GroupDetail group={selectedGroup} items={selectedItems} color={KG_COLORS[selectedGroup]} onClose={() => setSelectedGroup(null)} />
                ) : (
                  <div className="rounded-2xl border border-line bg-surface p-4">
                    <div className="text-[13px] font-semibold text-text">Graph composition</div>
                    <div className="mt-3 space-y-1.5">
                      {Object.entries(kg?.counts ?? {}).sort((a, b) => b[1] - a[1]).map(([type, n]) => (
                        <div key={type} className="flex items-center justify-between text-[12px]"><span className="capitalize text-text-muted">{type}</span><span className="tabular-nums text-text-subtle">{n}</span></div>
                      ))}
                    </div>
                    <p className="mt-3 border-t border-line pt-3 text-[11.5px] text-text-subtle">Hover a card to light up its neighbourhood. Click to see the group's real member nodes.</p>
                  </div>
                )}
              </div>
            </div>
          )}
        </Card>
      </Block>

      <Block>
        <Card>
          <CardHeader title="Retrieval explorer" subtitle="Runs the Coding Knowledge Engine over your files" />
          <div className="mt-4 flex gap-2">
            <Input icon="search" placeholder="e.g. where is authentication handled?" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && run()} className="flex-1" />
            <Button icon="spark" onClick={run} disabled={busy}>{busy ? 'Retrieving…' : 'Retrieve'}</Button>
          </div>
          {res && (
            <div className="mt-5 space-y-3">
              {res.entries.length === 0 ? (
                <p className="text-[12.5px] text-text-muted">No matching code found for that query.</p>
              ) : (
                <>
                  <div className="text-[11.5px] text-text-subtle">{res.entries.length} sources · {res.totalTokens} context tokens</div>
                  {res.entries.map((e, i) => (
                    <div key={i} className="overflow-hidden rounded-xl border border-line">
                      <div className="flex items-center justify-between bg-surface-active/60 px-3 py-2">
                        <span className="flex items-center gap-1.5 truncate font-mono text-[11.5px] text-text"><Icon name="doc" size={12} /> {e.source}</span>
                        <span className="shrink-0 text-[10.5px] text-text-subtle">score {e.score.toFixed(2)}</span>
                      </div>
                      <pre className="max-h-52 overflow-auto px-3 py-2.5 text-[11px] leading-relaxed text-text-muted"><code>{e.snippet}</code></pre>
                    </div>
                  ))}
                </>
              )}
            </div>
          )}
        </Card>
      </Block>
    </SectionView>
  );
}

/** Side panel for a selected group card — its real member nodes. */
function GroupDetail({ group, items, color, onClose }: { group: string; items: KGNode[]; color?: string; onClose: () => void }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-subtle">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color ?? '#8892a6' }} />
            Group
          </div>
          <div className="mt-0.5 truncate text-[15px] font-semibold capitalize text-text">{group}</div>
        </div>
        <button onClick={onClose} className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-text-subtle hover:bg-surface-hover hover:text-text">
          <Icon name="close" size={14} />
        </button>
      </div>
      <p className="mt-2 text-[12px] text-text-muted">{items.length} {items.length === 1 ? 'node' : 'nodes'} in this group.</p>
      <div className="mt-3 max-h-[440px] space-y-1 overflow-y-auto">
        {items.slice(0, 60).map((n) => (
          <div key={n.id} className="flex items-start gap-2 rounded-lg px-1.5 py-1.5 hover:bg-surface-hover">
            <Icon name="dot" size={12} className="mt-1 shrink-0 text-text-subtle" />
            <div className="min-w-0">
              <div className="truncate text-[12.5px] font-medium text-text">{n.label}</div>
              {n.relPath && <div className="truncate font-mono text-[10.5px] text-text-subtle">{n.relPath}{n.line ? `:${n.line}` : ''}</div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
