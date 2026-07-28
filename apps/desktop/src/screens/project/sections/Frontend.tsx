import { SectionView } from '../components/kit';
import { useProjectData, byKind, EntityGroups, LayerEmpty } from './shared';

/** Frontend — real frontend entities (pages, components, hooks, routes…). */
export function Frontend({ projectId }: { projectId: string }) {
  const { ready, graph } = useProjectData(projectId);
  const items = (graph?.entities ?? []).filter((e) => e.layer === 'frontend');
  return (
    <SectionView title="Frontend" hint="Pages, components, hooks and routes found in your real files.">
      {items.length ? <EntityGroups groups={byKind(items)} /> : <LayerEmpty ready={ready} label="frontend" />}
    </SectionView>
  );
}
