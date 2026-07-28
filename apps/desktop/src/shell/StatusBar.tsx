import { useEffect, useState } from 'react';
import { useAppStore, cn } from '@aura/core';
import { Icon, type IconName } from '@aura/ui';
import { useWorkspace } from '../data/useWorkspace';
import { aiClient } from '../ai/aiClient';

/**
 * Bottom status bar — the environment's real vitals: backend connection,
 * the open project and its live index counts, and the AI key state. Every
 * slot is fed by real backend state, not placeholders.
 */
export function StatusBar() {
  const nav = useAppStore((s) => s.nav);
  const { projects, status, openId } = useWorkspace();
  const project = projects.find((p) => p.id === openId);
  const [conn, setConn] = useState<{ ok: boolean; key: boolean } | null>(null);
  const [reachable, setReachable] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    const check = () => aiClient.health()
      .then((h) => { if (alive) { setConn({ ok: h.health.ok, key: h.key.configured }); setReachable(true); } })
      .catch(() => { if (alive) setReachable(false); });
    check();
    const id = window.setInterval(check, 15000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  return (
    <footer className="flex h-8 shrink-0 items-center gap-1 border-t border-line bg-surface/70 px-3 text-[11.5px] text-text-muted backdrop-blur-xl">
      <div className="flex items-center gap-1.5 rounded-md px-2 py-1">
        <span className={cn('inline-block h-1.5 w-1.5 rounded-full', reachable === false ? 'bg-critical' : 'bg-positive aura-live')} />
        <span>{reachable === false ? 'Backend offline' : 'Connected'}</span>
      </div>
      <Divider />
      <Stat icon="folder" label={project ? project.name : `Workspace: ${nav}`} />
      {project && status && status.phase !== 'empty' && (
        <>
          <Divider />
          <Stat icon="knowledge" tone={status.phase === 'ready' ? 'positive' : 'info'} label={status.phase === 'ready' ? `${status.coding.chunks} chunks · ${status.fullstack.entities} entities` : status.message} />
        </>
      )}

      <div className="ml-auto flex items-center gap-1">
        <Stat icon="cpu" tone={conn?.key ? 'positive' : undefined} label={reachable === false ? 'No backend' : conn?.key ? 'Runtime ready' : 'Not configured'} />
      </div>
    </footer>
  );
}

function Stat({ icon, label, tone }: { icon: IconName; label: string; tone?: 'positive' | 'info' }) {
  return (
    <div className="flex items-center gap-1.5 rounded-md px-2 py-1">
      <Icon name={icon} size={13} className={cn(tone === 'positive' && 'text-positive', tone === 'info' && 'text-accent')} />
      <span className="max-w-[280px] truncate whitespace-nowrap">{label}</span>
    </div>
  );
}

function Divider() {
  return <span className="h-3.5 w-px bg-line" />;
}
