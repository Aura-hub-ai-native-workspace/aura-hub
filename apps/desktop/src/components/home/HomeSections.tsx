/**
 * Home sections — ACTIVE / AUTOMATIONS / ACTIVITY.
 * =====================================================================
 * Every number and row here comes from a real backend contract:
 *
 *   ACTIVE      → `aiClient.runIndex({ state: 'running' })`,
 *                 `useAutomation` live runs, `useFabric` pending approvals
 *   AUTOMATIONS → `useAutomation.schedules` (next fire + missed counts)
 *   ACTIVITY    → succeeded index runs that carry evidence
 *
 * When a source is unreachable the section says so plainly; when it has
 * nothing to show it offers the next action instead of decoration.
 * No fake activity, no invented metrics — see docs/AGENT_HOME_UX.md.
 *
 * Polling is deliberately light (15s while Home is mounted) because every
 * list here is also visible in its owning domain; Home is the overview,
 * not a second source of truth.
 */

import { useEffect, useState } from 'react';
import { cn, spring, useAppStore } from '@aura/core';
import { motion } from 'framer-motion';
import { Badge, Button, Card, CardHeader, Icon } from '@aura/ui';
import { PageBlock } from '../../screens/PageContainer';
import { EmptyState } from '../EmptyState';
import { StatusChip } from '../states/StatusChip';
import { aiClient, type WorkflowRunSummary } from '../../ai/aiClient';
import { useAutomation } from '../../data/useAutomation';
import type { AutomationRunSummary } from '../../ai/automationClient';
import { useFabric } from '../../data/useFabric';
import { useAgentLink } from '../../ai/agentLinkStore';

const POLL_MS = 15_000;

function relTime(iso: string | undefined | null): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.round(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  if (m < 24 * 60) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / (24 * 60))}d ago`;
}

function untilTime(iso: string | undefined): string {
  if (!iso) return '—';
  const diff = new Date(iso).getTime() - Date.now();
  const m = Math.round(diff / 60000);
  if (m < 0) return 'due';
  if (m < 60) return `in ${m}m`;
  if (m < 24 * 60) return `in ${Math.round(m / 60)}h`;
  return `in ${Math.round(m / (24 * 60))}d`;
}

/* ── ACTIVE ────────────────────────────────────────────────────────── */

export function ActiveSection() {
  const setNav = useAppStore((s) => s.setNav);
  const [running, setRunning] = useState<WorkflowRunSummary[] | null>(null);
  const [reachable, setReachable] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      void aiClient.runIndex({ state: 'running', limit: 8 })
        .then((page) => {
          if (!alive) return;
          // A superseded run was continued by another leg; the continuation,
          // not the parked record, describes what is actually running.
          setRunning(page.runs.filter((r) => !r.supersededBy));
          setReachable(true);
        })
        .catch(() => alive && setReachable(false));
    };
    load();
    const t = window.setInterval(load, POLL_MS);
    return () => { alive = false; window.clearInterval(t); };
  }, []);

  const automation = useAutomation();
  const activeAutomations = Object.values(automation.runs)
    .flat()
    .filter((r) => r.status === 'queued' || r.status === 'retrying');
  const fabricReachable = useFabric((s) => s.reachable);
  const approvals = useFabric((s) => s.approvals).filter((a) => a.state === 'pending');
  // The agent itself can be waiting on the user — surfaced from the real
  // outcome of this machine's most recent agent session.
  const agentWaiting = useAgentLink((s) => s.lastOutcome === 'awaiting-approval');
  const agentSessionId = useAgentLink((s) => s.lastSessionId);

  const counts = {
    workflows: running?.length ?? 0,
    automations: activeAutomations.length,
    approvals: approvals.length,
    agent: agentWaiting ? 1 : 0,
  };
  const isEmpty =
    counts.workflows === 0 && counts.automations === 0 &&
    counts.approvals === 0 && counts.agent === 0;

  return (
    <PageBlock className="mb-5">
      <Card padding="none" className="overflow-hidden">
        <div className="flex items-center justify-between px-6 pt-5">
          <CardHeader title="Active" subtitle="Running workflows, automations and decisions waiting for you" />
          <Button size="sm" variant="ghost" iconRight="chevron-right" onClick={() => setNav('workflows')}>
            Automation
          </Button>
        </div>

        {reachable === false ? (
          <div className="px-6 pb-6">
            <EmptyState
              icon="activity"
              title="Workflow service unreachable"
              description="Active work cannot be shown right now. Start the service and this section fills from the real run index."
              compact
            />
          </div>
        ) : isEmpty ? (
          <div className="px-6 pb-6">
            <EmptyState
              icon="check"
              title="Nothing is running"
              description="Workflows, automations and approval requests will appear here while they are in flight."
              action={<Button size="sm" variant="secondary" icon="spark" onClick={() => document.getElementById('ask-aura-input')?.focus()}>Ask AURA instead</Button>}
              compact
            />
          </div>
        ) : (
          <ul className="mt-4 divide-y divide-line border-t border-line" aria-label="Currently active work">
            {agentWaiting && (
              <li>
                <button
                  onClick={() => setNav('home')}
                  className="flex w-full items-center gap-3 px-6 py-3 text-left transition-colors hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
                >
                  <StatusChip state="awaiting-approval" label="Agent waiting" />
                  <span className="min-w-0 flex-1 truncate text-[13px] text-text">
                    A Central Agent request needs your decision
                  </span>
                  <span className="hidden text-[11.5px] text-text-subtle sm:block">
                    session {agentSessionId?.slice(0, 12)}
                  </span>
                  <Icon name="chevron-right" size={15} className="text-text-subtle" />
                </button>
              </li>
            )}
            {approvals.slice(0, 3).map((a) => (
              <li key={a.id}>
                <button
                  onClick={() => setNav('workflows')}
                  className="flex w-full items-center gap-3 px-6 py-3 text-left transition-colors hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
                >
                  <StatusChip state="awaiting-approval" />
                  <span className="min-w-0 flex-1 truncate text-[13px] text-text">
                    {a.items[0]?.title ?? a.summary}
                  </span>
                  <span className="hidden text-[11.5px] text-text-subtle sm:block">
                    decision needed · {relTime(a.requestedAt)}
                  </span>
                  <Icon name="chevron-right" size={15} className="text-text-subtle" />
                </button>
              </li>
            ))}
            {running?.slice(0, 4).map((r) => (
              <li key={r.id}>
                <button
                  onClick={() => setNav('workflows')}
                  className="flex w-full items-center gap-3 px-6 py-3 text-left transition-colors hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
                >
                  <StatusChip state={r.state} />
                  <span className="min-w-0 flex-1 truncate text-[13px] text-text">{r.workflowName}</span>
                  <span className="hidden shrink-0 text-[11.5px] text-text-subtle sm:block">
                    {r.succeededCount}/{r.nodeCount} nodes · {relTime(r.createdAt)}
                  </span>
                  <Icon name="chevron-right" size={15} className="text-text-subtle" />
                </button>
              </li>
            ))}
            {activeAutomations.slice(0, 3).map((r) => (
              <AutomationActiveRow key={r.id} run={r} />
            ))}
          </ul>
        )}
      </Card>
      {/* Screen-reader summary of the three counters, for the collapsed case */}
      <p className="sr-only">
        {counts.approvals} approval{counts.approvals === 1 ? '' : 's'} waiting,{' '}
        {counts.workflows} workflow{counts.workflows === 1 ? '' : 's'} running,{' '}
        {counts.automations} automation{counts.automations === 1 ? '' : 's'} active.
        {fabricReachable === false ? ' Approval service unreachable.' : ''}
      </p>
    </PageBlock>
  );
}

function AutomationActiveRow({ run }: { run: AutomationRunSummary }) {
  const setNav = useAppStore((s) => s.setNav);
  // The summary carries only ruleId; the library's rules give it a name.
  const ruleName = useAutomation((s) =>
    s.rules.find((r) => r.id === run.ruleId)?.name);
  return (
    <li>
      <button
        onClick={() => setNav('workflows')}
        className="flex w-full items-center gap-3 px-6 py-3 text-left transition-colors hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
      >
        <StatusChip state={run.status} />
        <span className="min-w-0 flex-1 truncate text-[13px] text-text">{ruleName ?? 'Automation'}</span>
        <span className="hidden shrink-0 text-[11.5px] text-text-subtle sm:block">{relTime(run.startedAt)}</span>
        <Icon name="chevron-right" size={15} className="text-text-subtle" />
      </button>
    </li>
  );
}

/* ── AUTOMATIONS ───────────────────────────────────────────────────── */

export function AutomationsSection() {
  const setNav = useAppStore((s) => s.setNav);
  const rules = useAutomation((s) => s.rules);
  const schedules = useAutomation((s) => s.schedules);
  const loaded = useAutomation((s) => s.loaded);
  const reachable = useAutomation((s) => s.reachable);

  const rows = rules
    .map((r) => ({ rule: r, schedule: schedules[r.id] }))
    .sort((a, b) => {
      const am = b.schedule?.missedCount ?? 0;
      const bm = a.schedule?.missedCount ?? 0;
      if (am !== bm) return am - bm;
      return (b.schedule?.nextFireAt ?? '').localeCompare(a.schedule?.nextFireAt ?? '');
    })
    .slice(0, 4);

  return (
    <PageBlock className="col-span-12 xl:col-span-7">
      <Card padding="none" className="h-full overflow-hidden">
        <div className="flex items-center justify-between px-6 pt-5">
          <CardHeader title="Automations" subtitle="Schedules, next fires and missed runs" />
          <Button size="sm" variant="ghost" iconRight="chevron-right" onClick={() => setNav('workflows')}>
            Library
          </Button>
        </div>

        {!loaded ? (
          <div className="px-6 pb-6">
            <EmptyState icon="workflows" title="Loading automations…" description="Reading your rule library." compact />
          </div>
        ) : reachable === false ? (
          <div className="px-6 pb-6">
            <EmptyState
              icon="workflows"
              title="Automation service unreachable"
              description="Schedules come from the automation engine; without it nothing can be shown honestly."
              compact
            />
          </div>
        ) : rows.length === 0 ? (
          <div className="px-6 pb-6">
            <EmptyState
              icon="workflows"
              title="No automations yet"
              description="A rule turns a workflow into a schedule. Build one in the Automation library."
              action={<Button size="sm" variant="secondary" onClick={() => setNav('workflows')}>Open library</Button>}
              compact
            />
          </div>
        ) : (
          <ul className="mt-4 divide-y divide-line border-t border-line">
            {rows.map(({ rule, schedule }) => {
              const missed = schedule?.missedCount ?? 0;
              return (
                <li key={rule.id} className="flex items-center gap-3 px-6 py-3">
                  <Badge tone={rule.enabled ? 'info' : 'neutral'}>{rule.enabled ? 'Enabled' : 'Paused'}</Badge>
                  <span className="min-w-0 flex-1 truncate text-[13px] text-text">{rule.name}</span>
                  {missed > 0 && (
                    <StatusChip state="missed" label={`Missed ${missed}`} size="sm" />
                  )}
                  <span className="shrink-0 text-[11.5px] text-text-subtle">
                    {schedule?.error
                      ? 'schedule error'
                      : `next ${untilTime(schedule?.nextFireAt)}`}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </PageBlock>
  );
}

/* ── ACTIVITY ──────────────────────────────────────────────────────── */

/**
 * Recent VERIFIED runs: succeeded index entries that carry evidence.
 * "Succeeded" alone is execution's opinion; the evidence count is what
 * makes a row claimable as verified, so that is the filter used here.
 */
export function ActivitySection() {
  const setNav = useAppStore((s) => s.setNav);
  const [runs, setRuns] = useState<WorkflowRunSummary[] | null>(null);
  const [reachable, setReachable] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      void aiClient.runIndex({ state: 'succeeded', limit: 20 })
        .then((page) => {
          if (!alive) return;
          setRuns(page.runs.filter((r) => !r.supersededBy).slice(0, 5));
          setReachable(true);
        })
        .catch(() => alive && setReachable(false));
    };
    load();
    const t = window.setInterval(load, POLL_MS);
    return () => { alive = false; window.clearInterval(t); };
  }, []);

  return (
    <PageBlock className="col-span-12 xl:col-span-5">
      <Card padding="none" className="h-full overflow-hidden">
        <div className="flex items-center justify-between px-6 pt-5">
          <CardHeader title="Activity" subtitle="Recently verified runs" />
          <Button size="sm" variant="ghost" iconRight="chevron-right" onClick={() => setNav('workflows')}>
            All runs
          </Button>
        </div>

        {reachable === false ? (
          <div className="px-6 pb-6">
            <EmptyState
              icon="activity"
              title="Run history unavailable"
              description="The run index cannot be reached, so no history is shown rather than stale history."
              compact
            />
          </div>
        ) : runs === null ? (
          <div className="px-6 pb-6">
            <EmptyState icon="activity" title="Loading…" description="Reading the run index." compact />
          </div>
        ) : runs.filter((r) => r.evidenceCount > 0).length === 0 ? (
          <div className="px-6 pb-6">
            <EmptyState
              icon="shield"
              title="No verified runs yet"
              description="A completed run with recorded evidence appears here. Ask AURA to do something real."
              action={<Button size="sm" variant="secondary" onClick={() => document.getElementById('ask-aura-input')?.focus()}>Ask AURA</Button>}
              compact
            />
          </div>
        ) : (
          <ul className="mt-4 divide-y divide-line border-t border-line">
            {runs
              .filter((r) => r.evidenceCount > 0)
              .map((r) => (
                <motion.li
                  key={r.id}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={spring.snappy}
                  className="flex items-center gap-3 px-6 py-3"
                >
                  <StatusChip state={r.state} label="Verified" tone="positive" size="sm" />
                  <span className="min-w-0 flex-1 truncate text-[13px] text-text">{r.workflowName}</span>
                  <span
                    className="hidden shrink-0 items-center gap-2 text-[11.5px] text-text-subtle sm:flex"
                    title={`${r.evidenceCount} evidence record(s)`}
                  >
                    <Icon name="shield" size={13} />
                    {r.evidenceCount}
                  </span>
                  <span className="w-16 shrink-0 text-right text-[11.5px] text-text-subtle">
                    {relTime(r.finishedAt ?? r.createdAt)}
                  </span>
                </motion.li>
              ))}
          </ul>
        )}
      </Card>
    </PageBlock>
  );
}

/** Shared section heading rhythm for full-width blocks on Home. */
export function SectionGap({ children }: { children?: React.ReactNode }) {
  return <div className={cn('mb-5')}>{children}</div>;
}
