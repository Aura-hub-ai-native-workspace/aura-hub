/**
 * AutomationLibrary — the rules, and what each one is doing.
 * ==================================================================
 * A rule answers four questions, and the card answers all four without
 * being opened: what fires it, what it then runs, whether it is switched
 * on, and whether it last worked.
 *
 * On "next run": only a `schedule` rule has one, and the service's
 * scheduler computes it — the card reads `nextFireAt` rather than parsing
 * cron. An event-triggered rule genuinely has no next time, and the card
 * says what it waits for instead of inventing a clock.
 */

import { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { Badge, Button, Icon, IconButton, Input, Menu, useToast } from '@aura/ui';
import type { AutomationRule, AutomationRuleSummary, ScheduleState } from '../../ai/automationClient';
import { activeRunOf, lastRunOf, pausedRunOf, useAutomation } from '../../data/useAutomation';
import { useWorkflows } from '../../data/useWorkflows';
import { useWorkspace } from '../../data/useWorkspace';
import { EmptyState } from '../../components/EmptyState';
import { relTime } from '../workflows/runs';
import { RUN_STATUS_LABEL, RUN_STATUS_TONE, TRIGGERS, fmtNextFire } from './automationMeta';
import { RunNowDialog } from './RunNowDialog';

export interface AutomationLibraryProps {
  onOpenRule: (id: string) => void;
  onNewRule: () => void;
  onOpenRuns: (ruleId: string) => void;
}

export function AutomationLibrary({ onOpenRule, onNewRule, onOpenRuns }: AutomationLibraryProps) {
  const auto = useAutomation();
  const toast = useToast();
  const workflows = useWorkflows((s) => s.list);
  const openProjectId = useWorkspace((s) => s.openId);
  const openProjectName = useWorkspace((s) => s.projects.find((p) => p.id === s.openId)?.name ?? null);

  const [q, setQ] = useState('');
  const [runTarget, setRunTarget] = useState<string | null>(null);

  useEffect(() => auto.watch(), [auto.watch]);

  const workflowName = useMemo(() => {
    const byId = new Map(workflows.map((w) => [w.id, w.name]));
    return (id: string) => byId.get(id) ?? null;
  }, [workflows]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return auto.rules
      .filter((r) => (needle ? `${r.name} ${r.description} ${r.category} ${r.trigger}`.toLowerCase().includes(needle) : true))
      .sort((a, b) => Number(b.enabled) - Number(a.enabled) || b.updatedAt.localeCompare(a.updatedAt));
  }, [auto.rules, q]);

  const askToRun = (r: AutomationRuleSummary) => {
    if (!openProjectId) {
      toast.push({
        title: 'Open a project first',
        description: 'A rule runs against a real project, so one has to be open.',
        tone: 'attention',
      });
      return;
    }
    void auto.loadRule(r.id);
    setRunTarget(r.id);
  };

  const runNow = async (payload: Record<string, unknown>) => {
    const id = runTarget;
    if (!id || !openProjectId) return;
    setRunTarget(null);
    const res = await auto.runNow(id, openProjectId, payload);
    toast.push({
      title: res.ok ? 'Rule ran' : 'Nothing ran',
      description: res.message,
      tone: res.ok ? 'positive' : 'attention',
    });
    // A rule that did not pass its conditions still deserves its history —
    // the run list is where you go to see why nothing happened.
    onOpenRuns(id);
  };

  if (auto.reachable === false) {
    return (
      <div className="px-6 py-10">
        <EmptyState
          icon="workflows"
          title="The Automation Engine is not answering"
          description="Start the local service (npm run ai) to read and edit automation rules."
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-6 py-6">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-[17px] font-semibold tracking-[-0.01em] text-text">Rules</h2>
          <p className="mt-1 max-w-xl text-[12.5px] leading-relaxed text-text-muted">
            A rule watches for something real to happen in your project, checks its conditions, then runs a chain of
            actions — including handing a workflow to the Workflow Engine, which governs it exactly as the Run button does.
          </p>
        </div>
        <Button icon="plus" onClick={onNewRule}>New rule</Button>
      </header>

      <div className="mb-5 flex flex-wrap items-center gap-2">
        <Input
          icon="search"
          placeholder="Search rules…"
          aria-label="Search rules"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="w-72"
        />
        <span className="text-[11.5px] text-text-subtle">
          {auto.rules.filter((r) => r.enabled).length} of {auto.rules.length} enabled
        </span>
      </div>

      {auto.loaded && auto.rules.length === 0 && (
        <div className="mb-8">
          <EmptyState
            icon="workflows"
            title="No automation rules yet"
            description="Start from a template below, or build one from a trigger."
          />
        </div>
      )}

      {filtered.length > 0 && (
        <div className="mb-10 grid grid-cols-1 gap-4 lg:grid-cols-2">
          {filtered.map((r, i) => (
            <motion.div key={r.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i * 0.03, 0.2) }}>
              <RuleCard
                summary={r}
                def={auto.defs[r.id]}
                runs={auto.runs[r.id]}
                /* The service folds the scheduler's state into the summary;
                   the separate schedules map stays as a fallback. */
                schedule={r.schedule ?? auto.schedules[r.id]}
                busy={auto.busy === r.id}
                workflowName={workflowName}
                onOpen={() => onOpenRule(r.id)}
                onOpenRuns={() => onOpenRuns(r.id)}
                onToggle={(enabled) => void auto.setEnabled(r.id, enabled)}
                onRunNow={() => askToRun(r)}
                onPause={async () => {
                  const err = await auto.pause(r.id);
                  if (err) toast.push({ title: 'Could not pause', description: err, tone: 'attention' });
                }}
                onResume={async () => {
                  const err = await auto.resume(r.id);
                  if (err) toast.push({ title: 'Could not resume', description: err, tone: 'attention' });
                }}
                onDelete={() => void auto.remove(r.id)}
              />
            </motion.div>
          ))}
        </div>
      )}

      <RunNowDialog
        rule={runTarget ? auto.defs[runTarget] ?? null : null}
        open={Boolean(runTarget)}
        projectName={openProjectName}

        busy={auto.busy === runTarget}
        onClose={() => setRunTarget(null)}
        onRun={(payload) => void runNow(payload)}
      />

      {auto.templates.length > 0 && (
        <>
          <div className="mb-3 flex items-center gap-2">
            <Icon name="spark" size={14} className="text-accent" />
            <h3 className="text-[13px] font-semibold uppercase tracking-[0.12em] text-text-muted">Starter rules</h3>
            <span className="text-[11.5px] text-text-subtle">— real triggers, real actions</span>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {auto.templates.map((t) => (
              <button
                key={t.id}
                onClick={async () => {
                  const rule = await auto.create({ template: t.id });
                  if (rule) onOpenRule(rule.id);
                }}
                className="rounded-2xl border border-line bg-surface p-4 text-left transition-all hover:border-accent/40 hover:shadow-md"
              >
                <div className="mb-2 flex h-8 w-8 items-center justify-center rounded-lg bg-surface-active text-text-muted">
                  <Icon name="workflows" size={15} />
                </div>
                <div className="text-[12.5px] font-semibold text-text">{t.name}</div>
                <div className="mt-1 line-clamp-3 text-[11px] leading-relaxed text-text-subtle">{t.description}</div>
                <div className="mt-2 text-[10.5px] text-text-subtle">{t.category}</div>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/* ── one rule ──────────────────────────────────────────────────────── */

function RuleCard({
  summary,
  def,
  runs,
  schedule,
  busy,
  workflowName,
  onOpen,
  onOpenRuns,
  onToggle,
  onRunNow,
  onPause,
  onResume,
  onDelete,
}: {
  summary: AutomationRuleSummary;
  def?: AutomationRule;
  runs?: ReturnType<typeof lastRunOf>[];
  schedule?: ScheduleState & { description?: string; timezone?: 'local' };
  busy: boolean;
  workflowName: (id: string) => string | null;
  onOpen: () => void;
  onOpenRuns: () => void;
  onToggle: (enabled: boolean) => void;
  onRunNow: () => void;
  onPause: () => void;
  onResume: () => void;
  onDelete: () => void;
}) {
  const list = (runs ?? []).filter(Boolean) as NonNullable<ReturnType<typeof lastRunOf>>[];
  const last = lastRunOf(list);
  const active = activeRunOf(list);
  const paused = pausedRunOf(list);
  const trigger = TRIGGERS[summary.trigger];

  // Which workflows this rule hands over, read from its own chain.
  const workflowSteps = (def?.chain ?? []).filter((a) => a.action === 'run-workflow');
  const workflowLabels = workflowSteps.map((a) => {
    const id = String(a.config.workflowId ?? '');
    return workflowName(id) ?? `${id || 'no workflow chosen'}`;
  });

  return (
    <div
      data-rule={summary.id}
      className="group relative rounded-2xl border border-line bg-surface p-4 shadow-sm transition-shadow hover:shadow-md"
    >
      <div className="flex items-start gap-3">
        <span
          className={`mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl ${
            summary.enabled ? 'bg-accent/10 text-accent' : 'bg-surface-active text-text-subtle'
          }`}
        >
          <Icon name={trigger?.icon ?? 'workflows'} size={17} />
        </span>

        <div className="min-w-0 flex-1">
          <button onClick={onOpen} className="block w-full text-left">
            <h3 className="truncate text-[13.5px] font-semibold text-text">{summary.name}</h3>
            {summary.description && (
              <p className="mt-1 line-clamp-2 text-[12px] leading-relaxed text-text-muted">{summary.description}</p>
            )}
          </button>

          {/* what fires it, and what it then does */}
          <dl className="mt-2.5 space-y-1 text-[11.5px]">
            <div className="flex gap-2">
              <dt className="w-14 shrink-0 text-text-subtle">When</dt>
              <dd className="min-w-0 text-text-muted">
                {summary.trigger === 'schedule' && (summary.cron ?? def?.trigger.cron)
                  ? (
                    <span className="flex flex-wrap items-center gap-1.5">
                      <code className="rounded bg-surface-active px-1.5 py-0.5 text-[10.5px] text-text">{summary.cron ?? def?.trigger.cron}</code>
                      {schedule?.description && <span className="text-text-subtle">{schedule.description}</span>}
                    </span>
                  )
                  : (trigger?.when ?? summary.trigger)}
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-14 shrink-0 text-text-subtle">Runs</dt>
              <dd className="min-w-0 text-text-muted">
                {workflowLabels.length ? (
                  <span className="flex flex-wrap items-center gap-1.5">
                    <Icon name="workflows" size={11} className="text-text-subtle" />
                    {workflowLabels.join(', ')}
                    {def && def.chain.length > workflowSteps.length && (
                      <span className="text-text-subtle">+{def.chain.length - workflowSteps.length} more</span>
                    )}
                  </span>
                ) : def ? (
                  `${summary.actionCount} action${summary.actionCount === 1 ? '' : 's'}`
                ) : (
                  <span className="text-text-subtle">reading…</span>
                )}
              </dd>
            </div>
            {summary.conditionCount > 0 && (
              <div className="flex gap-2">
                <dt className="w-14 shrink-0 text-text-subtle">If</dt>
                <dd className="text-text-muted">{summary.conditionCount} condition{summary.conditionCount === 1 ? '' : 's'} pass</dd>
              </div>
            )}
          </dl>

          {/* state */}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Badge tone={summary.enabled ? 'positive' : 'neutral'} dot>
              {summary.enabled ? 'enabled' : 'disabled'}
            </Badge>
            {active && <Badge tone="info">{RUN_STATUS_LABEL[active.status].toLowerCase()}</Badge>}
            {paused && <Badge tone="attention">paused</Badge>}
            {last && !active && !paused && (
              <button onClick={onOpenRuns} className="flex items-center gap-1.5">
                <Badge tone={RUN_STATUS_TONE[last.status]}>{RUN_STATUS_LABEL[last.status]}</Badge>
                <span className="text-[11px] text-text-subtle">{relTime(last.startedAt)}</span>
              </button>
            )}
            {!last && <span className="text-[11px] text-text-subtle">never run</span>}
            {summary.trigger === 'schedule' ? (
              <span className="ml-auto flex items-center gap-1.5">
                {schedule?.error ? (
                  <span className="text-[10.5px] text-danger" title={schedule.error}>schedule not valid</span>
                ) : (
                  <span className="text-[10.5px] text-text-subtle" title={schedule?.nextFireAt ? new Date(schedule.nextFireAt).toLocaleString() : undefined}>
                    {summary.enabled ? `next ${fmtNextFire(schedule?.nextFireAt)}` : 'paused — no next fire'}
                  </span>
                )}
                {(schedule?.missedCount ?? 0) > 0 && (
                  <Badge tone="attention">
                    {schedule!.missedCount} missed while closed
                  </Badge>
                )}
              </span>
            ) : (
              <span className="ml-auto text-[10.5px] text-text-subtle" title="This trigger is an event — it happens when it happens.">
                no scheduled time
              </span>
            )}
          </div>
        </div>
      </div>

      {/* controls */}
      <div className="mt-3 flex items-center gap-1.5 border-t border-line pt-3">
        <button
          onClick={() => onToggle(!summary.enabled)}
          disabled={busy}
          aria-label={summary.enabled ? 'Disable this rule' : 'Enable this rule'}
          className={`flex h-5 w-9 items-center rounded-full p-0.5 transition-colors disabled:opacity-50 ${
            summary.enabled ? 'bg-accent' : 'bg-surface-active'
          }`}
        >
          <span className={`h-4 w-4 rounded-full bg-white shadow transition-transform ${summary.enabled ? 'translate-x-4' : ''}`} />
        </button>
        <span className="text-[11.5px] text-text-muted">{summary.enabled ? 'Listening' : 'Off'}</span>

        <div className="ml-auto flex items-center gap-1.5">
          {active && <Button size="sm" variant="ghost" icon="dot" onClick={onPause}>Pause</Button>}
          {paused && <Button size="sm" variant="secondary" icon="activity" onClick={onResume}>Resume</Button>}
          <Button size="sm" variant="ghost" icon="spark" onClick={onRunNow} disabled={busy}>Run now</Button>
          <Button size="sm" variant="ghost" icon="activity" onClick={onOpenRuns}>
            Runs{list.length ? ` (${list.length})` : ''}
          </Button>
          <Menu
            align="end"
            trigger={<IconButton icon="more" label="Rule actions" size="sm" />}
            items={[
              { id: 'edit', label: 'Edit rule', icon: 'note', onSelect: onOpen },
              'separator',
              { id: 'delete', label: 'Delete', icon: 'close', tone: 'danger', onSelect: onDelete },
            ]}
          />
        </div>
      </div>
    </div>
  );
}
