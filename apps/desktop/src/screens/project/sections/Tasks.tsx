import { SectionView } from '../components/kit';
import { EmptyState } from '../../../components/EmptyState';

/**
 * Tasks — reserved for real project tasks. AURA has no task source for a
 * local folder yet (no fabricated kanban), so this is an honest empty
 * state until a real task provider (e.g. issues) is connected.
 */
export function Tasks(_: { projectId: string }) {
  return (
    <SectionView title="Tasks">
      <EmptyState
        icon="check"
        title="No tasks yet"
        description="Task tracking for this project isn't connected. When a real task source exists, it will appear here — nothing is made up."
      />
    </SectionView>
  );
}
