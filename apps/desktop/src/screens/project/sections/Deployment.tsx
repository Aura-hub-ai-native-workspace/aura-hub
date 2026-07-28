import { Card, CardHeader, Icon } from '@aura/ui';
import { SectionView, Block } from '../components/kit';
import { EmptyState } from '../../../components/EmptyState';
import { useProjectData } from './shared';

/**
 * Deployment — reports only what is really configured: Dockerfiles,
 * compose services and CI pipelines detected in the project. No invented
 * environments, versions or uptime.
 */
export function Deployment({ projectId }: { projectId: string }) {
  const { ready, profile, graph } = useProjectData(projectId);
  const infra = (graph?.entities ?? []).filter((e) => ['dockerfile', 'compose-service', 'ci-pipeline', 'build-config'].includes(e.kind));
  const has = profile?.has;

  if (!ready) return <SectionView title="Deployment"><EmptyState icon="deploy" title="Analyzing…" compact /></SectionView>;
  if (!has?.docker && !has?.ci && infra.length === 0) {
    return <SectionView title="Deployment"><EmptyState icon="deploy" title="No deployment config found" description="No Dockerfile, docker-compose or CI pipeline was detected in this project." /></SectionView>;
  }

  return (
    <SectionView title="Deployment" hint="Real infrastructure config detected in your project.">
      <Block className="mb-5">
        <div className="flex flex-wrap gap-2">
          {has?.docker && <Flag icon="server" label="Docker" />}
          {has?.ci && <Flag icon="workflows" label="CI/CD" />}
          {has?.config && <Flag icon="settings" label="Env config" />}
          {has?.git && <Flag icon="architecture" label="Git" />}
        </div>
      </Block>
      {infra.length > 0 && (
        <Block>
          <Card padding="none" className="overflow-hidden">
            <CardHeader title="Infrastructure entities" className="px-5 pt-5" />
            <div className="mt-3 divide-y divide-line">
              {infra.map((e) => (
                <div key={e.id} className="flex items-center gap-3 px-5 py-2.5">
                  <Icon name="deploy" size={14} className="shrink-0 text-text-subtle" />
                  <span className="text-[13px] font-medium text-text">{e.name}</span>
                  <span className="ml-auto truncate font-mono text-[11px] text-text-subtle">{e.relPath}</span>
                </div>
              ))}
            </div>
          </Card>
        </Block>
      )}
    </SectionView>
  );
}

function Flag({ icon, label }: { icon: 'server' | 'workflows' | 'settings' | 'architecture'; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-lg bg-surface-active px-3 py-1.5 text-[12.5px] font-medium text-text">
      <Icon name={icon} size={14} className="text-positive" /> {label}
    </span>
  );
}
