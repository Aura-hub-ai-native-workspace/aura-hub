/**
 * AllRuns — every run, across every workflow.
 * ==================================================================
 * The service indexes runs per workflow (`GET /workflows/:id/runs`), so
 * this flattens the summaries the store has already read and sorts them
 * by time. Selecting a row loads the full record and opens the same
 * `RunView` the editor uses.
 *
 * The list is honest about its own completeness: it covers the workflows
 * currently in the library, and says so, rather than implying it is every
 * run the machine has ever performed.
 */

import { useMemo, useState } from 'react';
import { Badge, Button, Icon } from '@aura/ui';
import { aiClient, type NodeSpecInfo, type RunState, type WorkflowRun, type WorkflowRunSummary } from '../../ai/aiClient';
import { useWorkflows } from '../../data/useWorkflows';
import { EmptyState } from '../../components/EmptyState';
import { RunView } from './RunView';
import {
  RUN_STATE_LABEL,
  TRIGGER_LABEL,
  carriedThroughFor,
  fmtDuration,
  isPending,
  runStateLabel,
  runStateTone,
} from './runs';

type Filter = 'all' | 'failed' | 'awaiting-approval';

/* "Waiting for you" is a question about whether anyone is actually
   waiting, not about the stored state: a superseded leg keeps
   `awaiting-approval` because that is how it ended, but another run has
   already picked its work up. See `docs/AGENT_RESUME_SEMANTICS.md`. */
const matches = (r: WorkflowRunSummary, f: Filter): boolean =>
  f === 'all' ? true : f === 'awaiting-approval' ? isPending(r) : r.state === f;

/** Runs a rule started, versus runs a person started. */
type Origin = 'any' | 'automation' | 'manual';

export function AllRuns({
  specs,
  onOpenWorkflow,
}: {
  specs: Map<string, NodeSpecInfo>;
  onOpenWorkflow: (id: string) => void;
}) {
  const runsByWorkflow = useWorkflows((s) => s.runs);
  const hydrating = useWorkflows((s) => s.hydrating);
  const [filter, setFilter] = useState<Filter>('all');
  const [origin, setOrigin] = useState<Origin>('any');
  const [open, setOpen] = useState<WorkflowRun | null>(null);
  /** The legs of the open run's execution, when it has more than one. */
  const [chain, setChain] = useState<WorkflowRunSummary[] | undefined>(undefined);
  /** Per node, where the previous leg's carried-forward reasoning ends. */
  const [carried, setCarried] = useState<Record<string, number> | undefined>(undefined);
  const [loading, setLoading] = useState(false);

  const all = useMemo(() => {
    const flat: WorkflowRunSummary[] = [];
    for (const list of Object.values(runsByWorkflow)) flat.push(...list);
    return flat.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [runsByWorkflow]);

  const shown = useMemo(
    () =>
      all
        .filter((r) => matches(r, filter))
        .filter((r) => (origin === 'any' ? true : origin === 'automation' ? r.trigger === 'automation' : r.trigger === 'manual')),
    [all, filter, origin],
  );
  const automationCount = useMemo(() => all.filter((r) => r.trigger === 'automation').length, [all]);
  const counts = (s: RunState) => all.filter((r) => matches(r, s as Filter)).length;

  const openRun = async (r: { workflowId: string; id: string }) => {
    setLoading(true);
    try {
      const rec = await aiClient.workflowRun(r.workflowId, r.id);
      if ('id' in rec) {
        setOpen(rec);
        // Only when the record says there is a chain to read.
        setChain(
          rec.supersededBy || rec.trigger.kind === 'resume'
            ? await aiClient
                .workflowRunChain(r.workflowId, r.id)
                .then((c) => ('chain' in c ? c.chain : undefined))
                .catch(() => undefined)
            : undefined,
        );
        // The earlier leg, so the ledger can say where its carried beats end.
        const priorId = rec.trigger.kind === 'resume' ? rec.trigger.of : undefined;
        setCarried(
          typeof priorId === 'string'
            ? carriedThroughFor(
                await aiClient
                  .workflowRun(r.workflowId, priorId)
                  .then((p) => ('id' in p ? p : null))
                  .catch(() => null),
              )
            : undefined,
        );
      }
    } finally {
      setLoading(false);
    }
  };

  if (open) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center gap-2 border-b border-line px-4 py-2">
          <Button variant="ghost" size="sm" icon="projects" onClick={() => setOpen(null)}>All runs</Button>
          <span className="text-[13px] font-semibold text-text">{open.workflowName}</span>
          <span className="text-[11.5px] text-text-subtle">{new Date(open.createdAt).toLocaleString()}</span>
          <Button variant="ghost" size="sm" icon="workflows" className="ml-auto" onClick={() => onOpenWorkflow(open.workflowId)}>
            Open workflow
          </Button>
        </div>
        <div className="min-h-0 flex-1">
          <RunView
            run={open}
            specs={specs}
            graphOrder={Object.keys(open.nodes)}
            chain={chain}
            onOpenRun={(id) => void openRun({ workflowId: open.workflowId, id })}
            carriedThrough={carried}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl px-6 py-6">
      <header className="mb-4">
        <h2 className="text-[17px] font-semibold tracking-[-0.01em] text-text">Runs</h2>
        <p className="mt-1 text-[12.5px] text-text-muted">
          {hydrating && !all.length
            ? 'Reading run history…'
            : all.length === 0
              ? 'No runs recorded yet.'
              : `${all.length} across your workflows · ${counts('succeeded')} succeeded · ${counts('failed')} failed`}
        </p>
      </header>

      {all.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          {(['all', 'failed', 'awaiting-approval'] as Filter[]).map((f) => (
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

          <span className="mx-1 h-4 w-px bg-line" />

          {/* Who started it. An unattended run and one you watched deserve
              different attention, so they are separable. */}
          {(['any', 'automation', 'manual'] as Origin[]).map((o) => (
            <button
              key={o}
              onClick={() => setOrigin(o)}
              className={`rounded-full px-3 py-1 text-[11.5px] font-medium transition-colors ${
                origin === o ? 'bg-accent text-white' : 'bg-surface-active text-text-muted hover:text-text'
              }`}
            >
              {o === 'any' ? 'Any source' : o === 'automation' ? 'Started by a rule' : 'Started by you'}
              {o === 'automation' && <span className="ml-1 opacity-70">{automationCount}</span>}
            </button>
          ))}
        </div>
      )}

      {shown.length === 0 ? (
        <EmptyState
          icon="activity"
          title={all.length ? 'Nothing matches that filter' : 'No runs recorded yet'}
          description={
            all.length
              ? 'Change the filter to see the others.'
              : 'Run a workflow and the service records every step, governed action and result it produced.'
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line bg-canvas">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-line text-left text-[10px] uppercase tracking-[0.11em] text-text-subtle">
                <th className="px-3 py-2 font-semibold">Workflow</th>
                <th className="px-3 py-2 font-semibold">Started</th>
                <th className="px-3 py-2 font-semibold">Outcome</th>
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
                  onClick={() => void openRun(r)}
                  className="cursor-pointer border-b border-line/60 transition-colors last:border-b-0 hover:bg-surface-hover"
                >
                  <td className="px-3 py-2 font-medium text-text">{r.workflowName}</td>
                  <td className="px-3 py-2 text-text-muted">{new Date(r.createdAt).toLocaleString()}</td>
                  <td className="px-3 py-2">
                    <Badge tone={runStateTone(r)}>{runStateLabel(r)}</Badge>
                  </td>
                  <td className="px-3 py-2 text-text-muted">{TRIGGER_LABEL[r.trigger] ?? r.trigger}</td>
                  <td className="px-3 py-2 tabular-nums text-text-muted">
                    {r.succeededCount}/{r.nodeCount}
                    {r.failedCount > 0 && <span className="text-danger"> · {r.failedCount} failed</span>}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-text-muted">{r.evidenceCount || '—'}</td>
                  <td className="px-3 py-2 tabular-nums text-text-muted">{fmtDuration(r.ms)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {loading && <p className="mt-3 text-center text-[11.5px] text-text-subtle">Loading run…</p>}

      {all.length > 0 && (
        <p className="mt-4 flex items-start gap-1.5 text-[10.5px] leading-relaxed text-text-subtle">
          <Icon name="eye" size={11} className="mt-0.5 shrink-0" />
          Covers the workflows currently in your library. Runs belonging to a deleted workflow are not listed here.
        </p>
      )}
    </div>
  );
}
