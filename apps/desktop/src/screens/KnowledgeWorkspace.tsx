import { Button } from '@aura/ui';
import { useWorkspace } from '../data/useWorkspace';
import { EmptyState } from '../components/EmptyState';
import { Knowledge } from './project/sections/Knowledge';

export function KnowledgeWorkspace() {
  const { openId, projects, open: openProject } = useWorkspace();

  if (!openId) {
    return (
      <div className="mx-auto max-w-[1080px] px-8 py-10">
        <EmptyState
          icon="knowledge"
          title="No project open"
          description="Open a project to build its knowledge index and explore the graph."
        />
        <div className="mt-6 space-y-2">
          {projects.map((p) => (
            <div key={p.id} className="flex items-center justify-between rounded-xl border border-line bg-surface px-4 py-3">
              <div>
                <div className="text-[13px] font-medium text-text">{p.name}</div>
                <div className="text-[11.5px] text-text-subtle">{p.type} · {p.language}</div>
              </div>
              <Button icon="spark" onClick={() => void openProject(p.id)}>Open</Button>
            </div>
          ))}
          {projects.length === 0 && (
            <p className="text-[12.5px] text-text-muted">No projects added yet. Add a project in the Projects screen.</p>
          )}
        </div>
      </div>
    );
  }

  return <Knowledge projectId={openId} />;
}