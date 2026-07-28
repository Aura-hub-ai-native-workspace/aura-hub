import { useState } from 'react';
import { Button, Card, CardHeader, Icon, Input } from '@aura/ui';
import { SectionView, Block, StatTile } from '../components/kit';
import { EmptyState } from '../../../components/EmptyState';
import { useProjectData } from './shared';
import { aiClient, type RetrieveResult } from '../../../ai/aiClient';
import { GraphCanvas3D } from '../../../components/GraphCanvas3D';
import { NodeDetail, type GraphCanvasNode } from '../../../components/GraphCanvas';

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
  const [selected, setSelected] = useState<GraphCanvasNode | null>(null);

  const run = async () => {
    if (!q.trim()) return;
    setBusy(true);
    try { setRes(await aiClient.retrieve(q.trim())); } catch { setRes({ entries: [], totalTokens: 0 }); }
    setBusy(false);
  };

  if (!ready || !status || status.phase === 'empty') {
    return <SectionView title="Knowledge"><EmptyState icon="knowledge" title="Not indexed yet" description="Open the project to build its indexes." /></SectionView>;
  }

  const nodes = (kg?.nodes ?? []).map((n) => ({ id: n.id, label: n.label, group: n.group, type: n.type, relPath: n.relPath, line: n.line, detail: n.detail }));
  const edges = (kg?.edges ?? []).map((e) => ({ from: e.from, to: e.to, kind: e.kind }));

  return (
    <SectionView title="Knowledge" hint="Real code + system indexes, an interactive 3D knowledge graph, and a live retrieval explorer.">
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
          <CardHeader title="Knowledge graph" subtitle="Every file, entity and relationship in this project — hover to trace, click to inspect, drag to orbit." />
          {nodes.length === 0 ? (
            <div className="mt-4 flex h-[560px] items-center justify-center rounded-2xl border border-line" style={{ background: '#0a0e17' }}>
              <div className="text-center">
                <Icon name="knowledge" size={26} className="mx-auto animate-pulse text-accent" />
                <p className="mt-3 text-[13px] text-text-muted">{status.phase === 'ready' ? 'No graph entities detected.' : 'Building the knowledge graph…'}</p>
              </div>
            </div>
          ) : (
            <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[1fr_320px]">
              <GraphCanvas3D nodes={nodes} edges={edges} groupColors={KG_COLORS} height={600} onSelect={setSelected} selectedId={selected?.id ?? null} />
              <div>
                {selected ? (
                  <NodeDetail node={selected} onClose={() => setSelected(null)} />
                ) : (
                  <div className="rounded-2xl border border-line bg-surface p-4">
                    <div className="text-[13px] font-semibold text-text">Graph composition</div>
                    <div className="mt-3 space-y-1.5">
                      {Object.entries(kg?.counts ?? {}).sort((a, b) => b[1] - a[1]).map(([type, n]) => (
                        <div key={type} className="flex items-center justify-between text-[12px]"><span className="capitalize text-text-muted">{type}</span><span className="tabular-nums text-text-subtle">{n}</span></div>
                      ))}
                    </div>
                    <p className="mt-3 border-t border-line pt-3 text-[11.5px] text-text-subtle">Hover a node to light up its neighbourhood. Click to inspect. Bigger spheres are more-connected hubs.</p>
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
