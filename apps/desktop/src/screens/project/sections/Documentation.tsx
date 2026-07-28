import { Card, Icon } from '@aura/ui';
import { SectionView, Block } from '../components/kit';
import { EmptyState } from '../../../components/EmptyState';
import { useProjectData } from './shared';

/**
 * Documentation — the real docs found in the project (README, ARCHITECTURE,
 * anything under docs/) plus doc entities from the system graph. AURA does
 * not invent documentation; it points at what actually exists on disk.
 */
export function Documentation({ projectId }: { projectId: string }) {
  const { ready, profile, graph } = useProjectData(projectId);
  const docs = profile?.architectureDocs ?? [];
  const graphDocs = (graph?.entities ?? []).filter((e) => e.kind === 'doc' || e.kind === 'arch-module');

  if (!ready) return <SectionView title="Documentation"><EmptyState icon="doc" title="Analyzing…" compact /></SectionView>;
  if (docs.length === 0 && graphDocs.length === 0) {
    return <SectionView title="Documentation"><EmptyState icon="doc" title="No documentation found" description="No README, ARCHITECTURE.md or docs/ files were detected in this project." /></SectionView>;
  }

  return (
    <SectionView title="Documentation" hint="Real documents found in your project folder.">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {docs.map((d) => (
          <Block key={d.relPath}>
            <Card padding="md">
              <div className="flex items-center gap-3">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-surface-active text-text-muted"><Icon name="doc" size={16} /></span>
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-medium text-text">{d.title}</div>
                  <div className="truncate font-mono text-[11px] text-text-subtle">{d.relPath}</div>
                </div>
              </div>
            </Card>
          </Block>
        ))}
        {graphDocs.map((d) => (
          <Block key={d.id}>
            <Card padding="md">
              <div className="flex items-center gap-3">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-surface-active text-text-muted"><Icon name="note" size={16} /></span>
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-medium text-text">{d.name}</div>
                  <div className="truncate font-mono text-[11px] text-text-subtle">{d.relPath}{d.line ? `:${d.line}` : ''}</div>
                </div>
              </div>
            </Card>
          </Block>
        ))}
      </div>
    </SectionView>
  );
}
