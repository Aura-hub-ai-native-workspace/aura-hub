/**
 * KnowledgeInspector — "Graph Details": the fabric's live index status for
 * the open project. Same fields the old global right sidebar's "Knowledge"
 * section showed (see RightPanel.tsx's ProjectContext) — reused here as
 * the Knowledge window's own contextual inspector instead.
 */
import { Badge, PanelSection, PropertyRow } from '@aura/ui';
import { useWorkspace } from '../../data/useWorkspace';

export default function KnowledgeInspector() {
  const { status, openId } = useWorkspace();

  if (!openId) {
    return (
      <PanelSection title="Graph Details" icon="knowledge">
        <div className="rounded-xl border border-dashed border-line px-3 py-4 text-center text-[12px] text-text-subtle">No project open</div>
      </PanelSection>
    );
  }

  if (!status || status.phase === 'empty') {
    return (
      <PanelSection title="Graph Details" icon="knowledge">
        <div className="rounded-xl border border-dashed border-line px-3 py-4 text-center text-[12px] text-text-subtle">Indexing…</div>
      </PanelSection>
    );
  }

  return (
    <PanelSection title="Graph Details" icon="knowledge">
      <div className="space-y-2">
        <PropertyRow label="Status" value={<Badge tone={status.phase === 'ready' ? 'positive' : status.phase === 'error' ? 'critical' : 'info'} dot>{status.phase}</Badge>} />
        <PropertyRow label="Code chunks" value={status.coding.chunks.toLocaleString()} />
        <PropertyRow label="Entities" value={status.fullstack.entities.toLocaleString()} />
        <PropertyRow label="Relations" value={status.fullstack.relations.toLocaleString()} />
      </div>
    </PanelSection>
  );
}
