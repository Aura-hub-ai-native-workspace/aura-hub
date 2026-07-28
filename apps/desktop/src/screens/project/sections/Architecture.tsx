import { useState, useEffect, useMemo } from 'react';
import { cn } from '@aura/core';
import { Icon } from '@aura/ui';
import { SectionView, Block, StatTile } from '../components/kit';
import { useProjectData, byKind } from './shared';
import { ArchitectureDiagram3D, type LayerDef } from '../../../components/ArchitectureDiagram3D';
import { GraphCanvas3D } from '../../../components/GraphCanvas3D';
import { NodeDetail, type GraphCanvasNode } from '../../../components/GraphCanvas';
import { aiClient } from '../../../ai/aiClient';

const PALETTE = ['#3b82f6', '#06b6d4', '#8b5cf6', '#a855f7', '#ec4899', '#f43f5e', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#0ea5e9', '#6366f1', '#84cc16', '#f472b6'];
const CONTAINER = new Set(['packages', 'apps', 'app', 'src', 'lib', 'source', 'sources', 'pkg', 'modules', 'crates']);

/** The module (real folder) a file belongs to — keeps container prefixes. */
function moduleOf(relPath: string): string {
  const parts = (relPath || '').split('/').filter(Boolean);
  if (parts.length <= 1) return 'root';
  const dirs = parts.slice(0, -1);
  const out: string[] = [];
  for (const d of dirs) { out.push(d); if (!CONTAINER.has(d.toLowerCase())) break; }
  return out.join('/') || 'root';
}

/**
 * Architecture — the project's real structure in 3D. "Graph" shows every file
 * and how they actually depend on each other, clustered and coloured by folder;
 * "Layers" shows the dependency-ordered tier stack. Both are unique per project.
 */
export function Architecture({ projectId }: { projectId: string }) {
  const { ready, graph } = useProjectData(projectId);
  const [view, setView] = useState<'graph' | 'layers'>('graph');
  const [layers, setLayers] = useState<LayerDef[]>([]);
  const [selected, setSelected] = useState<GraphCanvasNode | null>(null);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    const fetchLayers = async () => {
      try { const { layers: raw } = await aiClient.projectArchitectureLayers(projectId); if (!cancelled && raw?.length) setLayers(raw as LayerDef[]); } catch { /* keep */ }
    };
    setLayers([]);
    void fetchLayers();
    const t = setTimeout(() => void fetchLayers(), 12_000);
    return () => { cancelled = true; clearTimeout(t); };
  }, [projectId, ready]);

  const entities = graph?.entities ?? [];
  const relations = graph?.relations ?? [];

  const { nodes, edges, groupColors, moduleCount } = useMemo(() => {
    const mods = [...new Set(entities.map((e) => moduleOf(e.relPath)))].sort();
    const gc: Record<string, string> = {};
    mods.forEach((m, i) => { gc[m] = PALETTE[i % PALETTE.length]; });
    return {
      nodes: entities.map((e) => ({ id: e.id, label: e.name, group: moduleOf(e.relPath), relPath: e.relPath, line: e.line, detail: e.summary, type: e.kind })),
      edges: relations.map((r) => ({ from: r.from, to: r.to, kind: r.kind })),
      groupColors: gc,
      moduleCount: mods.length,
    };
  }, [entities, relations]);

  const groups = byKind(entities);

  return (
    <SectionView title="Architecture" hint="3D system architecture, unique to this project — hover to trace dependencies, click to inspect, drag to orbit.">
      <Block className="mb-5">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <StatTile icon="architecture" label="Entities" value={entities.length} tone="info" />
          <StatTile icon="link" label="Relationships" value={relations.length} tone="positive" />
          <StatTile icon="layout" label="Entity kinds" value={groups.length} />
          <StatTile icon="server" label="Modules" value={moduleCount} tone="attention" />
        </div>
      </Block>

      <div className="mb-4 inline-flex rounded-xl border border-line bg-surface p-0.5">
        {(['graph', 'layers'] as const).map((v) => (
          <button key={v} onClick={() => setView(v)} className={cn('rounded-lg px-3.5 py-1.5 text-[12.5px] font-medium capitalize transition-colors', view === v ? 'bg-accent text-white' : 'text-text-muted hover:text-text')}>
            {v === 'graph' ? 'Dependency graph' : 'Layers'}
          </button>
        ))}
      </div>

      {view === 'graph' ? (
        nodes.length > 0 ? (
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_320px]">
            <GraphCanvas3D nodes={nodes} edges={edges} groupColors={groupColors} height={620} onSelect={setSelected} selectedId={selected?.id ?? null} />
            <div>
              {selected ? (
                <NodeDetail node={selected} onClose={() => setSelected(null)} />
              ) : (
                <div className="rounded-2xl border border-line bg-surface p-4">
                  <div className="text-[13px] font-semibold text-text">Modules</div>
                  <p className="mt-1 text-[11.5px] text-text-subtle">Each colour is a real folder. Bigger spheres are more-depended-on files. Arrows point from a file to what it uses.</p>
                  <div className="mt-3 max-h-[440px] space-y-1 overflow-y-auto">
                    {Object.entries(groupColors).map(([m, c]) => (
                      <div key={m} className="flex items-center gap-2 text-[12px]"><span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: c }} /><span className="truncate font-mono text-text-muted">{m}</span></div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        ) : (
          <BuildingState />
        )
      ) : (
        <div className="rounded-2xl" style={{ height: 640 }}>
          {layers.length > 1 ? <ArchitectureDiagram3D layers={layers} /> : <BuildingState />}
        </div>
      )}
    </SectionView>
  );
}

function BuildingState() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-line text-center" style={{ height: 620, background: '#0a0e17' }}>
      <span className="grid h-12 w-12 animate-pulse place-items-center rounded-2xl bg-accent/10 text-accent"><Icon name="architecture" size={24} /></span>
      <p className="text-[13px] text-text-muted">Building the architecture from your codebase…</p>
      <p className="text-[11px] text-text-subtle">Analyzing modules and their dependencies.</p>
    </div>
  );
}
