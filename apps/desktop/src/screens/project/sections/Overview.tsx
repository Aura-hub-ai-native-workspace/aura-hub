import { useAppStore, type ProjectTab } from '@aura/core';
import { Badge, Card, CardHeader, Icon, type IconName } from '@aura/ui';
import { SectionView, Block, StatTile } from '../components/kit';
import { EmptyState } from '../../../components/EmptyState';
import { useProjectData } from './shared';

/**
 * Overview — a real profile of the project, derived from its actual
 * files: what it is, what it's built with, how it's laid out, and how
 * much of it AURA has indexed. No invented metrics.
 */
export function Overview({ projectId }: { projectId: string }) {
  const go = useAppStore((s) => s.setProjectTab);
  const { ready, profile, status, memory, graph } = useProjectData(projectId);

  if (!ready || !profile) {
    return <SectionView><EmptyState icon="knowledge" title="Building project profile…" description="AURA is analyzing the real folder." /></SectionView>;
  }

  const surfaces = Object.entries(profile.has).filter(([, v]) => v).map(([k]) => k);
  const jump: { label: string; icon: IconName; tab: ProjectTab; show: boolean }[] = [
    { label: 'Architecture', icon: 'architecture', tab: 'architecture', show: (graph?.entities.length ?? 0) > 0 },
    { label: 'Knowledge', icon: 'knowledge', tab: 'knowledge', show: true },
    { label: 'Memory', icon: 'memory', tab: 'memory', show: true },
    { label: 'Docs', icon: 'doc', tab: 'documentation', show: profile.architectureDocs.length > 0 },
  ];

  return (
    <SectionView>
      <Block className="mb-5">
        <Card padding="lg" className="relative overflow-hidden">
          <div className="pointer-events-none absolute -right-16 -top-24 h-72 w-72 rounded-full bg-accent/10 blur-3xl" />
          <div className="relative">
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-text-subtle">Project profile</div>
            <h2 className="text-[20px] font-semibold tracking-[-0.01em] text-text">{profile.type} · {profile.primaryLanguage}</h2>
            {profile.purpose && <p className="mt-2 max-w-2xl text-[13.5px] font-medium leading-relaxed text-text">{profile.purpose}</p>}
            <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-text-muted">{profile.summary}</p>
            <div className="mt-4 flex flex-wrap gap-2">
              {profile.frameworks.map((f) => <Badge key={f} tone="info">{f}</Badge>)}
              {profile.packageManager && <Badge tone="neutral">{profile.packageManager}</Badge>}
            </div>
          </div>
        </Card>
      </Block>

      <Block className="mb-5">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatTile icon="doc" label="Source files" value={profile.fileCount.toLocaleString()} tone="info" />
          <StatTile icon="knowledge" label="Code chunks" value={(status?.coding.chunks ?? 0).toLocaleString()} tone="positive" />
          <StatTile icon="architecture" label="System entities" value={(status?.fullstack.entities ?? 0).toLocaleString()} sub={`${status?.fullstack.relations ?? 0} relations`} />
          <StatTile icon="memory" label="Memory items" value={memory.length} tone="attention" />
        </div>
      </Block>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <Block className="lg:col-span-2">
          <Card>
            <CardHeader title="Languages" subtitle="By indexable file count" />
            <div className="mt-4 space-y-3">
              {profile.languages.slice(0, 8).map((l) => {
                const pct = Math.round((l.files / Math.max(1, profile.fileCount)) * 100);
                return (
                  <div key={l.name}>
                    <div className="mb-1 flex items-center justify-between text-[12px]">
                      <span className="text-text">{l.name}</span>
                      <span className="text-text-subtle tabular-nums">{l.files} files · {pct}%</span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-surface-active">
                      <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
              {profile.languages.length === 0 && <p className="text-[12.5px] text-text-muted">No recognized source files.</p>}
            </div>
          </Card>
        </Block>

        <Block>
          <Card className="h-full">
            <CardHeader title="Detected surfaces" />
            <div className="mt-4 flex flex-wrap gap-2">
              {surfaces.length ? surfaces.map((s) => (
                <span key={s} className="inline-flex items-center gap-1.5 rounded-lg bg-surface-active px-2.5 py-1 text-[12px] font-medium capitalize text-text">
                  <Icon name="check" size={12} className="text-positive" /> {s}
                </span>
              )) : <p className="text-[12.5px] text-text-muted">None detected.</p>}
            </div>
            <div className="mt-5">
              <div className="mb-2 text-[12px] font-medium text-text-muted">Jump to</div>
              <div className="grid grid-cols-2 gap-2">
                {jump.filter((j) => j.show).map((j) => (
                  <button key={j.tab} onClick={() => go(j.tab)} className="flex items-center gap-2 rounded-xl border border-line px-3 py-2 text-[12.5px] font-medium text-text transition-colors hover:bg-surface-hover">
                    <Icon name={j.icon} size={14} /> {j.label}
                  </button>
                ))}
              </div>
            </div>
          </Card>
        </Block>

        <Block className="lg:col-span-2">
          <Card>
            <CardHeader title="Folder structure" subtitle="Top-level directories" />
            <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {profile.structure.map((f) => (
                <div key={f.name} className="rounded-xl border border-line px-3 py-2.5">
                  <div className="flex items-center gap-1.5 text-[12.5px] font-medium text-text"><Icon name="folder" size={13} className="text-text-subtle" /> {f.name}</div>
                  <div className="mt-0.5 text-[11px] text-text-subtle">{f.files} files · {f.dirs} dirs</div>
                </div>
              ))}
              {profile.structure.length === 0 && <p className="text-[12.5px] text-text-muted">No sub-directories.</p>}
            </div>
          </Card>
        </Block>

        <Block>
          <Card className="h-full">
            <CardHeader title="Build & entry points" />
            <div className="mt-3 space-y-2.5 text-[12px]">
              <Meta label="Build system" value={profile.buildSystem ?? '—'} />
              <Meta label="Package manager" value={profile.packageManager ?? '—'} />
              {profile.codingStyle && <Meta label="Coding style" value={`${profile.codingStyle.indent} · ${profile.codingStyle.quotes} quotes · ${profile.codingStyle.semicolons ? 'semicolons' : 'no semicolons'}`} />}
              <div>
                <div className="text-text-subtle">Entry points</div>
                <div className="mt-1 space-y-0.5">
                  {profile.entryPoints.length ? profile.entryPoints.map((f) => <div key={f} className="truncate font-mono text-[11px] text-text-muted">{f}</div>) : <span className="text-text-muted">—</span>}
                </div>
              </div>
              <div>
                <div className="text-text-subtle">Important files</div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {profile.importantFiles.slice(0, 8).map((f) => <span key={f} className="rounded bg-surface-active px-1.5 py-0.5 font-mono text-[10px] text-text-muted">{f}</span>)}
                </div>
              </div>
            </div>
          </Card>
        </Block>

        <Block className="lg:col-span-2">
          <Card className="h-full">
            <CardHeader title="Top dependencies" subtitle={`${profile.dependencies.length} total`} />
            <div className="mt-3 space-y-1.5">
              {profile.dependencies.filter((d) => d.kind === 'runtime').slice(0, 8).map((d) => (
                <div key={d.name} className="flex items-center justify-between text-[12px]">
                  <span className="truncate font-mono text-text">{d.name}</span>
                  <span className="shrink-0 text-text-subtle">{d.version}</span>
                </div>
              ))}
              {profile.dependencies.length === 0 && <p className="text-[12.5px] text-text-muted">No manifest dependencies.</p>}
            </div>
          </Card>
        </Block>
      </div>
    </SectionView>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-text-subtle">{label}</span>
      <span className="truncate text-right font-medium text-text">{value}</span>
    </div>
  );
}
