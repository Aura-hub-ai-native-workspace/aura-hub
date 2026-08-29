/**
 * AutomationRunView — what a rule did, and what it handed on.
 * ==================================================================
 * An automation run is a *chain of actions*, not a graph, so it gets its
 * own reading: which conditions passed, which steps ran, and the engine's
 * own timeline. What it deliberately does **not** do is re-render a
 * workflow run — a `run-workflow` step links into the existing
 * `RunView`, which stays the single implementation of run detail.
 *
 * The link is structural. The engine records a `produced` reference on
 * the action — `{ kind: 'workflow-run', workflowId, runId, state }` — so
 * the workflow run resolves directly. No summary string is parsed.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { Badge, Button, Icon, IconButton } from '@aura/ui';
import {
  automationClient,
  producedWorkflowRun,
  type ActionRunState,
  type AutomationRun,
  type AutomationRunSummary,
} from '../../ai/automationClient';
import { aiClient, type NodeSpecInfo, type WorkflowRun } from '../../ai/aiClient';
import { useAutomation } from '../../data/useAutomation';
import { useFabric, pendingApprovals } from '../../data/useFabric';
import { useWorkflows } from '../../data/useWorkflows';
import { EmptyState } from '../../components/EmptyState';
import { RunView } from '../workflows/RunView';
import { fmtDuration, relTime } from '../workflows/runs';
import {
  ACTIONS,
  ACTION_STATUS_LABEL,
  ACTION_STATUS_TONE,
  RUN_STATUS_LABEL,
  RUN_STATUS_TONE,
  TIMELINE_COLOR,
  TIMELINE_ICON,
  TRIGGERS,
} from './automationMeta';
import { CONDITION_OPS } from './automationMeta';

/** A `run-workflow` step whose link has been confirmed against the service. */
interface VerifiedLink {
  actionId: string;
  workflowId: string;
  workflowRunId: string;
  run: WorkflowRun;
}

export interface AutomationRunViewProps {
  ruleId: string;
  onBack: () => void;
}

export function AutomationRunView({ ruleId, onBack }: AutomationRunViewProps) {
  const auto = useAutomation();
  const rule = auto.defs[ruleId];
  const summaries = auto.runs[ruleId] ?? [];
  const specs = useWorkflows((s) => s.specs);
  const [openId, setOpenId] = useState<string | null>(null);
  const [run, setRun] = useState<AutomationRun | null>(null);
  const [links, setLinks] = useState<VerifiedLink[]>([]);
  const [showWorkflowRun, setShowWorkflowRun] = useState<VerifiedLink | null>(null);

  const specOf = useMemo(() => new Map(specs.map((s) => [s.type, s])), [specs]);

  useEffect(() => { void auto.loadRuns(ruleId); void auto.loadRule(ruleId); }, [ruleId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => auto.watch(), [auto.watch]);

  // Open the newest run by default — the question is almost always
  // "what just happened", not "show me a list".
  useEffect(() => {
    if (!openId && summaries.length) setOpenId(summaries[0].id);
  }, [summaries, openId]);

  const loadRun = useCallback(async (runId: string) => {
    const res = await automationClient.getRun(ruleId, runId).catch(() => null);
    if (!res || 'error' in res) { setRun(null); setLinks([]); return; }
    setRun(res);

    // Both ids come straight off the action's `produced` reference, so
    // each link is one direct fetch with nothing inferred.
    const found: VerifiedLink[] = [];
    for (const a of res.actions) {
      const ref = producedWorkflowRun(a);
      if (!ref) continue;
      const wfRun = await aiClient.workflowRun(ref.workflowId, ref.runId).catch(() => null);
      if (!wfRun || !('id' in wfRun)) continue;
      found.push({ actionId: a.actionId, workflowId: ref.workflowId, workflowRunId: ref.runId, run: wfRun });
    }
    setLinks(found);
  }, [ruleId]);

  useEffect(() => { if (openId) void loadRun(openId); }, [openId, loadRun, summaries]);

  if (showWorkflowRun) {
    return (
      <WorkflowRunPane
        link={showWorkflowRun}
        specOf={specOf}
        onBack={() => setShowWorkflowRun(null)}
        onReload={() => void loadRun(openId!)}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
        <Button variant="ghost" size="sm" icon="projects" onClick={onBack}>All rules</Button>
        <div className="h-5 w-px bg-line" />
        <span className="text-[13.5px] font-semibold text-text">{rule?.name ?? 'Rule'}</span>
        <span className="text-[11.5px] text-text-subtle">
          {rule ? TRIGGERS[rule.trigger.type]?.when : ''}
        </span>
        <IconButton icon="refresh" label="Reload runs" size="sm" className="ml-auto" onClick={() => void auto.loadRuns(ruleId)} />
      </div>

      {summaries.length === 0 ? (
        <div className="px-6 py-10">
          <EmptyState
            icon="activity"
            title="This rule has not run yet"
            description="It runs when its trigger fires, or when you use “Run now” from the rules list."
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* run list */}
          <ul className="w-[260px] shrink-0 overflow-y-auto border-r border-line">
            {summaries.map((s) => (
              <RunListItem key={s.id} summary={s} active={s.id === openId} onSelect={() => setOpenId(s.id)} />
            ))}
          </ul>

          {/* run detail */}
          <div className="min-h-0 flex-1 overflow-y-auto">
            {run ? (
              <RunDetail
                run={run}
                links={links}
                onOpenWorkflowRun={setShowWorkflowRun}
                onCancel={() => void auto.cancelRun(ruleId, run.id)}
              />
            ) : (
              <p className="px-6 py-8 text-center text-[12px] text-text-muted">Select a run.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── list ──────────────────────────────────────────────────────────── */

function RunListItem({
  summary,
  active,
  onSelect,
}: {
  summary: AutomationRunSummary;
  active: boolean;
  onSelect: () => void;
}) {
  const live = summary.status === 'running' || summary.status === 'retrying' || summary.status === 'queued';
  return (
    <li>
      <button
        onClick={onSelect}
        className={`flex w-full flex-col items-start gap-1 border-b border-line/60 px-3 py-2.5 text-left transition-colors ${
          active ? 'bg-surface-active' : 'hover:bg-surface-hover'
        }`}
      >
        <span className="flex w-full items-center gap-2">
          {live ? (
            <motion.span animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1.2, ease: 'linear' }} className="text-accent">
              <Icon name="activity" size={11} />
            </motion.span>
          ) : (
            <Icon
              name={summary.status === 'completed' ? 'check' : summary.status === 'cancelled' || summary.status === 'paused' ? 'bell' : 'close'}
              size={11}
              className={
                summary.status === 'completed' ? 'text-positive'
                  : summary.status === 'cancelled' || summary.status === 'paused' ? 'text-attention'
                  : 'text-danger'
              }
            />
          )}
          <Badge tone={RUN_STATUS_TONE[summary.status]}>{RUN_STATUS_LABEL[summary.status]}</Badge>
          <span className="ml-auto text-[10px] tabular-nums text-text-subtle">{summary.ms ? fmtDuration(summary.ms) : ''}</span>
        </span>
        <span className="text-[10.5px] text-text-subtle">{relTime(summary.startedAt)} · {new Date(summary.startedAt).toLocaleTimeString()}</span>
        {summary.error && <span className="line-clamp-1 text-[10.5px] text-danger">{summary.error}</span>}
      </button>
    </li>
  );
}

/* ── detail ────────────────────────────────────────────────────────── */

function RunDetail({
  run,
  links,
  onOpenWorkflowRun,
  onCancel,
}: {
  run: AutomationRun;
  links: VerifiedLink[];
  onOpenWorkflowRun: (l: VerifiedLink) => void;
  onCancel: () => void;
}) {
  const live = run.status === 'running' || run.status === 'retrying' || run.status === 'queued';
  const failedConditions = run.conditions.filter((c) => !c.passed);

  return (
    <div className="space-y-3 px-5 py-4">
      {/* ── the causal chain, stated once ──────────────────────────
          A rule run is a chain of causes, and the reason it is worth
          drawing is that the last two links live in another engine. */}
      <ChainStrip run={run} links={links} />

      {/* headline */}
      <header className="flex flex-wrap items-center gap-2">
        <Badge tone={RUN_STATUS_TONE[run.status]}>{RUN_STATUS_LABEL[run.status]}</Badge>
        <span className="text-[12px] text-text-muted">
          {run.actions.filter((a) => a.status === 'completed').length}/{run.actions.length} steps
        </span>
        {run.ms !== undefined && <span className="text-[12px] tabular-nums text-text-muted">{fmtDuration(run.ms)}</span>}
        <code className="rounded bg-surface-active px-1.5 py-0.5 text-[10px] text-text-subtle">{run.event.type}</code>
        {live && <Button size="sm" variant="danger" icon="close" className="ml-auto" onClick={onCancel}>Cancel</Button>}
      </header>

      {run.status === 'failed' && run.error && (
        <Notice tone="danger" icon="close" title="This run failed.">
          <p className="mt-0.5 break-words text-[11.5px] leading-relaxed text-text-muted">{run.error}</p>
          <p className="mt-1 text-[10.5px] text-text-subtle">
            Steps that completed before it stopped have already had their effect. The engine does not undo them.
          </p>
        </Notice>
      )}
      {run.status === 'cancelled' && (
        <Notice tone="attention" icon="bell" title="This run was cancelled.">
          <p className="mt-0.5 text-[11.5px] text-text-muted">{run.error ?? 'Stopped before it finished.'}</p>
        </Notice>
      )}
      {run.status === 'paused' && (
        <Notice tone="attention" icon="dot" title="This run is paused.">
          <p className="mt-0.5 text-[11.5px] text-text-muted">It will continue from where it stopped when you resume the rule.</p>
        </Notice>
      )}

      {/* conditions */}
      {run.conditions.length > 0 && (
        <section className="rounded-xl border border-line bg-canvas p-3">
          <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-text-subtle">
            Conditions {failedConditions.length ? '— one did not pass' : '— all passed'}
          </h4>
          <ul className="space-y-1">
            {run.conditions.map((c) => (
              <li key={c.index} className="flex flex-wrap items-center gap-2 text-[11.5px]">
                <Icon name={c.passed ? 'check' : 'close'} size={11} className={c.passed ? 'text-positive' : 'text-danger'} />
                <code className="rounded bg-surface-active px-1.5 py-0.5 text-[10.5px] text-text">{c.field}</code>
                <span className="text-text-muted">{CONDITION_OPS[c.op]?.label ?? c.op}</span>
                {c.note && <span className="text-text-subtle">— {c.note}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* the chain */}
      <section className="rounded-xl border border-line bg-canvas">
        <h4 className="border-b border-line px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-text-subtle">
          Steps
        </h4>
        <ol className="divide-y divide-line/60">
          {run.actions.map((a, i) => (
            <ActionStep
              key={a.actionId}
              index={i}
              action={a}
              link={links.find((l) => l.actionId === a.actionId) ?? null}
              onOpenWorkflowRun={onOpenWorkflowRun}
            />
          ))}
          {!run.actions.length && <li className="px-3 py-3 text-[11.5px] text-text-muted">No steps ran.</li>}
        </ol>
      </section>

      {/* timeline */}
      <section className="rounded-xl border border-line bg-canvas p-3">
        <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-text-subtle">Timeline</h4>
        <ul className="relative ml-2 space-y-2 border-l border-line pl-4">
          {run.timeline.map((t, i) => (
            <li key={`${t.id}-${i}`} className="relative">
              <span className="absolute -left-[22px] top-0.5 grid h-[13px] w-[13px] place-items-center rounded-full border border-line bg-surface">
                <Icon name={TIMELINE_ICON[t.type]} size={8} style={{ color: TIMELINE_COLOR[t.type] }} />
              </span>
              <span className="flex flex-wrap items-baseline gap-x-2">
                <span className={`text-[11.5px] ${t.level === 'error' ? 'text-danger' : t.level === 'warn' ? 'text-attention' : 'text-text'}`}>
                  {t.message}
                </span>
                <span className="ml-auto whitespace-nowrap text-[10px] text-text-subtle">
                  {new Date(t.at).toLocaleTimeString()}
                </span>
              </span>
            </li>
          ))}
          {!run.timeline.length && <li className="text-[11.5px] text-text-muted">No timeline entries.</li>}
        </ul>
      </section>
    </div>
  );
}

function ChainStrip({ run, links }: { run: AutomationRun; links: VerifiedLink[] }) {
  const evidence = links.reduce((n, l) => n + l.run.evidence.length, 0);
  const passed = run.conditions.every((c) => c.passed);
  const beats: { label: string; detail: string; tone: 'ok' | 'warn' | 'bad' | 'muted' }[] = [
    { label: 'Rule', detail: 'fired', tone: 'ok' },
    { label: 'Trigger', detail: run.event.type, tone: 'ok' },
    {
      label: 'Conditions',
      detail: run.conditions.length ? (passed ? `${run.conditions.length} passed` : 'did not pass') : 'none',
      tone: run.conditions.length && !passed ? 'warn' : 'ok',
    },
    { label: 'Actions', detail: `${run.actions.length}`, tone: run.actions.some((a) => a.status === 'failed') ? 'bad' : 'ok' },
    {
      label: 'Workflow run',
      detail: links.length ? links.map((l) => l.run.state).join(', ') : 'none started',
      tone: links.length ? (links.some((l) => l.run.state === 'awaiting-approval') ? 'warn' : 'ok') : 'muted',
    },
    { label: 'Evidence', detail: evidence ? `${evidence} governed` : 'none', tone: evidence ? 'ok' : 'muted' },
  ];

  const colour = (t: string) =>
    t === 'bad' ? 'text-danger' : t === 'warn' ? 'text-attention' : t === 'muted' ? 'text-text-subtle' : 'text-text';

  return (
    <ol className="flex flex-wrap items-center gap-x-1 gap-y-1.5 rounded-xl border border-line bg-canvas px-3 py-2">
      {beats.map((b, i) => (
        <li key={b.label} className="flex items-center gap-1">
          <span className="flex flex-col">
            <span className="text-[9.5px] font-semibold uppercase tracking-[0.1em] text-text-subtle">{b.label}</span>
            <span className={`text-[11.5px] ${colour(b.tone)}`}>{b.detail}</span>
          </span>
          {i < beats.length - 1 && <Icon name="code" size={10} className="mx-1 shrink-0 text-text-subtle" aria-hidden />}
        </li>
      ))}
    </ol>
  );
}

function ActionStep({
  index,
  action,
  link,
  onOpenWorkflowRun,
}: {
  index: number;
  action: ActionRunState;
  link: VerifiedLink | null;
  onOpenWorkflowRun: (l: VerifiedLink) => void;
}) {
  const meta = ACTIONS[action.action];
  // A workflow parked on an approval is the automation working correctly:
  // it fired without a person present and the policy engine stopped it.
  const parked = link?.run.state === 'awaiting-approval';

  return (
    <li className="px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="grid h-5 w-5 shrink-0 place-items-center rounded-md bg-surface-active font-mono text-[10px] text-text-muted">
          {index + 1}
        </span>
        <Icon name={meta?.icon ?? 'workflows'} size={12} className="text-text-subtle" />
        <span className="text-[12.5px] font-medium text-text">{action.label}</span>
        <Badge tone={ACTION_STATUS_TONE[action.status]}>{ACTION_STATUS_LABEL[action.status]}</Badge>
        {action.attempts > 1 && <span className="text-[10.5px] text-attention">attempt {action.attempts}</span>}
        {action.ms !== undefined && <span className="text-[10.5px] tabular-nums text-text-subtle">{fmtDuration(action.ms)}</span>}
      </div>

      {action.error && <p className="ml-7 mt-0.5 break-words text-[11.5px] text-danger">{action.error}</p>}
      {action.summary && !link && <p className="ml-7 mt-0.5 text-[11.5px] text-text-muted">{action.summary}</p>}

      {link && (
        <div className={`ml-7 mt-1.5 rounded-lg border px-2.5 py-2 ${parked ? 'border-attention/40 bg-attention/[0.06]' : 'border-line bg-surface'}`}>
          <div className="flex flex-wrap items-center gap-2">
            <Icon name="workflows" size={12} className={parked ? 'text-attention' : 'text-text-subtle'} />
            <span className="text-[11.5px] text-text">{link.run.workflowName}</span>
            <Badge tone={parked ? 'attention' : link.run.state === 'succeeded' ? 'positive' : link.run.state === 'failed' || link.run.state === 'timed-out' ? 'critical' : 'neutral'}>
              {link.run.state}
            </Badge>
            {link.run.evidence.length > 0 && (
              <span className="text-[10.5px] text-text-subtle">
                {link.run.evidence.length} governed action{link.run.evidence.length === 1 ? '' : 's'}
              </span>
            )}
            <Button size="sm" variant="ghost" icon="eye" className="ml-auto" onClick={() => onOpenWorkflowRun(link)}>
              Open run
            </Button>
          </div>
          {parked && (
            <p className="mt-1 text-[10.5px] leading-relaxed text-text-muted">
              The automation did its job and the workflow is waiting on a person. An automation authorizes nothing, so a
              governed step above auto-execute parks here until you answer it.
            </p>
          )}
        </div>
      )}
    </li>
  );
}

/* ── the workflow run, in the existing viewer ──────────────────────── */

function WorkflowRunPane({
  link,
  specOf,
  onBack,
  onReload,
}: {
  link: VerifiedLink;
  specOf: Map<string, NodeSpecInfo>;
  onBack: () => void;
  onReload: () => void;
}) {
  const [run, setRun] = useState<WorkflowRun>(link.run);
  const approvals = useFabric((s) => s.approvals);
  const deciding = useFabric((s) => s.deciding);
  const decide = useFabric((s) => s.decide);
  const watch = useFabric((s) => s.watchApprovals);

  useEffect(() => watch(), [watch]);

  const reload = useCallback(async () => {
    const fresh = await aiClient.workflowRun(link.workflowId, link.workflowRunId).catch(() => null);
    if (fresh && 'id' in fresh) setRun(fresh);
    onReload();
  }, [link, onReload]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2">
        <Button variant="ghost" size="sm" icon="projects" onClick={onBack}>Automation run</Button>
        <span className="text-[13px] font-semibold text-text">{run.workflowName}</span>
        <span className="text-[11.5px] text-text-subtle">started by this rule</span>
        <IconButton icon="refresh" label="Reload this run" size="sm" className="ml-auto" onClick={() => void reload()} />
      </div>
      <div className="min-h-0 flex-1">
        {/* The single implementation of run detail. Nothing is re-rendered
            here — approvals, evidence, steps and states all come from it. */}
        <RunView
          run={run}
          specs={specOf}
          graphOrder={Object.keys(run.nodes)}
          approvals={pendingApprovals(approvals)}
          onDecideApproval={async (id, granted, reason) => {
            await decide(id, granted, reason);
            await reload();
          }}
          decidingId={deciding}
        />
      </div>
    </div>
  );
}

function Notice({
  tone,
  icon,
  title,
  children,
}: {
  tone: 'danger' | 'attention';
  icon: 'close' | 'bell' | 'dot';
  title: string;
  children?: React.ReactNode;
}) {
  const cls = tone === 'danger' ? 'border-danger/25 bg-danger/[0.06]' : 'border-attention/25 bg-attention/[0.06]';
  const ic = tone === 'danger' ? 'text-danger' : 'text-attention';
  return (
    <div className={`rounded-xl border px-3 py-2 ${cls}`}>
      <div className="flex items-start gap-2">
        <Icon name={icon} size={13} className={`mt-0.5 shrink-0 ${ic}`} />
        <div className="min-w-0">
          <p className="text-[12px] font-medium text-text">{title}</p>
          {children}
        </div>
      </div>
    </div>
  );
}
