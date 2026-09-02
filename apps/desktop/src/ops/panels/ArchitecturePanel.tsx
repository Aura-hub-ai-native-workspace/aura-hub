/**
 * ArchitecturePanel — the project's layered/dependency structure view,
 * mounted as a Workspace window, scoped to whichever project is currently
 * open. Mounts the same `Architecture` component the per-project route
 * renders — no capability lost, same pattern as `KnowledgePanel.tsx`.
 */
import { useWorkspace } from '../../data/useWorkspace';
import { EmptyState } from '../../components/EmptyState';
import { Architecture } from '../../screens/project/sections/Architecture';

export default function ArchitecturePanel() {
  const openId = useWorkspace((s) => s.openId);

  if (!openId) {
    return (
      <div className="grid h-full place-items-center p-6">
        <EmptyState compact icon="architecture" title="Open a project to explore its architecture" />
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <Architecture projectId={openId} />
    </div>
  );
}
