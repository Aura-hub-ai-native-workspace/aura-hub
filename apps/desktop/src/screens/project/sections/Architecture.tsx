import { useState, useEffect } from 'react';
import { Icon } from '@aura/ui';
import { SectionView, Block, StatTile } from '../components/kit';
import { useProjectData, byKind } from './shared';
import { ArchitectureBlueprint } from '../../../components/ArchitectureBlueprint';
import { aiClient, type ArchitectureLayer, type ArchitectureLayerEdge } from '../../../ai/aiClient';

/**
 * Architecture — the project's real system blueprint: a layered,
 * dependency-ordered stack (consumers at top, foundations at the bottom),
 * with real directional connectors between specific layers. Deliberately
 * not a graph — see ArchitectureBlueprint.tsx and the Separate Knowledge
 * Graph and Architecture plan for why this is its own engine rather than
 * reusing NodeGraphCanvas.
 */
export function Architecture({ projectId }: { projectId: string }) {
  const { ready, graph } = useProjectData(projectId);
  const [layers, setLayers] = useState<ArchitectureLayer[]>([]);
  const [edges, setEdges] = useState<ArchitectureLayerEdge[]>([]);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    const fetchLayers = async () => {
      try {
        const res = await aiClient.projectArchitectureLayers(projectId);
        if (!cancelled && res.layers?.length) {
          setLayers(res.layers);
          setEdges(res.edges ?? []);
        }
      } catch { /* keep previous */ }
    };
    setLayers([]);
    setEdges([]);
    void fetchLayers();
    const t = setTimeout(() => void fetchLayers(), 12_000);
    return () => { cancelled = true; clearTimeout(t); };
  }, [projectId, ready]);

  const entities = graph?.entities ?? [];
  const relations = graph?.relations ?? [];
  const groups = byKind(entities);

  return (
    <SectionView
      title="Architecture"
      hint="The dependency-ordered layer stack for this project, from consumer surface to foundation — click a layer to trace what it depends on and what depends on it, scroll to zoom, drag to pan."
    >
      <Block className="mb-5">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <StatTile icon="architecture" label="Entities" value={entities.length} tone="info" />
          <StatTile icon="link" label="Relationships" value={relations.length} tone="positive" />
          <StatTile icon="layout" label="Entity kinds" value={groups.length} />
          <StatTile icon="server" label="Layers" value={Math.max(0, layers.length - 1)} tone="attention" />
        </div>
      </Block>

      {layers.length > 1 ? <ArchitectureBlueprint layers={layers} edges={edges} /> : <BuildingState />}
    </SectionView>
  );
}

function BuildingState() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-line text-center" style={{ height: 620, background: '#0e0e0e' }}>
      <span className="grid h-12 w-12 animate-pulse place-items-center rounded-2xl bg-accent/10 text-accent"><Icon name="architecture" size={24} /></span>
      <p className="text-[13px] text-text-muted">Building the architecture from your codebase…</p>
      <p className="text-[11px] text-text-subtle">Analyzing modules and their dependencies.</p>
    </div>
  );
}
