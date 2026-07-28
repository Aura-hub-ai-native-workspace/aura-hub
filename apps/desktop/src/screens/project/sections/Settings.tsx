import { useAppStore } from '@aura/core';
import { Badge, Card, CardHeader, Icon, useToast } from '@aura/ui';
import { SectionView, Block } from '../components/kit';
import { EmptyState } from '../../../components/EmptyState';
import { useProjectData } from './shared';
import { useWorkspace } from '../../../data/useWorkspace';

/**
 * Settings — real project metadata and actions: reveal the path, re-index
 * the folder, toggle favorite, rename, or remove it from AURA (the folder
 * on disk is never touched).
 */
export function Settings({ projectId }: { projectId: string }) {
  const { profile, status } = useProjectData(projectId);
  const { projects, favorite, rename, remove, reindex } = useWorkspace();
  const closeProject = useAppStore((s) => s.closeProject);
  const setNav = useAppStore((s) => s.setNav);
  const { push } = useToast();
  const project = projects.find((p) => p.id === projectId);

  if (!project) return <SectionView title="Project settings"><EmptyState icon="settings" title="Project unavailable" compact /></SectionView>;

  return (
    <SectionView title="Project settings" hint="Real metadata for this project.">
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Block>
          <Card>
            <CardHeader title="Metadata" />
            <div className="mt-4 divide-y divide-line text-[12.5px]">
              <Row label="Name" value={project.name} />
              <Row label="Path" value={<span className="font-mono">{project.path}</span>} />
              <Row label="Type" value={project.type} />
              <Row label="Language" value={project.language} />
              <Row label="Package manager" value={profile?.packageManager ?? '—'} />
              <Row label="Files indexed" value={String(profile?.fileCount ?? 0)} />
              <Row label="Favorite" value={<Badge tone={project.favorite ? 'attention' : 'neutral'}>{project.favorite ? 'Yes' : 'No'}</Badge>} />
            </div>
          </Card>
        </Block>

        <Block>
          <Card className="h-full">
            <CardHeader title="Actions" />
            <div className="mt-4 space-y-2.5">
              <Action icon="knowledge" title="Re-index project" desc={status ? `${status.coding.chunks} chunks · ${status.fullstack.entities} entities` : 'Rebuild code + system indexes'} onClick={() => { void reindex(); push({ title: 'Re-indexing', description: 'Rebuilding the knowledge index.', tone: 'info' }); }} />
              <Action icon="pin" title={project.favorite ? 'Remove favorite' : 'Mark as favorite'} desc="Show at the top of your library" onClick={() => void favorite(project.id, !project.favorite)} />
              <Action icon="note" title="Rename project" desc="Change the display name" onClick={() => { const n = window.prompt('Rename project', project.name); if (n && n.trim()) void rename(project.id, n.trim()); }} />
              <Action icon="settings" title="AI provider settings" desc="AI runtime, model, streaming" onClick={() => setNav('settings')} />
              <button
                onClick={() => {
                  if (window.confirm(`Remove "${project.name}" from AURA? The folder on disk is not deleted.`)) {
                    void remove(project.id); closeProject();
                    push({ title: 'Project removed', description: 'The folder was left untouched.', tone: 'info' });
                  }
                }}
                className="flex w-full items-center gap-3 rounded-xl border border-critical/30 bg-critical/5 px-3.5 py-3 text-left transition-colors hover:bg-critical/10"
              >
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-critical/10 text-critical"><Icon name="close" size={16} /></span>
                <span>
                  <span className="block text-[13px] font-medium text-critical">Remove from AURA</span>
                  <span className="block text-[11.5px] text-text-subtle">The folder on disk is kept intact</span>
                </span>
              </button>
            </div>
          </Card>
        </Block>
      </div>
    </SectionView>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <span className="shrink-0 text-text-muted">{label}</span>
      <span className="truncate text-right font-medium text-text">{value}</span>
    </div>
  );
}

function Action({ icon, title, desc, onClick }: { icon: 'knowledge' | 'pin' | 'note' | 'settings'; title: string; desc: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex w-full items-center gap-3 rounded-xl border border-line px-3.5 py-3 text-left transition-colors hover:bg-surface-hover">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-surface-active text-text-muted"><Icon name={icon} size={16} /></span>
      <span>
        <span className="block text-[13px] font-medium text-text">{title}</span>
        <span className="block text-[11.5px] text-text-subtle">{desc}</span>
      </span>
    </button>
  );
}
