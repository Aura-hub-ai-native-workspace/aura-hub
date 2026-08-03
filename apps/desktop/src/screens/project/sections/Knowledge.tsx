import { useEffect, useMemo, useState, useCallback } from 'react';
import { Button, Card, CardHeader, Icon, Input } from '@aura/ui';
import { SectionView, Block, StatTile, Meter } from '../components/kit';
import { EmptyState } from '../../../components/EmptyState';
import { useProjectData } from './shared';
import { aiClient, type KGNode, type RetrieveResult, type ProjectIntelligence, type ArchitectureLayer, type ProjectProfile } from '../../../ai/aiClient';
import { NodeGraphCanvas, type NodeCardData, type NodeCardEdge } from '../../../components/NodeGraphCanvas';

const KG_COLORS: Record<string, string> = {
  frontend: '#3b82f6', backend: '#22c55e', database: '#f59e0b', config: '#8b5cf6',
  docs: '#06b6d4', memory: '#ec4899', conversation: '#a855f7', code: '#60a5fa',
  service: '#14b8a6', module: '#818cf8', other: '#64748b',
};

interface SectionCardProps {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}

function SectionCard({ title, subtitle, children }: SectionCardProps) {
  return (
    <Card>
      <CardHeader title={title} subtitle={subtitle} />
      <div className="px-4 pb-4">{children}</div>
    </Card>
  );
}

export function Knowledge({ projectId }: { projectId: string }) {
  const { ready, status, kg, profile, graph } = useProjectData(projectId);
  const [intelligence, setIntelligence] = useState<ProjectIntelligence | null>(null);
  const [archLayers, setArchLayers] = useState<ArchitectureLayer[]>([]);
  const [searchQ, setSearchQ] = useState('');
  const [searchRes, setSearchRes] = useState<RetrieveResult | null>(null);
  const [searchBusy, setSearchBusy] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  const loadIntelligence = useCallback(async () => {
    try {
      const [intel, , layers, ] = await Promise.all([
        aiClient.projectIntelligence(projectId),
        aiClient.workspaceIntelligence(),
        aiClient.projectArchitectureLayers(projectId),
        aiClient.indexStatus(),
      ]);
      setIntelligence(intel);
      setArchLayers(layers.layers ?? []);
    } catch {
      /* keep previous */
    }
  }, [projectId]);

  // Load once real data exists, and again whenever it transitions from
  // still-indexing to ready — previously this only ever ran from the
  // manual Refresh button, so every panel on this screen showed its empty
  // state on first visit even when the project was already fully indexed.
  useEffect(() => {
    if (ready && status?.phase === 'ready') void loadIntelligence();
  }, [ready, status?.phase, loadIntelligence]);

  const runSearch = useCallback(async () => {
    if (!searchQ.trim()) return;
    setSearchBusy(true);
    try {
      const res = await aiClient.retrieve(searchQ.trim());
      setSearchRes(res);
    } catch {
      setSearchRes({ entries: [], totalTokens: 0 });
    }
    setSearchBusy(false);
  }, [searchQ]);

  // Below this many real entities, render every one individually. Above
  // it, group members start collapsed into one cluster card per KG group
  // (the same summary shape the graph used to show unconditionally) —
  // `expandedGroups` promotes a cluster back to its real member entities.
  const CLUSTER_THRESHOLD = 60;
  const kgNodeCount = kg?.nodes.length ?? 0;
  const clustering = kgNodeCount > CLUSTER_THRESHOLD;

  const { cards, cardEdges } = useMemo(() => {
    const kgNodes = kg?.nodes ?? [];
    const kgEdges = kg?.edges ?? [];
    const idToGroup = new Map<string, string>();
    const grouped = new Map<string, KGNode[]>();
    for (const n of kgNodes) {
      idToGroup.set(n.id, n.group);
      const list = grouped.get(n.group) ?? [];
      list.push(n);
      grouped.set(n.group, list);
    }
    const groups = [...grouped.keys()].sort();
    const isExpanded = (g: string) => !clustering || expandedGroups.has(g);

    const nodes: NodeCardData[] = [];
    for (const g of groups) {
      const items = grouped.get(g) ?? [];
      if (isExpanded(g)) {
        for (const n of items) {
          nodes.push({
            id: n.id,
            title: n.label,
            fullTitle: n.relPath ? `${n.label} · ${n.relPath}` : n.label,
            group: n.group,
            rows: [
              { label: 'Type', value: n.type },
              ...(n.relPath ? [{ label: 'File', value: n.relPath }] : []),
              ...(n.line ? [{ label: 'Line', value: String(n.line) }] : []),
            ],
            note: n.detail,
          });
        }
        continue;
      }
      const typeCounts = new Map<string, number>();
      const files = new Set<string>();
      for (const n of items) {
        typeCounts.set(n.type, (typeCounts.get(n.type) ?? 0) + 1);
        if (n.relPath) files.add(n.relPath);
      }
      const topType = [...typeCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '—';
      nodes.push({
        id: `cluster:${g}`,
        title: `${g} (${items.length})`,
        group: g,
        rows: [
          { label: 'Nodes', value: String(items.length) },
          { label: 'Files', value: String(files.size) },
          { label: 'Top type', value: topType },
        ],
        note: 'Click to expand',
      });
    }

    // Entity-to-entity edges when both endpoints are expanded; otherwise
    // aggregated down to whichever side(s) are still a collapsed cluster,
    // so a cross-cluster relationship is never just dropped.
    const nodeIdFor = (id: string, group: string) => (isExpanded(group) ? id : `cluster:${group}`);
    const edgeCounts = new Map<string, number>();
    for (const e of kgEdges) {
      const fg = idToGroup.get(e.from);
      const tg = idToGroup.get(e.to);
      if (!fg || !tg) continue;
      const from = nodeIdFor(e.from, fg);
      const to = nodeIdFor(e.to, tg);
      if (from === to) continue;
      const key = `${from}|${to}|${e.kind}`;
      edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
    }
    const edges: NodeCardEdge[] = [...edgeCounts.keys()].map((key) => {
      const [from, to, kind] = key.split('|');
      return { from, to, kind };
    });
    return { cards: nodes, cardEdges: edges };
  }, [kg, clustering, expandedGroups]);

  // Clicking a collapsed cluster card expands it; clicking a real entity
  // card selects it (existing highlight/detail behavior, unchanged).
  const handleGraphSelect = useCallback((id: string | null) => {
    if (id?.startsWith('cluster:')) {
      const g = id.slice('cluster:'.length);
      setExpandedGroups((prev) => new Set(prev).add(g));
      return;
    }
    setSelectedGroup(id);
  }, []);
  const collapseGroup = useCallback((g: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      next.delete(g);
      return next;
    });
  }, []);

  const mostConnected = useMemo(() => {
    if (!kg) return [];
    const degree = new Map<string, number>();
    for (const n of kg.nodes) degree.set(n.id, 0);
    for (const e of kg.edges) {
      degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
      degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
    }
    return [...degree.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  }, [kg]);

  const depGroups = useMemo(() => {
    if (!profile) return [];
    const byKind = new Map<string, ProjectProfile['dependencies']>();
    for (const d of profile.dependencies ?? []) {
      const list = byKind.get(d.kind) ?? [];
      list.push(d);
      byKind.set(d.kind, list);
    }
    return [...byKind.entries()];
  }, [profile]);

  if (!ready || !status || status.phase === 'empty') {
    return <SectionView title="Engineering Intelligence"><EmptyState icon="knowledge" title="Not indexed yet" description="Open the project to build its indexes." /></SectionView>;
  }

  const ver = intelligence?.verification;
  const val = intelligence?.validation;
  const change = intelligence?.change;
  const arch = intelligence?.architecture;

  return (
    <SectionView
      title="Engineering Intelligence"
      hint="Real indexed data — verification, architecture, dependencies, knowledge graph, and AI understanding."
      actions={
        <div className="flex gap-2">
          <Button icon="refresh" onClick={loadIntelligence} variant="ghost" size="sm">Refresh</Button>
        </div>
      }
    >
      <Block className="mb-5">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <StatTile icon="check" label="Verification" value={ver ? `${Math.round(ver.overallScore)}%` : '—'} tone={ver && ver.overallScore >= 70 ? 'positive' : ver ? 'attention' : 'neutral'} sub={ver?.summary} />
          <StatTile icon="architecture" label="Entities" value={status.fullstack.entities.toLocaleString()} tone="info" sub={`${status.fullstack.relations} relations`} />
          <StatTile icon="link" label="Dependencies" value={profile?.dependencies?.length ?? 0} tone="attention" sub={`${profile?.frameworks?.length ?? 0} frameworks`} />
          <StatTile icon="cpu" label="Change velocity" value={change ? (change.velocity > 0 ? `${change.velocity}/wk` : 'stable') : '—'} tone={change && change.velocity > 5 ? 'critical' : change && change.velocity > 0 ? 'attention' : 'positive'} sub={change?.hotspots.length ? `${change.hotspots.length} hotspots` : 'no hotspots'} />
        </div>
      </Block>

      <Block className="mb-5">
        <SectionCard title="Project Intelligence" subtitle="Verification, validation, and AI understanding of this repository">
          {ver ? (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <div className="text-[11.5px] text-text-muted mb-1">Verification Score</div>
                  <Meter label="" value={ver.overallScore} tone={ver.overallScore >= 70 ? 'positive' : ver.overallScore >= 40 ? 'attention' : 'critical'} />
                </div>
                <div>
                  <div className="text-[11.5px] text-text-muted mb-1">Validation Score</div>
                  <Meter label="" value={val ? val.score : 0} tone={val && val.score >= 70 ? 'positive' : val ? 'attention' : 'neutral'} />
                </div>
              </div>
              {ver.sections.length > 0 && (
                <div className="space-y-1.5">
                  <div className="text-[11.5px] font-semibold text-text-muted uppercase tracking-wider">Verification Sections</div>
                  {ver.sections.map((s, i) => (
                    <div key={i} className="flex items-center justify-between text-[12px]">
                      <span className="text-text">{s.name}</span>
                      <span className={`text-[10.5px] font-semibold ${s.status === 'pass' ? 'text-positive' : s.status === 'warn' ? 'text-attention' : 'text-danger'}`}>{s.status} · {s.score}</span>
                    </div>
                  ))}
                </div>
              )}
              {ver.recommendations.length > 0 && (
                <div className="space-y-1">
                  <div className="text-[11.5px] font-semibold text-text-muted uppercase tracking-wider">Recommendations</div>
                  {ver.recommendations.slice(0, 5).map((r, i) => (
                    <div key={i} className="flex items-start gap-2 text-[12px] text-text-muted"><Icon name="arrow-right" size={12} className="mt-0.5 shrink-0 text-accent" /><span>{r}</span></div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <EmptyState icon="research" title="Intelligence not yet computed" description="Run a mission to build the project intelligence profile." compact />
          )}
        </SectionCard>
      </Block>

      <Block className="mb-5 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SectionCard title="Architecture Overview" subtitle="Module hierarchy, entry points, and architecture layers">
          {arch ? (
            <div className="space-y-3">
              {arch.entryPoints.length > 0 && (
                <div>
                  <div className="text-[11.5px] font-semibold text-text-muted uppercase tracking-wider mb-2">Entry Points</div>
                  <div className="space-y-1">
                    {arch.entryPoints.slice(0, 6).map((ep, i) => (
                      <div key={i} className="flex items-center gap-2 text-[12px]">
                        <span className="text-accent">●</span>
                        <span className="font-mono text-text-muted truncate">{ep.file}</span>
                        <span className="text-[10.5px] text-text-subtle">{ep.type}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {archLayers.length > 0 && (
                <div>
                  <div className="text-[11.5px] font-semibold text-text-muted uppercase tracking-wider mb-2">Architecture Layers</div>
                  <div className="space-y-1.5">
                    {archLayers.map((layer, i) => (
                      <div key={i} className="flex items-center gap-2 text-[12px]">
                        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: layer.color }} />
                        <span className="text-text">{layer.title}</span>
                        {layer.subtitle && <span className="text-text-muted">· {layer.subtitle}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {arch.apiSurface && (
                <div className="text-[11.5px] text-text-muted">
                  API surface: {arch.apiSurface.endpoints.length} endpoints · {arch.apiSurface.classes.length} classes · {arch.apiSurface.functions.length} functions
                </div>
              )}
            </div>
          ) : (
            <EmptyState icon="architecture" title="No architecture data" description="Index the project to detect architecture layers and entry points." compact />
          )}
        </SectionCard>

        <SectionCard title="Repository Statistics" subtitle="Files, dependencies, frameworks, and project profile">
          {profile ? (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <StatTile icon="doc" label="Files" value={profile.fileCount.toLocaleString()} tone="info" />
                <StatTile icon="code" label="Languages" value={profile.languages.length} tone="positive" sub={profile.languages.map(l => `${l.name} (${l.files})`).join(', ') || 'none'} />
                <StatTile icon="link" label="Dependencies" value={profile.dependencies.length} tone="attention" sub={`${profile.dependencies.filter(d => d.kind === 'runtime').length} runtime · ${profile.dependencies.filter(d => d.kind === 'dev').length} dev`} />
                <StatTile icon="spark" label="Frameworks" value={profile.frameworks.length} tone="info" sub={profile.frameworks.join(', ') || 'none detected'} />
              </div>
              {profile.has && (
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(profile.has).filter(([, v]) => v).map(([k]) => (
                    <span key={k} className="text-[10.5px] font-semibold rounded-full px-2 py-0.5 bg-positive/10 text-positive capitalize">{k}</span>
                  ))}
                </div>
              )}
              {profile.packageManager && (
                <div className="text-[12px] text-text-muted">Package manager: <span className="text-text font-medium">{profile.packageManager}</span></div>
              )}
              {profile.buildSystem && (
                <div className="text-[12px] text-text-muted">Build system: <span className="text-text font-medium">{profile.buildSystem}</span></div>
              )}
            </div>
          ) : (
            <EmptyState icon="folder" title="No profile data" description="Open the project to load its profile." compact />
          )}
        </SectionCard>
      </Block>

      <Block className="mb-5 grid grid-cols-1 gap-4 xl:grid-cols-[1fr_360px]">
        <SectionCard
          title="Knowledge Graph"
          subtitle={clustering ? 'Every real entity — grouped into clusters until expanded. Click a cluster to open it.' : 'Every real entity — hover to trace, click to inspect'}
        >
          {cards.length === 0 ? (
            <div className="mt-4 flex h-[400px] items-center justify-center rounded-2xl border border-line" style={{ background: '#0a0e17' }}>
              <div className="text-center">
                <Icon name="knowledge" size={26} className="mx-auto animate-pulse text-accent" />
                <p className="mt-3 text-[13px] text-text-muted">{status.phase === 'ready' ? 'No graph entities detected.' : 'Building the knowledge graph…'}</p>
              </div>
            </div>
          ) : (
            <div className="mt-4">
              {expandedGroups.size > 0 && (
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {[...expandedGroups].sort().map((g) => (
                    <button
                      key={g}
                      onClick={() => collapseGroup(g)}
                      className="inline-flex items-center gap-1 rounded-full border border-line bg-surface-active px-2 py-0.5 text-[10.5px] capitalize text-text-muted transition-colors hover:text-text"
                      title={`Collapse ${g}`}
                    >
                      {g}
                      <Icon name="close" size={9} />
                    </button>
                  ))}
                </div>
              )}
              <NodeGraphCanvas nodes={cards} edges={cardEdges} groupColors={KG_COLORS} height={450} onSelect={handleGraphSelect} selectedId={selectedGroup} />
            </div>
          )}
        </SectionCard>

        <SectionCard title="Relationship Explorer" subtitle="Graph entities grouped by kind — click to inspect">
          {graph && graph.entities.length > 0 ? (
            <div className="space-y-2 max-h-[450px] overflow-y-auto">
              {graph.entities.slice(0, 80).map((e) => (
                <div key={e.id} className="flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-surface-hover transition-colors">
                  <span className="mt-1.5 shrink-0 text-[10px] text-text-subtle">●</span>
                  <div className="min-w-0">
                    <div className="truncate text-[12px] font-medium text-text">{e.name}</div>
                    <div className="truncate font-mono text-[10.5px] text-text-subtle">{e.kind} · {e.layer}{e.relPath ? ` · ${e.relPath}` : ''}</div>
                  </div>
                </div>
              ))}
              {graph.entities.length > 80 && <p className="text-[11px] text-text-muted text-center">Showing 80 of {graph.entities.length} entities</p>}
            </div>
          ) : (
            <EmptyState icon="link" title="No graph entities" description="Index the project to populate the relationship explorer." compact />
          )}
        </SectionCard>
      </Block>

      <Block className="mb-5 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SectionCard title="Symbol Search" subtitle="Search the codebase with the Coding Knowledge Engine">
          <div className="mt-2 flex gap-2">
            <Input icon="search" placeholder="e.g. authentication handler" value={searchQ} onChange={(e) => setSearchQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runSearch()} className="flex-1" />
            <Button icon="spark" onClick={runSearch} disabled={searchBusy}>{searchBusy ? 'Searching…' : 'Search'}</Button>
          </div>
          {searchRes && (
            <div className="mt-4 space-y-3">
              <div className="text-[11.5px] text-text-muted">{searchRes.entries.length} results · {searchRes.totalTokens} tokens</div>
              {searchRes.entries.length === 0 ? (
                <p className="text-[12px] text-text-muted">No matching code found.</p>
              ) : (
                searchRes.entries.map((e, i) => (
                  <div key={i} className="overflow-hidden rounded-xl border border-line">
                    <div className="flex items-center justify-between bg-surface-active/60 px-3 py-2">
                      <span className="flex items-center gap-1.5 truncate font-mono text-[11.5px] text-text"><Icon name="doc" size={12} /> {e.source}</span>
                      <span className="shrink-0 text-[10.5px] text-text-subtle">score {e.score.toFixed(2)}</span>
                    </div>
                    <pre className="max-h-32 overflow-auto px-3 py-2 text-[11px] leading-relaxed text-text-muted"><code>{e.snippet}</code></pre>
                  </div>
                ))
              )}
            </div>
          )}
        </SectionCard>

        <SectionCard title="Engineering Timeline" subtitle="Change hotspots, velocity, and patterns">
          {change ? (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <StatTile icon="cpu" label="Change velocity" value={change.velocity > 0 ? `${change.velocity}/wk` : 'stable'} tone={change.velocity > 5 ? 'critical' : change.velocity > 0 ? 'attention' : 'positive'} />
                <StatTile icon="flask" label="Hotspots" value={change.hotspots.length} tone={change.hotspots.length > 3 ? 'critical' : change.hotspots.length > 0 ? 'attention' : 'neutral'} />
              </div>
              {change.hotspots.length > 0 && (
                <div>
                  <div className="text-[11.5px] font-semibold text-text-muted uppercase tracking-wider mb-2">Hotspot Files</div>
                  <div className="space-y-1.5">
                    {change.hotspots.slice(0, 8).map((h, i) => (
                      <div key={i} className="flex items-center justify-between text-[12px]">
                        <span className="font-mono text-text-muted truncate">{h.file}</span>
                        <div className="flex items-center gap-2">
                          <Meter label="" value={Math.min(100, h.score * 20)} tone={h.score > 5 ? 'critical' : h.score > 2 ? 'attention' : 'positive'} />
                          <span className="text-[10px] text-text-subtle w-16 text-right">{h.reason}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {change.patterns.length > 0 && (
                <div>
                  <div className="text-[11.5px] font-semibold text-text-muted uppercase tracking-wider mb-2">Change Patterns</div>
                  <div className="space-y-1">
                    {(change.patterns as Array<{pattern: string; frequency: number; files: string[]; lastOccurrence: string}>)
                      .slice(0, 5)
                      .map((p, i) => (
                      <div key={i} className="text-[12px] text-text-muted">{p.pattern} — {p.frequency}x in {p.files.length} files</div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <EmptyState icon="activity" title="No change history" description="Run missions to build the engineering timeline." compact />
          )}
        </SectionCard>
      </Block>

      <Block className="mb-5 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <SectionCard title="AI Understanding Summary" subtitle="How AURA understands this project">
          {val ? (
            <div className="space-y-3">
              <div className="text-center">
                <Meter label="Overall" value={val.score} tone={val.score >= 70 ? 'positive' : val.score >= 40 ? 'attention' : 'critical'} />
              </div>
              {val.passedRules.length > 0 && (
                <div>
                  <div className="text-[11.5px] font-semibold text-text-muted uppercase tracking-wider mb-1">Passed Rules</div>
                  <div className="flex flex-wrap gap-1">
                    {val.passedRules.slice(0, 8).map((r) => (
                      <span key={r} className="text-[10.5px] font-semibold rounded-full px-2 py-0.5 bg-positive/10 text-positive">{r}</span>
                    ))}
                  </div>
                </div>
              )}
              {val.violations.length > 0 && (
                <div>
                  <div className="text-[11.5px] font-semibold text-text-muted uppercase tracking-wider mb-1">Violations</div>
                  <div className="space-y-1 max-h-[200px] overflow-y-auto">
                    {val.violations.slice(0, 6).map((v, i) => (
                      <div key={i} className="text-[11px]">
                        <span className="font-medium text-text">{v.rule}</span>
                        <span className="text-text-muted ml-1">{v.severity}</span>
                        {v.file && <span className="font-mono text-text-subtle ml-1">{v.file}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {val.warnings.length > 0 && (
                <div>
                  <div className="text-[11.5px] font-semibold text-text-muted uppercase tracking-wider mb-1">Warnings</div>
                  <div className="space-y-1 max-h-[120px] overflow-y-auto">
                    {val.warnings.slice(0, 4).map((w, i) => (
                      <div key={i} className="text-[11px] text-text-muted">{w.message}{w.suggestion ? ` → ${w.suggestion}` : ''}</div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <EmptyState icon="research" title="No validation data" description="Run a mission to validate the architecture." compact />
          )}
        </SectionCard>

        <SectionCard title="Dependency Insights" subtitle="Runtime and dev dependencies with their versions">
          {profile && profile.dependencies.length > 0 ? (
            <div className="space-y-2 max-h-[400px] overflow-y-auto">
              {depGroups.map(([kind, deps]) => (
                <div key={kind}>
                  <div className="text-[11.5px] font-semibold text-text-muted uppercase tracking-wider mb-1.5">{kind}</div>
                  <div className="space-y-1">
                    {deps.slice(0, 15).map((d, i) => (
                      <div key={i} className="flex items-center justify-between text-[12px]">
                        <span className="text-text font-medium">{d.name}</span>
                        <span className="font-mono text-text-muted text-[11px]">{d.version}</span>
                      </div>
                    ))}
                    {deps.length > 15 && <div className="text-[11px] text-text-muted">…and {deps.length - 15} more</div>}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState icon="folder" title="No dependencies" description="The project profile has no recorded dependencies." compact />
          )}
        </SectionCard>

        <SectionCard title="Most Connected Components" subtitle="Nodes with the highest relationship density">
          {mostConnected.length > 0 ? (
            <div className="space-y-2">
              {mostConnected.map(([nodeId, degree], i) => {
                const node = kg?.nodes.find((n) => n.id === nodeId);
                return (
                  <div key={nodeId} className="flex items-center gap-2 text-[12px]">
                    <span className="w-5 shrink-0 text-[11px] text-text-muted tabular-nums">#{i + 1}</span>
                    <span className="truncate text-text font-medium">{node?.label ?? nodeId}</span>
                    <span className="shrink-0 text-text-muted">{degree} connections</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <EmptyState icon="link" title="No connections" description="The knowledge graph has no edges yet." compact />
          )}
        </SectionCard>
      </Block>
    </SectionView>
  );
}