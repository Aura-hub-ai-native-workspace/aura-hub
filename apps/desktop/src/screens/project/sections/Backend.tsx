import { SectionView } from '../components/kit';
import { useProjectData, byKind, EntityGroups, LayerEmpty } from './shared';

/** Backend — real backend entities (endpoints, controllers, services…). */
export function Backend({ projectId }: { projectId: string }) {
  const { ready, graph } = useProjectData(projectId);
  const items = (graph?.entities ?? []).filter((e) => e.layer === 'backend');
  return (
    <SectionView title="Backend" hint="Endpoints, controllers, services and guards found in your real files.">
      {items.length ? <EntityGroups groups={byKind(items)} /> : <LayerEmpty ready={ready} label="backend" />}
    </SectionView>
  );
}
