/**
 * AllRuns — every run, across every workflow.
 * ==================================================================
 * Backed by the service's own index (`GET /workflow-runs`), which
 * filters, sorts and pages server-side.
 *
 * This used to flatten the per-workflow histories the store had already
 * read. That was wrong twice over: it covered only the workflows whose
 * history happened to have been fetched, and its counts were counts of
 * what the client held rather than of what exists. The totals shown here
 * are now the service's, over everything it has.
 *
 * The filters are query parameters, not array predicates. Nothing is
 * re-derived locally — including "waiting for you", which has its own
 * route because a superseded leg keeps its `awaiting-approval` state and
 * only the service knows which legs were continued.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Button, Icon, IconButton } from '@aura/ui';
import {
  aiClient,
  type NodeSpecInfo,
  type RunIndexQuery,
  type RunState,
  type RunTriggerKind,
  type WorkflowRun,
  type WorkflowRunSummary,
} from '../../ai/aiClient';
import { useWorkflows } from '../../data/useWorkflows';
import { useAgentLink } from '../../ai/agentLinkStore';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { RunView } from './RunView';
import {
  RUN_STATE_LABEL,
  TRIGGER_LABEL,
  carriedThroughFor,
  fmtDuration,
  runStateLabel,
  runStateTone,
} from './runs';

/** Outcome filters. `awaiting` is a route, not a state match — see below. */
type Outcome = 'all' | 'awaiting' | 'succeeded' | 'failed' | 'timed-out' | 'cancelled';

const OUTCOME_LABEL: Record<Outcome, string> = {
  all: 'All',
  awaiting: 'Waiting for you',
  succeeded: RUN_STATE_LABEL.succeeded,
  failed: RUN_STATE_LABEL.failed,
  'timed-out': RUN_STATE_LABEL['timed-out'],
  cancelled: RUN_STATE_LABEL.cancelled,
};

/* The service's own trigger vocabulary — a workflow run has no
   `schedule` kind of its own: a scheduled RULE starts one, and that
   arrives as `automation`. Listing a kind the index can never return
   would be a filter that always finds nothing. */
const TRIGGERS: (RunTriggerKind | 'any')[] = ['any', 'manual', 'automation', 'webhook', 'mission', 'resume'];

/** How far back to look. Sent as `since`, an ISO instant the service compares. */
type Window = 'any' | '24h' | '7d' | '30d';
const WINDOW_LABEL: Record<Window, string> = { any: 'Any time', '24h': 'Last 24 hours', '7d': 'Last 7 days', '30d': 'Last 30 days' };
const sinceFor = (w: Window): string | undefined => {
  if (w === 'any') return undefined;
  const ms = w === '24h' ? 86_400_000 : w === '7d' ? 7 * 86_400_000 : 30 * 86_400_000;
  return new Date(Date.now() - ms).toISOString();
};

const PAGE = 50;

export function AllRuns({
  specs,
  onOpenWorkflow,
}: {
  specs: Map<string, NodeSpecInfo>;
  onOpenWorkflow: (id: string) => void;
}) {
  const library = useWorkflows((s) => s.list);

  const [outcome, setOutcome] = useState<Outcome>('all');
  const [trigger, setTrigger] = useState<RunTriggerKind | 'any'>('any');
  const [workflowId, setWorkflowId] = useState<string>('');
  const [window_, setWindow] = useState<Window>('any');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);

  const [page, setPage] = useState<{ runs: WorkflowRunSummary[]; total: number } | null>(null);
  const [stats, setStats] = useState<Record<string, number>>({});
  const [awaitingCount, setAwaitingCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [open, setOpen] = useState<WorkflowRun | null>(null);
  const [chain, setChain] = useState<WorkflowRunSummary[] | undefined>(undefined);
  const [carried, setCarried] = useState<Record<string, number> | undefined>(undefined);
  const [loadingOne, setLoadingOne] = useState(false);

  /* Debounced, because `q` is a server round trip per keystroke otherwise.
     The delay is on the QUERY, not on the input, so typing stays instant. */
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(search.trim()), 250);
    return () => window.clearTimeout(t);
  }, [search]);

  const query = useMemo<RunIndexQuery>(() => ({
    workflowId: workflowId || undefined,
    // `awaiting` has its own route: a superseded leg still reads
    // `awaiting-approval`, so filtering by that state would list work
    // that has already been picked up by another run.
    state: outcome === 'all' || outcome === 'awaiting' ? undefined : (outcome as RunState),
    trigger: trigger === 'any' ? undefined : trigger,
    q: debounced || undefined,
    since: sinceFor(window_),
    limit: PAGE,
    offset,
  }), [workflowId, outcome, trigger, debounced, window_, offset]);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      if (outcome === 'awaiting') {
        /* The service's own answer. It is not paged, because the number of
           things genuinely waiting on a person is small by construction —
           if it ever is not, that is the problem, not the page size. */
        const res = await aiClient.runsAwaiting();
        if ('error' in res) throw new Error(String(res.error));
        const runs = res.runs.filter((r) => (workflowId ? r.workflowId === workflowId : true));
        setPage({ runs, total: runs.length });
      } else {
        const res = await aiClient.runIndex(query);
        if ('error' in res) throw new Error(String(res.error));
        setPage({ runs: res.runs, total: res.total });
      }
    } catch (e) {
      setError((e as Error).message);
      setPage(null);
    } finally {
      setBusy(false);
    }
  }, [query, outcome, workflowId]);

  useEffect(() => { void load(); }, [load]);

  // A Central Agent result can deep-link its engine run here. The lookup
  // uses the index-free find route; an unknown id surfaces the service's
  // own error rather than a silent no-op.
  const pendingAgentRun = useAgentLink((s) => s.pendingRunRequest);
  const consumeAgentRun = useAgentLink((s) => s.consumeRunRequest);
  const [agentLookupBusy, setAgentLookupBusy] = useState(false);
  useEffect(() => {
    if (!pendingAgentRun || agentLookupBusy || loadingOne) return;
    setAgentLookupBusy(true);
    const { runId } = pendingAgentRun;
    consumeAgentRun();
    void aiClient
      .findRun(runId)
      .then(async (rec) => {
        if (!('id' in rec)) throw new Error(`run ${runId} was not found`);
        await openRun({ workflowId: rec.workflowId, id: rec.id });
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setAgentLookupBusy(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per requested id
  }, [pendingAgentRun]);


  // Counts come from the index too, so a badge never disagrees with a list.
  useEffect(() => {
    let alive = true;
    void aiClient.runStats().then((s) => alive && 'stats' in s && setStats(s.stats)).catch(() => {});
    void aiClient.runsAwaiting().then((r) => alive && 'runs' in r && setAwaitingCount(r.runs.length)).catch(() => {});
    return () => { alive = false; };
  }, [page]);

  // Any filter change restarts paging; staying on page 4 of a different
  // result set shows an empty table for no stated reason.
  useEffect(() => { setOffset(0); }, [outcome, trigger, workflowId, window_, debounced]);

  const openRun = async (r: { workflowId: string; id: string }) => {
    setLoadingOne(true);
    try {
      const rec = await aiClient.workflowRun(r.workflowId, r.id);
      if ('id' in rec) {
        setOpen(rec);
        setChain(
          rec.supersededBy || rec.trigger.kind === 'resume'
            ? await aiClient
                .workflowRunChain(r.workflowId, r.id)
                .then((c) => ('chain' in c ? c.chain : undefined))
                .catch(() => undefined)
            : undefined,
        );
        const priorId = rec.trigger.kind === 'resume' ? rec.trigger.of : undefined;
        setCarried(
          typeof priorId === 'string'
            ? carriedThroughFor(
                await aiClient.workflowRun(r.workflowId, priorId).then((p) => ('id' in p ? p : null)).catch(() => null),
              )
            : undefined,
        );
      }
    } finally {
      setLoadingOne(false);
    }
  };

  if (open) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center gap-2 border-b border-line px-4 py-2">
          <Button variant="ghost" size="sm" icon="projects" onClick={() => { setOpen(null); void load(); }}>All runs</Button>
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

  const runs = page?.runs ?? [];
  const total = page?.total ?? 0;
  const showingTo = Math.min(offset + runs.length, total);
  const paged = outcome !== 'awaiting' && total > PAGE;

  return (
    <div className="mx-auto max-w-5xl px-6 py-6">
      <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-[17px] font-semibold tracking-[-0.01em] text-text">Runs</h2>
          <p className="mt-1 text-[12.5px] text-text-muted">
            {busy && !page
              ? 'Reading the run index…'
              : total === 0
                ? 'No runs match.'
                : `${total.toLocaleString()} run${total === 1 ? '' : 's'} · ${(stats.succeeded ?? 0).toLocaleString()} succeeded · ${(stats.failed ?? 0).toLocaleString()} failed`}
          </p>
        </div>
        <IconButton icon="refresh" label="Reload the run index" size="sm" onClick={() => void load()} />
      </header>

      {error && (
        <div className="mb-4">
          <ErrorState
            icon="bug"
            title="Couldn't read the run index"
            description={error}
            action={<Button size="sm" variant="secondary" icon="refresh" onClick={() => void load()}>Retry</Button>}
          />
        </div>
      )}

      {/* ── filters: every one of these is a query parameter ─────────── */}
      <div className="mb-3 space-y-2">
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by outcome">
          {(Object.keys(OUTCOME_LABEL) as Outcome[]).map((o) => {
            const count = o === 'awaiting' ? awaitingCount : o === 'all' ? null : stats[o];
            return (
              <button
                key={o}
                onClick={() => setOutcome(o)}
                aria-pressed={outcome === o}
                className={`rounded-full px-3 py-1 text-[11.5px] font-medium transition-colors ${
                  outcome === o ? 'bg-accent text-white' : 'bg-surface-active text-text-muted hover:text-text'
                }`}
              >
                {OUTCOME_LABEL[o]}
                {count !== null && count !== undefined && <span className="ml-1 opacity-70">{count}</span>}
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5">
            <span className="text-[10.5px] uppercase tracking-[0.09em] text-text-subtle">Workflow</span>
            <select
              value={workflowId}
              onChange={(e) => setWorkflowId(e.target.value)}
              aria-label="Filter by workflow"
              className="rounded-lg border border-line bg-surface px-2 py-1 text-[11.5px] text-text"
            >
              <option value="">Any workflow</option>
              {library.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </label>

          <label className="flex items-center gap-1.5">
            <span className="text-[10.5px] uppercase tracking-[0.09em] text-text-subtle">Trigger</span>
            <select
              value={trigger}
              onChange={(e) => setTrigger(e.target.value as RunTriggerKind | 'any')}
              aria-label="Filter by what started the run"
              className="rounded-lg border border-line bg-surface px-2 py-1 text-[11.5px] text-text"
            >
              {TRIGGERS.map((t) => (
                <option key={t} value={t}>{t === 'any' ? 'Any source' : TRIGGER_LABEL[t as RunTriggerKind] ?? t}</option>
              ))}
            </select>
          </label>

          <label className="flex items-center gap-1.5">
            <span className="text-[10.5px] uppercase tracking-[0.09em] text-text-subtle">When</span>
            <select
              value={window_}
              onChange={(e) => setWindow(e.target.value as Window)}
              aria-label="Filter by when the run started"
              className="rounded-lg border border-line bg-surface px-2 py-1 text-[11.5px] text-text"
            >
              {(Object.keys(WINDOW_LABEL) as Window[]).map((w) => <option key={w} value={w}>{WINDOW_LABEL[w]}</option>)}
            </select>
          </label>

          <label className="ml-auto flex items-center gap-1.5">
            <span className="sr-only">Search runs by workflow name</span>
            <span className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2 py-1">
              <Icon name="search" size={12} className="text-text-subtle" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by workflow name"
                aria-label="Search runs by workflow name"
                className="w-48 bg-transparent text-[11.5px] text-text outline-none placeholder:text-text-subtle"
              />
            </span>
          </label>
        </div>
      </div>

      {runs.length === 0 && !error ? (
        <EmptyState
          icon="activity"
          title={busy ? 'Reading…' : 'Nothing matches those filters'}
          description={
            outcome === 'awaiting'
              ? 'Nothing is waiting on a decision from you right now.'
              : 'Change the filters to see other runs. Runs are recorded by the service for every workflow it executes.'
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
              {runs.map((r) => (
                <tr
                  key={r.id}
                  onClick={() => void openRun(r)}
                  className="cursor-pointer border-b border-line/60 transition-colors last:border-b-0 hover:bg-surface-hover"
                >
                  <td className="px-3 py-2 font-medium text-text">{r.workflowName}</td>
                  <td className="px-3 py-2 text-text-muted">{new Date(r.createdAt).toLocaleString()}</td>
                  <td className="px-3 py-2">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <Badge tone={runStateTone(r)}>{runStateLabel(r)}</Badge>
                      {r.supersededBy && <span className="text-[10px] text-text-subtle">continued</span>}
                    </span>
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

      {paged && (
        <nav className="mt-3 flex items-center justify-between gap-2" aria-label="Run index pages">
          <span className="text-[11.5px] tabular-nums text-text-muted">
            {offset + 1}–{showingTo} of {total.toLocaleString()}
          </span>
          <span className="flex items-center gap-1.5">
            <Button
              size="sm"
              variant="secondary"
              disabled={offset === 0 || busy}
              onClick={() => setOffset(Math.max(0, offset - PAGE))}
            >
              Newer
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={showingTo >= total || busy}
              onClick={() => setOffset(offset + PAGE)}
            >
              Older
            </Button>
          </span>
        </nav>
      )}

      {loadingOne && <p className="mt-3 text-center text-[11.5px] text-text-subtle">Loading run…</p>}

      <p className="mt-4 flex items-start gap-1.5 text-[10.5px] leading-relaxed text-text-subtle">
        <Icon name="eye" size={11} className="mt-0.5 shrink-0" />
        Filtered and counted by the service over every run it holds — not by this screen over the ones it happens to
        have read.
      </p>
    </div>
  );
}
