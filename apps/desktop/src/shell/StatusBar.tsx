import { useEffect } from 'react';
import { useAppStore, cn } from '@aura/core';
import { Icon, type IconName } from '@aura/ui';
import { useActiveProject } from '../data/useActiveProject';
import { useStatusStore } from '../ops/statusStore';
import { useLayoutStore } from '../ops/layoutStore';
import { indexStat } from './statusBarIndex';
import { pythonStatusLabel } from './environmentStatus';

/**
 * Bottom status bar — the environment's eight live vitals (Part 5):
 * backend connection, project, git branch, mission activity, knowledge
 * index, provider, memory and diagnostics. Every slot is fed by the
 * aggregated poller in ops/statusStore (real engine state), refreshed on
 * a 15s cadence; the diagnostics slot jumps into the workspace.
 */
export function StatusBar() {
  const nav = useAppStore((s) => s.nav);
  const setNav = useAppStore((s) => s.setNav);
  const openPanel = useLayoutStore((s) => s.openPanel);
  // The status bar shows the active-project AUTHORITY, not the service mount:
  // the mount is a derived value that outlives a cleared authority.
  const { record: project } = useActiveProject();
  const refresh = useStatusStore((s) => s.refresh);
  const st = useStatusStore();

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), 15000);
    return () => window.clearInterval(id);
  }, [refresh]);

  const knowledge = indexStat(Boolean(project), st.index);

  const providerLabel =
    st.reachable === false ? null : st.provider ? `${st.provider.label} · ${st.provider.model}` : 'No provider';

  return (
    <footer className="flex h-8 shrink-0 items-center gap-1 overflow-x-auto border-t border-line bg-surface/70 px-3 text-[11.5px] text-text-muted backdrop-blur-xl">
      <div className="flex items-center gap-1.5 rounded-md px-2 py-1">
        <span className={cn('inline-block h-1.5 w-1.5 rounded-full', st.reachable === false ? 'bg-critical' : 'bg-positive aura-live')} />
        <span title={st.identity ?? undefined}>{st.reachable === false ? (st.identity ? 'Backend identity mismatch — connection refused.' : 'Backend offline') : st.reachable === null ? 'Connecting…' : 'Connected'}</span>
      </div>
      <Divider />
      <div className="flex items-center gap-1.5 rounded-md px-2 py-1" data-testid="python-status">
        <span className={cn('inline-block h-1.5 w-1.5 rounded-full', st.pythonOk === true ? 'bg-positive' : st.pythonOk === false ? 'bg-critical' : 'bg-text-subtle')} />
        <span title={st.pythonMessage ?? undefined}>{pythonStatusLabel({ pythonOk: st.pythonOk, pythonMessage: st.pythonMessage })}</span>
      </div>
      <Divider />
      <Stat icon="folder" label={project ? project.name : `Workspace: ${nav}`} />
      {project && st.gitBranch && (
        <>
          <Divider />
          <Stat icon="git-branch" tone="info" label={st.gitBranch} />
        </>
      )}

      <div className="ml-auto flex items-center gap-1">
        {st.activeMissions > 0 && (
          <>
            <Divider />
            <Stat icon="deploy" label={`${st.activeMissions} active${st.reviewingMissions ? ` · ${st.reviewingMissions} review` : ''}`} tone={st.reviewingMissions ? 'attention' : 'info'} />
          </>
        )}
        {knowledge && (
          <>
            <Divider />
            <Stat icon="knowledge" tone={knowledge.ready ? 'positive' : 'info'} label={knowledge.label} />
          </>
        )}
        {st.pendingDiagnoses > 0 && (
          <>
            <Divider />
            <button
              onClick={() => {
                setNav('workspace');
                openPanel('diagnostics');
              }}
              className="flex items-center gap-1.5 rounded-md px-2 py-1 text-danger transition-colors hover:bg-surface-hover"
              title="Open diagnostics"
            >
              <Icon name="bug" size={13} />
              <span>{st.pendingDiagnoses} diagnosis{st.pendingDiagnoses === 1 ? '' : 'es'} pending</span>
            </button>
          </>
        )}
        {st.memoryCount > 0 && (
          <>
            <Divider />
            <Stat icon="memory" label={`${st.memoryCount} memories`} />
          </>
        )}
        <Divider />
        <Stat icon="cpu" tone={providerLabel ? 'positive' : undefined} label={providerLabel ?? 'No provider'} />
      </div>
    </footer>
  );
}

function Stat({ icon, label, tone }: { icon: IconName; label: string; tone?: 'positive' | 'info' | 'attention' }) {
  return (
    <div className="flex items-center gap-1.5 rounded-md px-2 py-1">
      <Icon
        name={icon}
        size={13}
        className={cn(tone === 'positive' && 'text-positive', tone === 'info' && 'text-accent', tone === 'attention' && 'text-attention')}
      />
      <span className="max-w-[280px] truncate whitespace-nowrap">{label}</span>
    </div>
  );
}

function Divider() {
  return <span className="h-3.5 w-px shrink-0 bg-line" />;
}
