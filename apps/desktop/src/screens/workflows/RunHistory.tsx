/**
 * RunHistory — every run the service persisted.
 * ==================================================================
 * A table, not a card grid: this surface is scanned for anomalies, not
 * browsed. Selecting a row loads the full record and opens the same
 * `RunView` a live run uses.
 *
 * The list comes from `GET /workflows/:id/runs`, so it survives closing
 * the app and includes runs this window never watched — webhook-triggered
 * runs, automation-triggered runs, mission-triggered runs. Every run names
 * the immutable version it executed.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Button, Icon, IconButton } from '@aura/ui';
import { aiClient, type NodeSpecInfo, type RunState, type WorkflowRun, type WorkflowRunSummary } from '../../ai/aiClient';
import { useFabric, pendingApprovals } from '../../data/useFabric';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { RunView } from './RunView';
import {
  RUN_STATE_LABEL,
  TRIGGER_LABEL,
  carriedThroughFor,
  fmtDuration,
  isPending,
  runStateLabel,
  runStateTone,
  sortRuns,
} from './runs';


type Filter = 'all' | 'failed' | 'succeeded' | 'awaiting-approval';

export interface RunHistoryProps {
  specs: Map<string, NodeSpecInfo>;
  /** One workflow's runs. Required — the service indexes runs per workflow. */
  workflowId: string;
  /** Graph order for the step list, when the definition is loaded. */
  graphOrder?: string[];
  onRerun?: (workflowId: string) => void;
  onOpenWorkflow?: (workflowId: string) => void;
  /** Rendered above the table — used by the editor's Runs view. */
  title?: string;
}

export function RunHistory({ specs, workflowId, graphOrder = [], onRerun, onOpenWorkflow, title = 'Runs' }: RunHistoryProps) {
  // A run opened from history can still be parked on a decision — without
  // these it would show "waiting for you" and offer no way to answer.
  const approvals = useFabric((s) => s.approvals);
  const deciding = useFabric((s) => s.deciding);
  const decide = useFabric((s) => s.decide);
  const watchApprovals = useFabric((s) => s.watchApprovals);
  useEffect(() => watchApprovals(), [watchApprovals]);

  const [runs, setRuns] = useState<WorkflowRunSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [open, setOpen] = useState<WorkflowRun | null>(null);
  /** The legs of the open run's execution, when it has more than one. */
  const [chain, setChain] = useState<WorkflowRunSummary[] | undefined>(undefined);
  /** Per node, where the previous leg's carried-forward reasoning ends. */
  const [carried, setCarried] = useState<Record<string, number> | undefined>(undefined);

  const [loadingOne, setLoadingOne] = useState(false);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const res = await aiClient.workflowRuns(workflowId);
      setRuns(sortRuns(res.runs ?? []));
    } catch (e) {
      setRuns([]);
      setError((e as Error).message);
    }
  }, [workflowId]);

  useEffect(() => { void reload(); }, [reload]);

  /* The "waiting for you" filter asks whether someone is actually waiting,
     which is not the same question as the state. A superseded leg keeps
     `awaiting-approval` — that is how it ended — but its question has been
     answered and its work picked up by another run, so listing it as
     pending would be an invitation to act on something already decided. */
  const matches = (r: WorkflowRunSummary, f: Filter): boolean =>
    f === 'all' ? true : f === 'awaiting-approval' ? isPending(r) : r.state === f;

  const shown = useMemo(() => (runs ?? []).filter((r) => matches(r, filter)), [runs, filter]);


  const openRun = async (id: string) => {
    setLoadingOne(true);
    try {
      const rec = await aiClient.workflowRun(workflowId, id);
      if ('id' in rec) {
        setOpen(rec);
        /* Only ask for the chain when this run is part of one. The service
           answers for any run — a lone run is a chain of one — but fetching
           it unconditionally would spend a request per open to be told
           what the record already says. */
        setChain(
          rec.supersededBy || rec.trigger.kind === 'resume'
            ? await aiClient
                .workflowRunChain(workflowId, id)
                .then((r) => ('chain' in r ? r.chain : undefined))
                .catch(() => undefined)
            : undefined,
        );
        /* A resumed agent's ledger carries the earlier leg's beats
           forward, so reading that leg is what lets this view say where
           the carried reasoning ends. If it cannot be read, no marker is
           drawn — an approximate boundary would be worse than none. */
        const priorId = rec.trigger.kind === 'resume' ? rec.trigger.of : undefined;
        setCarried(
          typeof priorId === 'string'
            ? carriedThroughFor(
                await aiClient
                  .workflowRun(workflowId, priorId)
                  .then((p) => ('id' in p ? p : null))
                  .catch(() => null),
              )
            : undefined,
        );
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingOne(false);
    }
  };

  if (open) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center gap-2 border-b border-line px-4 py-2">
          <Button variant="ghost" size="sm" icon="projects" onClick={() => setOpen(null)}>All runs</Button>
          <span className="text-[13px] font-semibold text-text">{open.workflowName}</span>
          <span className="text-[11.5px] text-text-subtle">{new Date(open.createdAt).toLocaleString()}</span>
          {onOpenWorkflow && (
            <Button variant="ghost" size="sm" icon="workflows" className="ml-auto" onClick={() => onOpenWorkflow(open.workflowId)}>
              Open workflow
            </Button>
          )}
        </div>
        <div className="min-h-0 flex-1">
          <RunView
            run={open}
            specs={specs}
            graphOrder={graphOrder.length ? graphOrder : Object.keys(open.nodes)}
            approvals={pendingApprovals(approvals)}
            decidingId={deciding}
            onDecideApproval={async (id, granted, reason) => {
              await decide(id, granted, reason);
              const fresh = await aiClient.workflowRun(open.workflowId, open.id).catch(() => null);
              if (fresh && 'id' in fresh) setOpen(fresh);
            }}
            onRerun={onRerun ? () => onRerun(open.workflowId) : undefined}
            chain={chain}
            onOpenRun={(id) => void openRun(id)}
            carriedThrough={carried}
          />
        </div>
      </div>
    );
  }

  const counts = (s: RunState) => (runs ?? []).filter((r) => matches(r, s as Filter)).length;


  return (
    <div className="mx-auto max-w-5xl px-6 py-6">
      <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-[17px] font-semibold tracking-[-0.01em] text-text">{title}</h2>
          <p className="mt-1 text-[12.5px] text-text-muted">
            {runs === null
              ? 'Reading run history…'
              : runs.length === 0
                ? 'No runs recorded yet.'
                : `${runs.length} recorded · ${counts('succeeded')} succeeded · ${counts('failed')} failed`}
          </p>
        </div>
        <IconButton icon="refresh" label="Reload the run list" size="sm" onClick={() => void reload()} />
      </header>

      {error && (
        <div className="mb-4">
          <ErrorState
            icon="bug"
            title="Couldn't read the run history"
            description={error}
            action={<Button size="sm" variant="secondary" icon="refresh" onClick={() => void reload()}>Retry</Button>}
          />
        </div>
      )}

      {runs !== null && runs.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          {(['all', 'failed', 'succeeded', 'awaiting-approval'] as Filter[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`rounded-full px-3 py-1 text-[11.5px] font-medium transition-colors ${
                filter === f ? 'bg-accent text-white' : 'bg-surface-active text-text-muted hover:text-text'
              }`}
            >
              {f === 'all' ? 'All' : RUN_STATE_LABEL[f as RunState]}
              {f !== 'all' && <span className="ml-1 opacity-70">{counts(f as RunState)}</span>}
            </button>
          ))}
        </div>
      )}

      {runs !== null && shown.length === 0 && !error ? (
        <EmptyState
          icon="activity"
          title={runs.length ? `No ${filter.replace('-', ' ')} runs` : 'No runs recorded yet'}
          description={
            runs.length
              ? 'Change the filter to see the others.'
              : 'Run this workflow and the service records every step, governed action and result it produced.'
          }
        />
      ) : (
        runs !== null && (
          <div className="overflow-x-auto rounded-xl border border-line bg-canvas">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-line text-left text-[10px] uppercase tracking-[0.11em] text-text-subtle">
                  <th className="px-3 py-2 font-semibold">Started</th>
                  <th className="px-3 py-2 font-semibold">Outcome</th>
                  <th className="px-3 py-2 font-semibold">Version</th>
                  <th className="px-3 py-2 font-semibold">Trigger</th>
                  <th className="px-3 py-2 font-semibold">Steps</th>
                  <th className="px-3 py-2 font-semibold">Evidence</th>
                  <th className="px-3 py-2 font-semibold">Duration</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr
                    key={r.id}
                    onClick={() => void openRun(r.id)}
                    className="cursor-pointer border-b border-line/60 transition-colors last:border-b-0 hover:bg-surface-hover"
                  >
                    <td className="px-3 py-2 text-text-muted">{new Date(r.createdAt).toLocaleString()}</td>
                    <td className="px-3 py-2">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <Badge tone={runStateTone(r)}>{runStateLabel(r)}</Badge>
                        {r.resumable && <span className="text-[10px] text-text-subtle">resumable</span>}
                        {r.supersededBy && (
                          <span className="text-[10px] text-text-subtle" title={`continued as run ${r.supersededBy}`}>
                            continued as another run
                          </span>
                        )}

                      </span>
                    </td>
                    <td className="px-3 py-2 font-mono text-[10.5px] text-text-subtle">{r.versionId}</td>
                    <td className="px-3 py-2 text-text-muted">{TRIGGER_LABEL[r.trigger] ?? r.trigger}</td>
                    <td className="px-3 py-2 tabular-nums text-text-muted">
                      {r.succeededCount}/{r.nodeCount}
                      {r.failedCount > 0 && <span className="text-danger"> · {r.failedCount} failed</span>}
                    </td>
                    <td className="px-3 py-2 tabular-nums text-text-muted">
                      {r.evidenceCount || '—'}
                      {r.approvalCount > 0 && <span className="text-attention"> · {r.approvalCount} approved</span>}
                    </td>
                    <td className="px-3 py-2 tabular-nums text-text-muted">{fmtDuration(r.ms)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      {loadingOne && <p className="mt-3 text-center text-[11.5px] text-text-subtle">Loading run…</p>}

      {runs !== null && runs.length > 0 && (
        <p className="mt-4 flex items-start gap-1.5 text-[10.5px] leading-relaxed text-text-subtle">
          <Icon name="eye" size={11} className="mt-0.5 shrink-0" />
          Recorded by the service, so this includes runs started by a webhook or an automation rule while AURA was
          closed. Each run names the immutable version it executed.
        </p>
      )}
    </div>
  );
}
