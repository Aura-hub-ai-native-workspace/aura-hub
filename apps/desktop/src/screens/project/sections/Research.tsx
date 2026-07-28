import { SectionView } from '../components/kit';
import { EmptyState } from '../../../components/EmptyState';

/**
 * Research — reserved for real research artifacts (papers, references,
 * bookmarks the user attaches). There is no local source for these yet,
 * so AURA shows an honest empty state rather than fabricated content.
 */
export function Research(_: { projectId: string }) {
  return (
    <SectionView title="Research">
      <EmptyState
        icon="research"
        title="No research attached"
        description="Research notes, papers and references you attach to this project will appear here. AURA never invents sources."
      />
    </SectionView>
  );
}
