/**
 * KnowledgePanel — the full Knowledge Fabric section (verification,
 * dependency insights, symbol search, the entity-level graph) docked as
 * a Workspace panel, scoped to whichever project is currently open.
 * Mounts the same `Knowledge` component the former top-level `knowledge`
 * nav destination rendered — no capability lost by moving it here.
 */
import { useWorkspace } from '../../data/useWorkspace';
import { EmptyState } from '../../components/EmptyState';
import { Knowledge } from '../../screens/project/sections/Knowledge';

export default function KnowledgePanel() {
  const openId = useWorkspace((s) => s.openId);

  if (!openId) {
    return (
      <div className="grid h-full place-items-center p-6">
        <EmptyState compact icon="knowledge" title="Open a project to browse its fabric" />
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <Knowledge projectId={openId} />
    </div>
  );
}
