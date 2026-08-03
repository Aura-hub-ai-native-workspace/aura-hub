import { useState, useEffect, useMemo, useCallback } from 'react';
import { SectionView, Block, StatTile, Meter } from '../screens/project/components/kit';
import { EmptyState } from '../components/EmptyState';
import { useWorkspace } from '../data/useWorkspace';
import { missionClient, type MissionSummary } from '../ai/missionClient';
import { aiClient, type ProjectIntelligence, type ArchitectureLayer } from '../ai/aiClient';
import { Badge, Card, CardHeader, Icon } from '@aura/ui';

interface TwinModule {
  id: string;
  title: string;
  subtitle: string;
  icon: string;
  tone: 'positive' | 'attention' | 'critical' | 'info' | 'neutral';
  status: 'loading' | 'ready' | 'empty' | 'error';
  children: React.ReactNode;
}

export function EngineeringTwin() {
  const { openId, profile, graph } = useWorkspace();
  const [intelligence, setIntelligence] = useState<ProjectIntelligence | null>(null);
  const [archLayers, setArchLayers] = useState<ArchitectureLayer[]>([]);
  const [missions, setMissions] = useState<MissionSummary[]>([]);
  const [changeLog, setChangeLog] = useState<{ entries: Array<{ file: string; timestamp: string; type: string; size: number; linesAdded: number; linesRemoved: number }>; patterns: Array<{ pattern: string; frequency: number; files: string[]; lastOccurrence: string }>; velocity: number; hotspots: Array<{ file: string; score: number; reason: string }> } | null>(null);
  const [twinReady, setTwinReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadTwin = useCallback(async () => {
    if (!openId) return;
    try {
      const [intel, layers, missionsRes, changeRes] = await Promise.all([
        aiClient.projectIntelligence(openId),
        aiClient.projectArchitectureLayers(openId),
        missionClient.list(openId),
        fetch(`${aiClient.base}/projects/${openId}/changes`).then(r => r.ok ? r.json() : null).catch(() => null),
      ]);
      setIntelligence(intel);
      setArchLayers(layers.layers ?? []);
      setMissions(missionsRes.missions ?? []);
      setChangeLog(changeRes);
      setLoadError(null);
    } catch (e) {
      // Keep whatever data we already have (a transient refresh failure
      // shouldn't blank out a working view) — but do surface the failure so
      // modules with no data yet show "error", not a misleading "empty".
      setLoadError((e as Error)?.message || 'Failed to load twin data');
    } finally {
      setTwinReady(true);
    }
  }, [openId]);

  useEffect(() => {
    void loadTwin();
  }, [loadTwin]);

  const twinModules = useMemo<TwinModule[]>(() => {
    const ver = intelligence?.verification;
    const val = intelligence?.validation;
    const twinChange = intelligence?.change;

    return [
      {
        id: 'overview',
        title: 'Twin Overview',
        subtitle: 'Live repository state across all dimensions',
        icon: 'cpu',
        tone: 'info',
        status: twinReady ? (profile ? 'ready' : loadError ? 'error' : 'empty') : 'loading',
        children: twinReady && profile ? (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <StatTile icon="folder" label="Files" value={profile.fileCount.toLocaleString()} tone="info" />
            <StatTile icon="code" label="Languages" value={profile.languages.length} tone="positive" sub={profile.languages.map(l => `${l.name} (${l.files})`).join(', ') || 'none'} />
            <StatTile icon="link" label="Dependencies" value={profile.dependencies.length} tone="attention" sub={`${profile.dependencies.filter(d => d.kind === 'runtime').length} runtime · ${profile.dependencies.filter(d => d.kind === 'dev').length} dev`} />
            <StatTile icon="spark" label="Frameworks" value={profile.frameworks.length} tone="info" sub={profile.frameworks.join(', ') || 'none'} />
            <StatTile icon="check" label="Verification" value={ver ? `${Math.round(ver.overallScore)}%` : '—'} tone={ver && ver.overallScore >= 70 ? 'positive' : ver ? 'attention' : 'neutral'} />
            <StatTile icon="flask" label="Validation" value={val ? `${val.score}%` : '—'} tone={val && val.score >= 70 ? 'positive' : val ? 'attention' : 'neutral'} />
            <StatTile icon="cpu" label="Change velocity" value={twinChange ? (twinChange.velocity > 0 ? `${twinChange.velocity}/wk` : 'stable') : '—'} tone={twinChange && twinChange.velocity > 5 ? 'critical' : twinChange && twinChange.velocity > 0 ? 'attention' : 'neutral'} />
            <StatTile icon="activity" label="Hotspots" value={twinChange?.hotspots.length ?? 0} tone={twinChange && twinChange.hotspots.length > 3 ? 'critical' : twinChange && twinChange.hotspots.length > 0 ? 'attention' : 'neutral'} />
          </div>
        ) : (
          <EmptyState icon="cpu" title="No repository data" description="Open a project to populate the Engineering Twin." compact />
        ),
      },
      {
        id: 'repository-timeline',
        title: 'Repository Timeline',
        subtitle: 'File-level change history from the change intelligence log',
        icon: 'timeline',
        tone: 'info',
        status: twinReady ? (changeLog ? 'ready' : loadError ? 'error' : 'empty') : 'loading',
        children: twinReady && changeLog ? (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <StatTile icon="cpu" label="Change velocity" value={changeLog.velocity > 0 ? `${changeLog.velocity}/wk` : 'stable'} tone={changeLog.velocity > 5 ? 'critical' : changeLog.velocity > 0 ? 'attention' : 'positive'} />
              <StatTile icon="flask" label="Hotspots" value={changeLog.hotspots.length} tone={changeLog.hotspots.length > 3 ? 'critical' : changeLog.hotspots.length > 0 ? 'attention' : 'neutral'} />
            </div>
            {changeLog.entries.length > 0 && (
              <div className="max-h-[300px] overflow-y-auto space-y-1">
                {changeLog.entries.slice(0, 30).map((e, i) => (
                  <div key={i} className="flex items-center gap-2 text-[12px]">
                    <span className={`w-2 h-2 shrink-0 rounded-full ${e.type === 'modify' ? 'bg-accent' : e.type === 'create' ? 'bg-positive' : e.type === 'delete' ? 'bg-danger' : 'bg-text-muted'}`} />
                    <span className="font-mono text-text-muted truncate flex-1">{e.file}</span>
                    <span className="text-text-subtle tabular-nums">+{e.linesAdded}/-{e.linesRemoved}</span>
                  </div>
                ))}
              </div>
            )}
            {changeLog.patterns.length > 0 && (
              <div>
                <div className="text-[11.5px] font-semibold text-text-muted uppercase tracking-wider mb-2">Patterns</div>
                {changeLog.patterns.slice(0, 5).map((p, i) => (
                  <div key={i} className="text-[12px] text-text-muted">{p.pattern} — {p.frequency}x in {p.files.length} files</div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <EmptyState icon="activity" title="No change history" description="Run missions to build the change intelligence log." compact />
        ),
      },
      {
        id: 'architecture-timeline',
        title: 'Architecture Timeline',
        subtitle: 'Architecture layer evolution and entry point changes',
        icon: 'architecture',
        tone: 'info',
        status: twinReady ? (archLayers.length > 0 ? 'ready' : loadError ? 'error' : 'empty') : 'loading',
        children: twinReady && archLayers.length > 0 ? (
          <div className="space-y-2">
            {archLayers.map((layer, i) => (
              <div key={i} className="flex items-center gap-3 text-[12px]">
                <span className="h-3 w-3 shrink-0 rounded" style={{ background: layer.color }} />
                <span className="text-text font-medium">{layer.title}</span>
                {layer.subtitle && <span className="text-text-muted">· {layer.subtitle}</span>}
                {layer.items && <span className="text-text-subtle tabular-nums">{layer.items.length} items</span>}
              </div>
            ))}
          </div>
        ) : (
          <EmptyState icon="architecture" title="No architecture layers" description="Index the project to detect architecture layers." compact />
        ),
      },
      {
        id: 'dependency-timeline',
        title: 'Dependency Timeline',
        subtitle: 'Dependency changes and version evolution',
        icon: 'package',
        tone: 'attention',
        status: twinReady ? (profile && profile.dependencies.length > 0 ? 'ready' : loadError ? 'error' : 'empty') : 'loading',
        children: twinReady && profile && profile.dependencies.length > 0 ? (
          <div className="space-y-2 max-h-[300px] overflow-y-auto">
            {profile.dependencies.slice(0, 20).map((d, i) => (
              <div key={i} className="flex items-center justify-between text-[12px]">
                <span className="text-text font-medium">{d.name}</span>
                <span className="font-mono text-text-muted text-[11px]">{d.version}</span>
                <Badge tone={d.kind === 'runtime' ? 'positive' : 'info'} className="text-[10px]">{d.kind}</Badge>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState icon="folder" title="No dependencies" description="The project profile has no recorded dependencies." compact />
        ),
      },
      {
        id: 'risk-map',
        title: 'Risk Map',
        subtitle: 'Risk scoring per file based on change frequency and complexity',
        icon: 'shield',
        tone: 'critical',
        status: twinReady ? (changeLog && changeLog.hotspots.length > 0 ? 'ready' : loadError ? 'error' : 'empty') : 'loading',
        children: twinReady && changeLog && changeLog.hotspots.length > 0 ? (
          <div className="space-y-2">
            {changeLog.hotspots.slice(0, 10).map((h, i) => (
              <div key={i} className="flex items-center gap-3 text-[12px]">
                <span className="w-5 shrink-0 text-[11px] text-text-muted tabular-nums">#{i + 1}</span>
                <span className="font-mono text-text-muted truncate flex-1">{h.file}</span>
                <Meter label="" value={Math.min(100, h.score * 20)} tone={h.score > 5 ? 'critical' : h.score > 2 ? 'attention' : 'positive'} />
                <span className="text-[10px] text-text-subtle w-24 text-right">{h.reason}</span>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState icon="shield" title="No risk hotspots" description="Run missions to detect change hotspots." compact />
        ),
      },
      {
        id: 'heat-map',
        title: 'Heat Map',
        subtitle: 'Change frequency across the repository',
        icon: 'fire',
        tone: 'critical',
        status: twinReady ? (changeLog && changeLog.entries.length > 0 ? 'ready' : loadError ? 'error' : 'empty') : 'loading',
        children: twinReady && changeLog && changeLog.entries.length > 0 ? (
          <div className="space-y-2">
            <div className="text-[11.5px] text-text-muted">{changeLog.entries.length} files tracked · {changeLog.entries.reduce((a, e) => a + e.linesAdded + e.linesRemoved, 0).toLocaleString()} total lines changed</div>
            <div className="grid grid-cols-5 gap-1.5">
              {changeLog.entries.slice(0, 25).map((e, i) => {
                const totalChanges = e.linesAdded + e.linesRemoved;
                const intensity = Math.min(1, totalChanges / 100);
                const bg = intensity > 0.7 ? 'bg-danger/30' : intensity > 0.4 ? 'bg-attention/30' : intensity > 0.1 ? 'bg-accent/20' : 'bg-surface-active';
                return (
                  <div key={i} className={`rounded-lg p-2 text-center ${bg}`}>
                    <div className="text-[10px] font-mono text-text-muted truncate">{e.file.split('/').pop()}</div>
                    <div className="text-[11px] font-semibold text-text tabular-nums">{totalChanges}</div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <EmptyState icon="flask" title="No change data" description="Run missions to populate the heat map." compact />
        ),
      },
      {
        id: 'change-replay',
        title: 'Change Replay',
        subtitle: 'Replay mission execution changes over time',
        icon: 'activity',
        tone: 'info',
        status: twinReady ? (missions.length > 0 ? 'ready' : loadError ? 'error' : 'empty') : 'loading',
        children: twinReady && missions.length > 0 ? (
          <div className="space-y-2 max-h-[300px] overflow-y-auto">
            {missions.slice(0, 15).map((m, i) => (
              <div key={m.id} className="flex items-center gap-3 text-[12px]">
                <span className="text-text-muted tabular-nums w-5">#{i + 1}</span>
                <span className="text-text font-medium truncate flex-1">{m.text}</span>
                <Badge tone={m.execution?.status === 'completed' ? 'positive' : m.execution?.status === 'failed' ? 'critical' : m.execution?.status === 'reviewing' ? 'attention' : 'info'} className="text-[10px]">{m.execution?.status ?? 'plan'}</Badge>
                <span className="text-text-subtle text-[11px]">{m.category}</span>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState icon="activity" title="No mission history" description="Run missions to populate the change replay." compact />
        ),
      },
      {
        id: 'relationship-explorer',
        title: 'Relationship Explorer',
        subtitle: 'Cross-cutting relationships between entities',
        icon: 'link',
        tone: 'info',
        status: twinReady ? (graph && graph.entities.length > 0 ? 'ready' : loadError ? 'error' : 'empty') : 'loading',
        children: twinReady && graph && graph.entities.length > 0 ? (
          <div className="space-y-2 max-h-[300px] overflow-y-auto">
            {graph.entities.slice(0, 50).map((e) => (
              <div key={e.id} className="flex items-start gap-2 text-[12px]">
                <span className="mt-0.5 shrink-0 text-text-subtle">●</span>
                <div className="min-w-0">
                  <div className="truncate text-text">{e.name}</div>
                  <div className="truncate font-mono text-[10.5px] text-text-subtle">{e.kind} · {e.layer}{e.relPath ? ` · ${e.relPath}` : ''}</div>
                </div>
              </div>
            ))}
            {graph.entities.length > 50 && <p className="text-[11px] text-text-muted text-center">Showing 50 of {graph.entities.length} entities</p>}
          </div>
        ) : (
          <EmptyState icon="link" title="No relationships" description="Index the project to populate the relationship explorer." compact />
        ),
      },
      {
        id: 'twin-diff',
        title: 'Twin Diff',
        subtitle: 'Compare twin states across versions',
        icon: 'git-branch',
        tone: 'neutral',
        status: twinReady ? (intelligence ? 'ready' : loadError ? 'error' : 'empty') : 'loading',
        children: twinReady && intelligence ? (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <StatTile icon="check" label="Verification" value={`${Math.round(intelligence.verification.overallScore)}%`} tone={intelligence.verification.overallScore >= 70 ? 'positive' : 'attention'} />
              <StatTile icon="flask" label="Validation" value={`${intelligence.validation.score}%`} tone={intelligence.validation.score >= 70 ? 'positive' : 'attention'} />
            </div>
            {intelligence.change.hotspots.length > 0 && (
              <div>
                <div className="text-[11.5px] font-semibold text-text-muted uppercase tracking-wider mb-2">Active Hotspots</div>
                <div className="space-y-1">
                  {intelligence.change.hotspots.slice(0, 5).map((h, i) => (
                    <div key={i} className="flex items-center gap-2 text-[12px]">
                      <span className="font-mono text-text-muted truncate flex-1">{h.file}</span>
                      <span className="text-[10px] text-text-subtle">{h.reason}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {intelligence.verification.recommendations.length > 0 && (
              <div>
                <div className="text-[11.5px] font-semibold text-text-muted uppercase tracking-wider mb-2">Recommendations</div>
                {intelligence.verification.recommendations.slice(0, 3).map((r, i) => (
                  <div key={i} className="flex items-start gap-2 text-[12px] text-text-muted"><Icon name="arrow-right" size={12} className="mt-0.5 shrink-0 text-accent" /><span>{r}</span></div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <EmptyState icon="git-branch" title="No twin diff data" description="Run missions to build the intelligence profile." compact />
        ),
      },
    ];
  }, [twinReady, profile, intelligence, archLayers, missions, changeLog, loadError]);

  if (!openId) {
    return (
      <SectionView title="Engineering Twin">
        <EmptyState icon="cpu" title="No project open" description="Open a project to build its Engineering Twin." />
      </SectionView>
    );
  }

  return (
    <SectionView title="Engineering Twin" hint="A live digital twin of the repository — deterministic, derived from existing platform data.">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3">
        {twinModules.map((mod) => (
          <Block key={mod.id}>
            <Card>
              <CardHeader title={mod.title} subtitle={mod.subtitle} />
              <div className="px-4 pb-4">
                {mod.status === 'loading' ? (
                  <div className="space-y-2">
                    {Array.from({ length: 3 }).map((_, i) => (
                      <div key={i} className="h-8 animate-pulse rounded-xl bg-surface-active" />
                    ))}
                  </div>
                ) : mod.status === 'empty' ? (
                  <EmptyState icon="cpu" title="No data yet" description="Open a project and run missions to populate the twin." compact />
                ) : mod.status === 'error' ? (
                  <EmptyState icon="cpu" title="Error loading twin data" description="Try refreshing the twin." compact />
                ) : (
                  mod.children
                )}
              </div>
            </Card>
          </Block>
        ))}
      </div>
    </SectionView>
  );
}