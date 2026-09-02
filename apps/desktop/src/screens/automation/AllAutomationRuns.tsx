/**
 * AllAutomationRuns — every run, across every rule.
 * ==================================================================
 * Reads `GET /automation/runs`, which the service filters, sorts and
 * pages. The first version of this screen merged per-rule lists in the
 * browser; that is gone — searching and paging in the client over a
 * partial merge would have been a second index that could disagree with
 * the first.
 *
 * Each row's link to a workflow run comes from the run's structured
 * `produced` reference, so opening one is a direct fetch by both ids.
 * No summary string is parsed anywhere in this file.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Button, Icon, IconButton, Input } from '@aura/ui';
import {
  automationClient,
  type AutomationRunIndexRow,
  type AutomationRunStatus,
  type ProducedRef,
  type RunIndexQuery,
} from '../../ai/automationClient';
import { aiClient, type NodeSpecInfo, type WorkflowRun } from '../../ai/aiClient';
import { useWorkflows } from '../../data/useWorkflows';
import { useWorkspace } from '../../data/useWorkspace';
import { useFabric, pendingApprovals } from '../../data/useFabric';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { RunView } from '../workflows/RunView';
import { fmtDuration, relTime } from '../workflows/runs';
import { RUN_STATUS_LABEL, RUN_STATUS_TONE, TRIGGERS } from './automationMeta';

const PAGE = 25;

const STATUSES: AutomationRunStatus[] = ['completed', 'failed', 'cancelled', 'paused', 'running', 'retrying', 'queued'];

export interface AllAutomationRunsProps {
  specs: Map<string, NodeSpecInfo>;
  onOpenRule: (ruleId: string) => void;
}

export function AllAutomationRuns({ specs, onOpenRule }: AllAutomationRunsProps) {
  const workflows = useWorkflows((s) => s.list);
  const projects = useWorkspace((s) => s.projects);
  const [rows, setRows] = useState<AutomationRunIndexRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [q, setQ] = useState('');
  const [status, setStatus] = useState<AutomationRunStatus | ''>('');
  const [workflowId, setWorkflowId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [since, setSince] = useState('');

  const [open, setOpen] = useState<WorkflowRun | null>(null);

  const query: RunIndexQuery = useMemo(
    () => ({
      q: q.trim() || undefined,
      status: status || undefined,
      workflowId: workflowId || undefined,
      projectId: projectId || undefined,
      since: since ? new Date(since).toISOString() : undefined,
      limit: PAGE,
      offset,
    }),
    [q, status, workflowId, projectId, since, offset],
  );

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await automationClient.runIndex(query);
      setRows(res.runs ?? []);
      setTotal(res.total ?? 0);
    } catch (e) {
      setRows([]);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [query]);

  // Debounced, because the search box drives a real request.
  useEffect(() => {
    const t = window.setTimeout(() => void load(), 250);
    return () => window.clearTimeout(t);
  }, [load]);

  // Any filter change starts the listing again from the top.
  useEffect(() => { setOffset(0); }, [q, status, workflowId, projectId, since]);

  const workflowName = useMemo(() => {
    const byId = new Map(workflows.map((w) => [w.id, w.name]));
    return (id: string) => byId.get(id) ?? id;
  }, [workflows]);

  if (open) return <LinkedRunPane run={open} specs={specs} onBack={() => setOpen(null)} />;

  const filtered = Boolean(q || status || workflowId || projectId || since);

  return (
    <div className="mx-auto max-w-6xl px-6 py-6">
      <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-[17px] font-semibold tracking-[-0.01em] text-text">Automation runs</h2>
          <p className="mt-1 text-[12.5px] text-text-muted">
            {rows === null
              ? 'Reading the run index…'
              : total === 0
                ? filtered ? 'Nothing matches those filters.' : 'No automation run has happened yet.'
                : `${total} run${total === 1 ? '' : 's'}${filtered ? ' matching' : ''} · indexed by the service`}
          </p>
        </div>
        <IconButton icon="refresh" label="Reload the run index" size="sm" onClick={() => void load()} />
      </header>

      {/* ── filters ───────────────────────────────────────────────── */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Input
          icon="search"
          placeholder="Search by rule name…"
          aria-label="Search automation runs by rule name"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="w-64"
        />
        <Select label="State" value={status} onChange={(v) => setStatus(v as AutomationRunStatus | '')}
          options={[['', 'Any state'], ...STATUSES.map((s) => [s, RUN_STATUS_LABEL[s]] as [string, string])]} />
        <Select label="Workflow" value={workflowId} onChange={setWorkflowId}
          options={[['', 'Any workflow'], ...workflows.map((w) => [w.id, w.name] as [string, string])]} />
        <Select label="Project" value={projectId} onChange={setProjectId}
          options={[['', 'Any project'], ...projects.map((p) => [p.id, p.name] as [string, string])]} />
        <label className="flex items-center gap-1.5">
          <span className="text-[11px] text-text-subtle">Since</span>
          <input
            type="date"
            value={since}
            onChange={(e) => setSince(e.target.value)}
            aria-label="Only runs since this date"
            className="rounded-lg border border-line bg-canvas px-2 py-1 text-[11.5px] text-text outline-none focus:border-accent"
          />
        </label>
        {filtered && (
          <Button size="sm" variant="ghost" icon="close" onClick={() => { setQ(''); setStatus(''); setWorkflowId(''); setProjectId(''); setSince(''); }}>
            Clear
          </Button>
        )}
      </div>

      {error && (
        <div className="mb-4">
          <ErrorState
            icon="bug"
            title="Couldn't read the automation run index"
            description={error}
            action={<Button size="sm" variant="secondary" icon="refresh" onClick={() => void load()}>Retry</Button>}
          />
        </div>
      )}

      {rows !== null && rows.length === 0 && !error ? (
        <EmptyState
          icon="activity"
          title={filtered ? 'Nothing matches those filters' : 'No automation runs yet'}
          description={
            filtered
              ? 'Widen the filters, or clear them to see everything.'
              : 'A rule records a run whenever its trigger fires and its conditions pass.'
          }
        />
      ) : (
        rows !== null && (
          <>
            <div className="overflow-x-auto rounded-xl border border-line bg-canvas">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="border-b border-line text-left text-[10px] uppercase tracking-[0.11em] text-text-subtle">
                    <th className="px-3 py-2 font-semibold">Rule</th>
                    <th className="px-3 py-2 font-semibold">Started</th>
                    <th className="px-3 py-2 font-semibold">Outcome</th>
                    <th className="px-3 py-2 font-semibold">Trigger</th>
                    <th className="px-3 py-2 font-semibold">Started a workflow</th>
                    <th className="px-3 py-2 font-semibold">Project</th>
                    <th className="px-3 py-2 font-semibold">Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <Row
                      key={r.id}
                      row={r}
                      workflowName={workflowName}
                      onOpenRule={() => onOpenRule(r.ruleId)}
                      onOpenWorkflowRun={async (ref) => {
                        const rec = await aiClient.workflowRun(ref.workflowId, ref.runId).catch(() => null);
                        if (rec && 'id' in rec) setOpen(rec);
                      }}
                    />
                  ))}
                </tbody>
              </table>
            </div>

            {/* ── pagination ────────────────────────────────────── */}
            {total > PAGE && (
              <div className="mt-3 flex items-center justify-between">
                <span className="text-[11.5px] text-text-subtle">
                  {offset + 1}–{Math.min(offset + PAGE, total)} of {total}
                </span>
                <div className="flex items-center gap-1.5">
                  <Button size="sm" variant="secondary" disabled={offset === 0 || busy} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
                    Previous
                  </Button>
                  <Button size="sm" variant="secondary" disabled={offset + PAGE >= total || busy} onClick={() => setOffset(offset + PAGE)}>
                    Next
                  </Button>
                </div>
              </div>
            )}
          </>
        )
      )}

      <p className="mt-4 flex items-start gap-1.5 text-[10.5px] leading-relaxed text-text-subtle">
        <Icon name="eye" size={11} className="mt-0.5 shrink-0" />
        Filtered and paged by the service. A run's link to a workflow run comes from the run record itself, so opening
        one resolves directly by id.
      </p>
    </div>
  );
}

/* ── pieces ────────────────────────────────────────────────────────── */

function Row({
  row,
  workflowName,
  onOpenRule,
  onOpenWorkflowRun,
}: {
  row: AutomationRunIndexRow;
  workflowName: (id: string) => string;
  onOpenRule: () => void;
  onOpenWorkflowRun: (ref: Extract<ProducedRef, { kind: 'workflow-run' }>) => void;
}) {
  const produced = (row.produced ?? []).filter((p): p is Extract<ProducedRef, { kind: 'workflow-run' }> => p.kind === 'workflow-run');
  return (
    <tr className="border-b border-line/60 transition-colors last:border-b-0 hover:bg-surface-hover">
      <td className="px-3 py-2">
        <button onClick={onOpenRule} className="text-left font-medium text-text hover:text-accent">
          {row.ruleName ?? <span className="text-text-subtle">rule deleted</span>}
        </button>
      </td>
      <td className="px-3 py-2 text-text-muted" title={new Date(row.startedAt).toLocaleString()}>
        {relTime(row.startedAt)} · {new Date(row.startedAt).toLocaleTimeString()}
      </td>
      <td className="px-3 py-2">
        <Badge tone={RUN_STATUS_TONE[row.status]}>{RUN_STATUS_LABEL[row.status]}</Badge>
        {row.error && <div className="mt-0.5 line-clamp-1 text-[10.5px] text-danger">{row.error}</div>}
      </td>
      <td className="px-3 py-2 text-text-muted">{TRIGGERS[row.trigger]?.label ?? row.trigger}</td>
      <td className="px-3 py-2">
        {produced.length ? (
          <div className="flex flex-col gap-0.5">
            {produced.map((p) => (
              <button
                key={p.runId}
                onClick={() => onOpenWorkflowRun(p)}
                className="flex items-center gap-1.5 text-left text-[11.5px] text-accent hover:underline"
              >
                <Icon name="workflows" size={10} />
                {workflowName(p.workflowId)}
                <Badge tone={p.state === 'succeeded' ? 'positive' : p.state === 'awaiting-approval' ? 'attention' : p.state === 'failed' || p.state === 'timed-out' ? 'critical' : 'neutral'}>
                  {p.state}
                </Badge>
              </button>
            ))}
          </div>
        ) : (
          <span className="text-text-subtle">—</span>
        )}
      </td>
      <td className="px-3 py-2 text-text-muted">{row.projectId || '—'}</td>
      <td className="px-3 py-2 tabular-nums text-text-muted">{row.ms ? fmtDuration(row.ms) : '—'}</td>
    </tr>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: [string, string][];
}) {
  return (
    <label className="flex items-center gap-1.5">
      <span className="text-[11px] text-text-subtle">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        className="max-w-[180px] rounded-lg border border-line bg-canvas px-2 py-1 text-[11.5px] text-text outline-none focus:border-accent"
      >
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );
}

/** The linked workflow run, in the existing viewer. Never a second one. */
function LinkedRunPane({
  run,
  specs,
  onBack,
}: {
  run: WorkflowRun;
  specs: Map<string, NodeSpecInfo>;
  onBack: () => void;
}) {
  const approvals = useFabric((s) => s.approvals);
  const deciding = useFabric((s) => s.deciding);
  const decide = useFabric((s) => s.decide);
  const watch = useFabric((s) => s.watchApprovals);
  const [current, setCurrent] = useState(run);

  useEffect(() => watch(), [watch]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2">
        <Button variant="ghost" size="sm" icon="projects" onClick={onBack}>Automation runs</Button>
        <span className="text-[13px] font-semibold text-text">{current.workflowName}</span>
        <span className="text-[11.5px] text-text-subtle">started by a rule</span>
      </div>
      <div className="min-h-0 flex-1">
        <RunView
          run={current}
          specs={specs}
          graphOrder={Object.keys(current.nodes)}
          approvals={pendingApprovals(approvals)}
          decidingId={deciding}
          onDecideApproval={async (id, granted, reason) => {
            await decide(id, granted, reason);
            const fresh = await aiClient.workflowRun(current.workflowId, current.id).catch(() => null);
            if (fresh && 'id' in fresh) setCurrent(fresh);
          }}
        />
      </div>
    </div>
  );
}
