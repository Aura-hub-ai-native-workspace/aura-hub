import { SectionView } from '../components/kit';
import { useProjectData, byKind, EntityGroups, LayerEmpty } from './shared';

/** Database — real database entities (tables, models, migrations). */
export function Database({ projectId }: { projectId: string }) {
  const { ready, graph } = useProjectData(projectId);
  const items = (graph?.entities ?? []).filter((e) => e.layer === 'database');
  return (
    <SectionView title="Database" hint="Tables, ORM models and migrations found in your real files.">
      {items.length ? <EntityGroups groups={byKind(items)} /> : <LayerEmpty ready={ready} label="database" />}
    </SectionView>
  );
}
