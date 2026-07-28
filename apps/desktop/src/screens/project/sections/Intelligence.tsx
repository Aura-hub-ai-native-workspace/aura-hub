import { useEffect, useState } from 'react';
import { Badge, Card, CardHeader, Icon, Ring, type BadgeProps } from '@aura/ui';
import { SectionView, Block, StatTile } from '../components/kit';
import { EmptyState } from '../../../components/EmptyState';
import { aiClient, type ProjectIntelligence, type WorkspaceIntelligence } from '../../../ai/aiClient';

/**
 * Intelligence — the full Repository Intelligence surface, live from the
 * real project: verification, architecture, personality, validation,
 * change intelligence, versioning, agent APIs and performance, plus a
 * workspace-level cross-repository view.
 */
export function Intelligence({ projectId }: { projectId: string }) {
  const [rep, setRep] = useState<ProjectIntelligence | null>(null);
  const [ws, setWs] = useState<WorkspaceIntelligence | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    let alive = true;
    setState('loading');
    Promise.all([
      aiClient.projectIntelligence(projectId).catch(() => null),
      aiClient.workspaceIntelligence().catch(() => null),
    ]).then(([r, w]) => {
      if (!alive) return;
      if (r && 'verification' in r) { setRep(r); setWs(w); setState('ready'); }
      else setState('error');
    });
    return () => { alive = false; };
  }, [projectId]);

  if (state === 'loading') {
    return <SectionView title="Intelligence"><EmptyState icon="spark" title="Analyzing repository…" description="Running verification, architecture, personality, validation and more." /></SectionView>;
  }
  if (state === 'error' || !rep) {
    return <SectionView title="Intelligence"><EmptyState icon="spark" title="Intelligence unavailable" description="Could not compute the repository intelligence report." /></SectionView>;
  }

  const v = rep.verification;
  const val = rep.validation;
  const scoreTone = (s: number): 'positive' | 'attention' | 'critical' => (s >= 75 ? 'positive' : s >= 50 ? 'attention' : 'critical');
  const statusTone: Record<string, BadgeProps['tone']> = { pass: 'positive', warn: 'attention', fail: 'critical' };

  return (
    <SectionView title="Intelligence" hint="AURA's full repository understanding — every engine, live from the real project.">
      {/* headline stats */}
      <Block className="mb-5">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <StatTile icon="check" label="Verification" value={`${v.overallScore}/100`} tone={scoreTone(v.overallScore)} />
          <StatTile icon="architecture" label="Validation" value={`${val.score}/100`} sub={`${val.violations.length} issues`} tone={scoreTone(val.score)} />
          <StatTile icon="cpu" label="Modules indexed" value={rep.performance.totalIndexed.toLocaleString()} tone="info" />
          <StatTile icon="activity" label="Index versions" value={rep.versions.totalVersions} tone="neutral" />
        </div>
      </Block>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        {/* Verification */}
        <Block>
          <Card>
            <CardHeader title="Verification" subtitle={v.summary} action={<div className="flex items-center gap-2"><Ring value={v.overallScore} size={40} /></div>} />
            <div className="mt-4 space-y-2">
              {v.sections.map((s) => (
                <div key={s.name} className="rounded-xl border border-line px-3.5 py-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[12.5px] font-medium text-text">{s.name}</span>
                    <div className="flex items-center gap-2">
                      <span className="text-[11.5px] tabular-nums text-text-subtle">{s.score}</span>
                      <Badge tone={statusTone[s.status] ?? 'neutral'} dot>{s.status}</Badge>
                    </div>
                  </div>
                  {s.findings.length > 0 && <div className="mt-1 line-clamp-2 text-[11.5px] text-text-muted">{s.findings[0]}</div>}
                </div>
              ))}
            </div>
            {v.recommendations.length > 0 && (
              <div className="mt-3 border-t border-line pt-3">
                <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-subtle">Recommendations</div>
                <ul className="space-y-1">{v.recommendations.slice(0, 4).map((r, i) => <li key={i} className="flex gap-2 text-[12px] text-text-muted"><Icon name="dot" size={12} className="mt-0.5 shrink-0" /> {r}</li>)}</ul>
              </div>
            )}
          </Card>
        </Block>

        {/* Architecture */}
        <Block>
          <Card>
            <CardHeader title="Architecture" subtitle="Structure derived from the real files" />
            <div className="mt-3 grid grid-cols-2 gap-3">
              <Mini label="Modules" value={rep.architecture.dependencies.nodes.length} />
              <Mini label="Dependencies" value={rep.architecture.dependencies.edges.length} />
              <Mini label="Entry points" value={rep.architecture.entryPoints.length} />
              <Mini label="API surface" value={rep.architecture.apiSurface.endpoints.length + rep.architecture.apiSurface.classes.length + rep.architecture.apiSurface.functions.length} />
            </div>
            {rep.architecture.entryPoints.length > 0 && (
              <div className="mt-3 border-t border-line pt-3">
                <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-subtle">Entry points</div>
                {rep.architecture.entryPoints.slice(0, 6).map((e, i) => (
                  <div key={i} className="flex items-center justify-between py-0.5 text-[12px]"><span className="truncate font-mono text-text-muted">{e.file}</span><Badge tone="info">{e.type}</Badge></div>
                ))}
              </div>
            )}
            {rep.agent.info.modules.length > 0 && (
              <div className="mt-3 border-t border-line pt-3">
                <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-subtle">Top-level modules</div>
                <div className="flex flex-wrap gap-1.5">{rep.agent.info.modules.slice(0, 12).map((mod) => <span key={mod} className="rounded-lg bg-surface-active px-2 py-0.5 text-[11px] text-text-muted">{mod}</span>)}</div>
              </div>
            )}
          </Card>
        </Block>

        {/* Validation */}
        <Block>
          <Card>
            <CardHeader title="Architecture Validation" subtitle={val.valid ? 'All rules satisfied' : `${val.violations.length} violation(s)`} action={<Badge tone={val.valid ? 'positive' : 'attention'} dot>{val.valid ? 'valid' : 'issues'}</Badge>} />
            <div className="mt-3 flex flex-wrap gap-1.5">
              {val.passedRules.map((r) => <span key={r} className="inline-flex items-center gap-1 rounded-lg bg-positive/10 px-2 py-0.5 text-[11px] text-positive"><Icon name="check" size={11} /> {r}</span>)}
            </div>
            {val.violations.length > 0 && (
              <div className="mt-3 space-y-1.5">
                {val.violations.map((vi, i) => (
                  <div key={i} className="rounded-lg border border-danger/25 bg-danger/5 px-3 py-2 text-[12px]">
                    <span className="font-medium text-danger">{vi.rule}</span> <span className="text-text-muted">— {vi.message}</span>
                  </div>
                ))}
              </div>
            )}
            {val.warnings.length > 0 && (
              <div className="mt-2 space-y-1.5">
                {val.warnings.slice(0, 4).map((w, i) => <div key={i} className="text-[11.5px] text-attention">⚠ {w.message} <span className="text-text-subtle">— {w.suggestion}</span></div>)}
              </div>
            )}
          </Card>
        </Block>

        {/* Personality */}
        <Block>
          <Card>
            <CardHeader title="Repository Personality" subtitle="How this codebase communicates" />
            <div className="mt-3 grid grid-cols-2 gap-3">
              <Trait label="Communication" value={rep.personality.communicationStyle} />
              <Trait label="Code style" value={rep.personality.codeStyle} />
              <Trait label="Doc tone" value={rep.personality.documentationTone} />
              <Trait label="Technical level" value={rep.personality.technicalLevel} />
              <Trait label="Verbosity" value={rep.personality.responsePatterns.verbosity} />
              <Trait label="Examples" value={rep.personality.responsePatterns.useExamples ? 'yes' : 'no'} />
            </div>
          </Card>
        </Block>

        {/* Change + Performance */}
        <Block>
          <Card>
            <CardHeader title="Change Intelligence" subtitle={`Velocity ${rep.change.velocity.toFixed(1)} changes/wk`} />
            {rep.change.hotspots.length > 0 ? (
              <div className="mt-3 space-y-1.5">
                {rep.change.hotspots.slice(0, 6).map((h, i) => (
                  <div key={i} className="flex items-center justify-between text-[12px]"><span className="truncate font-mono text-text-muted">{h.file}</span><Badge tone="attention">{h.reason}</Badge></div>
                ))}
              </div>
            ) : <p className="mt-3 text-[12px] text-text-muted">{rep.change.report}</p>}
            <div className="mt-3 border-t border-line pt-3 grid grid-cols-3 gap-2 text-center">
              <Mini label="Added" value={rep.performance.added} />
              <Mini label="Changed" value={rep.performance.changed} />
              <Mini label="Removed" value={rep.performance.removed} />
            </div>
          </Card>
        </Block>

        {/* Workspace / cross-repo */}
        <Block>
          <Card>
            <CardHeader title="Workspace Intelligence" subtitle="Across every registered project" />
            <div className="mt-3 grid grid-cols-2 gap-3">
              <Mini label="Repositories" value={ws?.stats.totalRepositories ?? 0} />
              <Mini label="Cross-repo deps" value={ws?.stats.totalDependencies ?? 0} />
              <Mini label="Cross-repo edges" value={ws?.crossRepo?.totalEdges ?? 0} />
              <Mini label="Clusters" value={ws?.crossRepo?.totalClusters ?? 0} />
            </div>
            {ws && Object.keys(ws.stats.languageDistribution).length > 0 && (
              <div className="mt-3 border-t border-line pt-3">
                <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-subtle">Languages across workspace</div>
                <div className="flex flex-wrap gap-1.5">{Object.entries(ws.stats.languageDistribution).slice(0, 10).map(([l, n]) => <span key={l} className="rounded-lg bg-surface-active px-2 py-0.5 text-[11px] text-text-muted">{l} · {n}</span>)}</div>
              </div>
            )}
          </Card>
        </Block>
      </div>
    </SectionView>
  );
}

function Mini({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-line px-3 py-2 text-center">
      <div className="text-[17px] font-semibold tabular-nums text-text">{value.toLocaleString()}</div>
      <div className="text-[11px] text-text-subtle">{label}</div>
    </div>
  );
}

function Trait({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-line px-3 py-2">
      <div className="text-[11px] text-text-subtle">{label}</div>
      <div className="mt-0.5 text-[12.5px] font-medium capitalize text-text">{value}</div>
    </div>
  );
}
