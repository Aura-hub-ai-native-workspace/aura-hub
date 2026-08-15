/**
 * ArchitectureInspector — "Layer Inspector": the dependency-ordered tier
 * stack for the open project, fetched the same way Architecture.tsx's own
 * blueprint does. Real data, not a mirror of component-internal state —
 * ArchitectureBlueprint.tsx's layer-selection/trace state is local to its
 * own canvas and isn't lifted here.
 */
import { useEffect, useState } from 'react';
import { PanelSection, PropertyRow } from '@aura/ui';
import { useWorkspace } from '../../data/useWorkspace';
import { aiClient, type ArchitectureLayer, type ArchitectureLayerEdge } from '../../ai/aiClient';

export default function ArchitectureInspector() {
  const openId = useWorkspace((s) => s.openId);
  const [layers, setLayers] = useState<ArchitectureLayer[] | null>(null);
  const [edges, setEdges] = useState<ArchitectureLayerEdge[]>([]);

  useEffect(() => {
    if (!openId) { setLayers(null); setEdges([]); return; }
    let cancelled = false;
    aiClient
      .projectArchitectureLayers(openId)
      .then((res) => { if (!cancelled) { setLayers(res.layers ?? []); setEdges(res.edges ?? []); } })
      .catch(() => { if (!cancelled) { setLayers([]); setEdges([]); } });
    return () => { cancelled = true; };
  }, [openId]);

  return (
    <PanelSection title="Layer Inspector" icon="architecture">
      {layers === null ? (
        <div className="rounded-xl border border-dashed border-line px-3 py-4 text-center text-[12px] text-text-subtle">Loading…</div>
      ) : layers.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line px-3 py-4 text-center text-[12px] text-text-subtle">No layer data yet</div>
      ) : (
        <div className="space-y-2">
          <PropertyRow label="Dependencies" value={String(edges.length)} />
          {layers.map((layer, i) => (
            <PropertyRow key={layer.title ?? i} label={layer.title ?? `Layer ${i + 1}`} value={String(layer.items?.length ?? 0)} />
          ))}
        </div>
      )}
    </PanelSection>
  );
}
