import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@aura/core';
import { Badge, Button, Card, CardHeader, Icon } from '@aura/ui';
import {
  centralAgentClient,
  type IsolationSetting,
  type IsolationStatus,
} from '../../ai/centralAgentClient';

const OPTIONS: { value: IsolationSetting; label: string; detail: string }[] = [
  {
    value: 'auto',
    label: 'Automatic',
    detail: 'Use a container when Docker is available. Otherwise run on this computer.',
  },
  {
    value: 'container',
    label: 'Container only',
    detail: 'Always use a container. A run is not started if one is not available.',
  },
  {
    value: 'host',
    label: 'This computer',
    detail: 'Run agents directly on this computer, without a container.',
  },
];

export function activeBadge(s: IsolationStatus): { tone: 'positive' | 'attention' | 'critical' | 'neutral'; label: string } {
  if (s.active === 'container') return { tone: 'positive', label: 'Container' };
  if (s.active === 'refused') return { tone: 'critical', label: 'Runs blocked' };
  return { tone: s.setting === 'host' ? 'neutral' : 'attention', label: 'This computer' };
}

export function imageLabel(s: IsolationStatus): string {
  switch (s.image.state) {
    case 'ready': return 'Ready';
    case 'building': return 'Preparing…';
    case 'failed': return 'Failed';
    case 'missing': return 'Not prepared';
    default: return '—';
  }
}

/**
 * Settings → AI Runtime → Run isolation.
 *
 * Where coding agents run: inside a throwaway container that sees only the
 * project, or directly on this computer. Everything shown comes from the
 * backend's own check of this machine (GET /governance/isolation), so the
 * card never claims isolation the machine cannot give.
 */
export function RunIsolationCard() {
  const [status, setStatus] = useState<IsolationStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<IsolationSetting | null>(null);
  const [preparing, setPreparing] = useState(false);
  const poll = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await centralAgentClient.isolationStatus());
      setError(null);
    } catch (e) {
      setError((e as Error)?.message ?? 'Could not read run isolation');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // While the image is being prepared, check again every few seconds.
  useEffect(() => {
    if (status?.image.state !== 'building') return;
    poll.current = window.setTimeout(() => { void load(); }, 4000);
    return () => { if (poll.current) window.clearTimeout(poll.current); };
  }, [status, load]);

  const choose = async (mode: IsolationSetting) => {
    if (!status || mode === status.setting) return;
    setSaving(mode);
    setError(null);
    try {
      setStatus(await centralAgentClient.isolationSave(mode));
    } catch (e) {
      setError((e as Error)?.message ?? 'Could not save the setting');
    } finally {
      setSaving(null);
    }
  };

  const prepare = async () => {
    setPreparing(true);
    setError(null);
    try {
      setStatus(await centralAgentClient.isolationPrepare());
    } catch (e) {
      setError((e as Error)?.message ?? 'Could not prepare the container image');
    } finally {
      setPreparing(false);
    }
  };

  const badge = status ? activeBadge(status) : null;
  const canPrepare = !!status && status.docker.available
    && (status.image.state === 'missing' || status.image.state === 'failed');

  return (
    <Card data-testid="run-isolation">
      <CardHeader
        title="Run isolation"
        subtitle="Where coding agents run. In a container, an agent sees only the project it is working on."
        action={badge ? <Badge tone={badge.tone} dot>{badge.label}</Badge> : undefined}
      />
      {error && (
        <div className="mt-3 rounded-xl border border-danger/30 bg-danger/5 px-4 py-2.5 text-[12px] text-danger">
          {error}
        </div>
      )}
      <div role="radiogroup" aria-label="Run isolation" className="mt-4 grid gap-2 sm:grid-cols-3">
        {OPTIONS.map((o) => {
          const selected = status?.setting === o.value;
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={!status || saving !== null}
              onClick={() => { void choose(o.value); }}
              data-testid={`isolation-${o.value}`}
              className={cn(
                'rounded-xl border px-4 py-3 text-left transition-colors disabled:cursor-default',
                selected
                  ? 'border-accent bg-accent/5'
                  : 'border-line bg-surface-active/40 hover:border-line-strong',
              )}
            >
              <span className="flex items-center gap-2 text-[12.5px] font-medium text-text">
                <span
                  aria-hidden
                  className={cn(
                    'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border',
                    selected ? 'border-accent' : 'border-line-strong',
                  )}
                >
                  {selected && <span className="h-1.5 w-1.5 rounded-full bg-accent" />}
                </span>
                {o.label}
                {saving === o.value && <span className="text-[11px] font-normal text-text-subtle">Saving…</span>}
              </span>
              <span className="mt-1 block text-[11.5px] leading-snug text-text-muted">{o.detail}</span>
            </button>
          );
        })}
      </div>

      {status && (
        <div className="mt-4 space-y-2 rounded-xl bg-surface-active/50 px-4 py-3 text-[12px]">
          <div className="flex items-center justify-between gap-3">
            <span className="text-text-muted">Docker</span>
            <span className="font-medium text-text" data-testid="isolation-docker">
              {status.docker.available ? `Running · ${status.docker.version}` : 'Not available'}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-text-muted">Container image</span>
            <span className="flex items-center gap-2 font-medium text-text" data-testid="isolation-image">
              {status.docker.available ? imageLabel(status) : '—'}
              {canPrepare && (
                <Button size="sm" variant="secondary" loading={preparing} onClick={() => { void prepare(); }}>
                  Prepare now
                </Button>
              )}
            </span>
          </div>
          {status.reason && (
            <div className="flex items-start gap-2 border-t border-line pt-2 text-text-muted" data-testid="isolation-reason">
              <Icon name="shield" size={12} className="mt-0.5 shrink-0 text-text-subtle" />
              <span>{status.reason}</span>
            </div>
          )}
          {status.image.state === 'failed' && status.image.detail && (
            <p className="text-[11px] text-danger">{status.image.detail}</p>
          )}
        </div>
      )}
    </Card>
  );
}
