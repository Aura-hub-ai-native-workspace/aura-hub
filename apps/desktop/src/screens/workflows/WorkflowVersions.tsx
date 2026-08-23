/**
 * WorkflowVersions — what changed, and how to go back.
 * ==================================================================
 * The service versions workflows on publish and on run, keyed by a hash
 * of the *executable* graph — node types, configs and wiring, with
 * positions excluded, because moving a node on the canvas is not a new
 * version of the behaviour.
 *
 * Restoring does not rewind: the service publishes a new version and
 * makes it the draft, so history stays append-only and matches how the
 * Fabric's audit trail already behaves. This view says that, because a
 * "restore" that silently discarded history would be a different promise
 * from the one the service keeps.
 */

import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Icon } from '@aura/ui';
import { aiClient, type WorkflowVersionSummary } from '../../ai/aiClient';
import { EmptyState } from '../../components/EmptyState';
import { relTime } from './runs';

export interface WorkflowVersionsProps {
  workflowId: string;
  /** Hash of the graph currently on the canvas, if the service reported one. */
  currentGraphHash?: string;
  /** Reload the definition after a restore rewrites it. */
  onRestored: () => void;
}

export function WorkflowVersions({ workflowId, currentGraphHash, onRestored }: WorkflowVersionsProps) {
  const [versions, setVersions] = useState<WorkflowVersionSummary[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const res = await aiClient.workflowVersions(workflowId);
      setVersions((res.versions ?? []).sort((a, b) => b.number - a.number));
    } catch (e) {
      setVersions([]);
      setError((e as Error).message);
    }
  }, [workflowId]);

  useEffect(() => { void reload(); }, [reload]);

  const publish = async () => {
    setBusy('publish');
    setError(null);
    try {
      await aiClient.publishWorkflowVersion(workflowId, note.trim() || undefined);
      setNote('');
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const restore = async (v: WorkflowVersionSummary) => {
    setBusy(v.id);
    setError(null);
    try {
      const res = await aiClient.restoreWorkflowVersion(workflowId, v.id);
      if ('error' in res) setError(res.error);
      else {
        await reload();
        onRestored();
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto max-w-3xl px-6 py-6">
      <header className="mb-4">
        <h2 className="text-[17px] font-semibold tracking-[-0.01em] text-text">Versions</h2>
        <p className="mt-1 max-w-xl text-[12.5px] leading-relaxed text-text-muted">
          A version is published when you run this workflow, and whenever you save one deliberately. Every run names the
          version it executed, so “what changed between the run that worked and the one that didn’t” is answerable.
        </p>
      </header>

      <div className="mb-5 flex flex-wrap items-end gap-2 rounded-xl border border-line bg-canvas p-3">
        <label className="min-w-[220px] flex-1">
          <span className="mb-1 block text-[11px] font-medium text-text">Save this graph as a version</span>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What changed? (optional)"
            className="w-full rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[12px] text-text outline-none transition-colors placeholder:text-text-subtle focus:border-accent"
          />
        </label>
        <Button size="sm" variant="secondary" icon="check" loading={busy === 'publish'} onClick={() => void publish()}>
          Publish version
        </Button>
      </div>

      {error && (
        <div className="mb-4 rounded-xl border border-danger/40 bg-danger/5 px-4 py-2.5 text-[12px] text-danger">{error}</div>
      )}

      {versions === null ? (
        <div className="h-24 animate-pulse rounded-xl border border-line bg-surface-active/40" aria-label="Reading versions" />
      ) : versions.length === 0 ? (
        <EmptyState
          icon="clipboard"
          title="No versions yet"
          description="Run this workflow, or publish a version above, and its history starts here."
        />
      ) : (
        <ol className="space-y-2">
          {versions.map((v) => {
            const current = currentGraphHash ? v.graphHash === currentGraphHash : false;
            return (
              <li key={v.id} className="rounded-xl border border-line bg-canvas p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] font-semibold text-text">v{v.number}</span>
                  {current && <Badge tone="info">on the canvas now</Badge>}
                  {v.restoredFrom && <Badge tone="neutral">restored</Badge>}
                  <code className="rounded bg-surface-active px-1.5 py-0.5 text-[10px] text-text-subtle">{v.graphHash}</code>
                  <span className="text-[11px] text-text-subtle">{v.nodeCount} nodes</span>
                  <span className="ml-auto text-[11px] text-text-subtle" title={new Date(v.createdAt).toLocaleString()}>
                    {relTime(v.createdAt)} · {v.createdBy}
                  </span>
                </div>
                {v.note && <p className="mt-1 text-[11.5px] leading-relaxed text-text-muted">{v.note}</p>}
                {!current && (
                  <div className="mt-2 flex justify-end">
                    <Button size="sm" variant="ghost" icon="refresh" loading={busy === v.id} onClick={() => void restore(v)}>
                      Restore onto the canvas
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {versions !== null && versions.length > 0 && (
        <p className="mt-4 flex items-start gap-1.5 text-[10.5px] leading-relaxed text-text-subtle">
          <Icon name="eye" size={11} className="mt-0.5 shrink-0" />
          Restoring publishes a new version rather than rewinding, so nothing in this list is ever lost. Node positions
          are excluded from a version’s identity — rearranging the canvas does not mint one.
        </p>
      )}
    </div>
  );
}
