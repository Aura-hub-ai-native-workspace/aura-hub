/**
 * RuleDryRun — what this rule would do, without doing any of it.
 * ==================================================================
 * This renders the SERVICE's report (`POST /automation/rules/:id/dry-run`)
 * and adds nothing to it.
 *
 * It used to compose a preview here, because no rule-level dry run
 * existed: the trigger was read from the rule, each `run-workflow` step
 * was dry-run individually, and the conditions were marked UNKNOWN
 * because evaluating them in the renderer would have been a second
 * condition engine. That contract now exists, so all of that is gone —
 * including the composition, which was a frontend substitute for a
 * backend answer and is exactly the kind of thing that drifts.
 *
 * ── Certainty is the service's word, not a presentation choice ─────
 *   known        it was actually determined
 *   conditional  it depends on something a dry run cannot decide
 *   unknown      it could not be reasoned about at all
 *
 * `value` is null unless `known`, so nothing here is ever a guess. A
 * sample event is what moves the trigger and the conditions from
 * conditional to known: with a payload the service really evaluates them.
 *
 * Nothing is executed. The report carries the service's own proof of
 * that, and it is displayed as the service's claim rather than restated
 * as this screen's assurance.
 */

import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Icon } from '@aura/ui';
import type { StatusTone } from '@aura/core';
import { automationClient, type AutomationRule, type Certainty, type Determination, type PlannedRuleAction, type RuleDryRunReport, type SampleEvent } from '../../ai/automationClient';
import type { DryRunReport } from '../../ai/aiClient';
import { DryRunReportView } from '../workflows/DryRunReport';
import { ACTIONS, TRIGGERS } from './automationMeta';

/** The service's three certainties, in the product's own vocabulary. */
const CERTAINTY_LABEL: Record<Certainty, string> = {
  known: 'KNOWN',
  conditional: 'CONDITIONAL',
  unknown: 'UNKNOWN',
};

const CERTAINTY_TONE: Record<Certainty, StatusTone> = {
  known: 'positive',
  conditional: 'attention',
  unknown: 'neutral',
};

function Determined({ d, className = '' }: { d: Determination<boolean>; className?: string }) {
  return (
    <div className={className}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={CERTAINTY_TONE[d.certainty]}>{CERTAINTY_LABEL[d.certainty]}</Badge>
        {d.certainty === 'known' && (
          <span className={`text-[11.5px] font-medium ${d.value ? 'text-positive' : 'text-text-muted'}`}>
            {d.value ? 'yes' : 'no'}
          </span>
        )}
      </div>
      <p className="mt-1 text-[11.5px] leading-relaxed text-text-muted">{d.reason}</p>
      {d.dependsOn && (
        <p className="mt-0.5 text-[10.5px] text-text-subtle">Depends on {d.dependsOn}.</p>
      )}
    </div>
  );
}

function Step({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-line bg-canvas px-4 py-3">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-surface-active text-[10px] font-semibold tabular-nums text-text-subtle">
          {n}
        </span>
        <h3 className="text-[12.5px] font-semibold text-text">{title}</h3>
      </div>
      {children}
    </section>
  );
}

export interface RuleDryRunProps {
  rule: AutomationRule;
  projectId: string | null;
  projectName: string | null;
  /** Needed only to build a sample event the service will accept. */
  projectPath?: string | null;
  onClose: () => void;
}

export function RuleDryRun({ rule, projectId, projectName, projectPath, onClose }: RuleDryRunProps) {
  const [report, setReport] = useState<RuleDryRunReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openReport, setOpenReport] = useState<{ name: string; report: DryRunReport } | null>(null);

  /* The sample payload. Empty by default, because an invented payload
     would produce a confident answer about an event that never happens. */
  const [useSample, setUseSample] = useState(false);
  const [sampleText, setSampleText] = useState('{\n  \n}');
  const [sampleError, setSampleError] = useState<string | null>(null);

  const run = useCallback(async (sample?: SampleEvent) => {
    setBusy(true);
    setError(null);
    try {
      const res = await automationClient.dryRunRule(rule.id, {
        sampleEvent: sample,
        projectId: projectId ?? undefined,
      });
      if ('error' in res) { setError(String(res.error)); setReport(null); }
      else setReport(res);
    } catch (e) {
      setError((e as Error).message);
      setReport(null);
    } finally {
      setBusy(false);
    }
  }, [rule.id, projectId]);

  useEffect(() => { void run(); }, [run]);

  const runWithSample = () => {
    let payload: Record<string, unknown>;
    try {
      const parsed = JSON.parse(sampleText);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('The payload must be a JSON object.');
      payload = parsed as Record<string, unknown>;
    } catch (e) {
      setSampleError((e as Error).message);
      return;
    }
    setSampleError(null);
    void run({
      type: rule.trigger.type,
      projectId: projectId ?? '',
      projectPath: projectPath ?? '',
      at: new Date().toISOString(),
      payload,
    });
  };

  if (openReport) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center gap-2 border-b border-line px-4 py-2">
          <Button variant="ghost" size="sm" icon="projects" onClick={() => setOpenReport(null)}>Rule preview</Button>
          <span className="text-[13px] font-semibold text-text">{openReport.name}</span>
          <span className="text-[11.5px] text-text-subtle">what this workflow would do</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <DryRunReportView report={openReport.report} />
        </div>
      </div>
    );
  }

  const trigger = TRIGGERS[rule.trigger.type];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2.5">
        <Button variant="ghost" size="sm" icon="projects" onClick={onClose}>Back to the rule</Button>
        <span className="text-[13.5px] font-semibold text-text">{rule.name}</span>
        <Button size="sm" variant="ghost" icon="refresh" className="ml-auto" loading={busy} onClick={() => void run()}>
          Re-check
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-3 px-6 py-5">
          {/* ── the service's inertness claim, as its claim ────────── */}
          <section className="rounded-xl border border-accent/35 bg-accent-50 px-4 py-3 dark:bg-accent/10">
            <div className="flex items-center gap-2">
              <Icon name="eye" size={14} className="text-accent" />
              <h2 className="text-[13px] font-semibold text-text">THIS IS A PREVIEW. NOTHING WAS EXECUTED.</h2>
            </div>
            {report ? (
              <>
                <p className="mt-1 text-[11.5px] leading-relaxed text-text-muted">{report.sideEffects.note}</p>
                <ul className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[10.5px] tabular-nums text-text-subtle">
                  <li>automation runs created: {report.sideEffects.automationRunsCreated}</li>
                  <li>workflow runs created: {report.sideEffects.workflowRunsCreated}</li>
                  <li>capabilities invoked: {report.sideEffects.invocations}</li>
                  <li>approvals opened: {report.sideEffects.approvalsCreated}</li>
                  <li>files written: {report.sideEffects.filesWritten}</li>
                </ul>
                <p className="mt-1 text-[10.5px] text-text-subtle">
                  These are the service's own counts for this preview, not this screen's assurance.
                </p>
              </>
            ) : (
              <p className="mt-1 text-[11.5px] text-text-muted">Asking the service what this rule would do…</p>
            )}
          </section>

          {error && (
            <section className="rounded-xl border border-danger/35 bg-danger/[0.06] px-4 py-3">
              <div className="flex items-center gap-2">
                <Icon name="bug" size={13} className="text-danger" />
                <h3 className="text-[12.5px] font-semibold text-text">The service could not preview this rule</h3>
              </div>
              <p className="mt-1 break-words text-[11.5px] leading-relaxed text-text-muted">{error}</p>
            </section>
          )}

          {report && (
            <>
              {/* ── structural problems come first ─────────────────── */}
              {report.issues.length > 0 && (
                <section className="rounded-xl border border-danger/35 bg-danger/[0.06] px-4 py-3">
                  <div className="flex items-center gap-2">
                    <Icon name="bug" size={13} className="text-danger" />
                    <h3 className="text-[12.5px] font-semibold text-text">
                      {report.issues.length} problem{report.issues.length === 1 ? '' : 's'} with the rule itself
                    </h3>
                  </div>
                  <ul className="mt-1 space-y-0.5">
                    {report.issues.map((i, n) => (
                      <li key={n} className="text-[11.5px] text-text-muted">
                        <code className="rounded bg-surface-active px-1">{i.field}</code> — {i.message}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {!report.enabled && (
                <section className="rounded-xl border border-attention/35 bg-attention/[0.06] px-4 py-3">
                  <div className="flex items-center gap-2">
                    <Icon name="bell" size={13} className="text-attention" />
                    <span className="text-[12.5px] font-medium text-text">This rule is disabled</span>
                  </div>
                  <p className="mt-0.5 text-[11.5px] text-text-muted">
                    No event reaches it while it stays that way, so the preview below describes what it would do if
                    enabled.
                  </p>
                </section>
              )}

              {/* ── 1. trigger ─────────────────────────────────────── */}
              <Step n={1} title={`Trigger — ${trigger?.label ?? report.trigger.type}`}>
                <Determined d={report.trigger.accepted} />
                {report.trigger.schedule && (
                  <div className="mt-2 rounded-lg bg-surface-active px-2.5 py-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <code className="text-[10.5px] text-text">{report.trigger.schedule.cron}</code>
                      <span className="text-[10.5px] text-text-muted">{report.trigger.schedule.description}</span>
                    </div>
                    <p className="mt-0.5 text-[10.5px] text-text-subtle">
                      {report.trigger.schedule.nextFireAt
                        ? `Next fire ${new Date(report.trigger.schedule.nextFireAt).toLocaleString()}`
                        : 'No next fire time computed.'}
                      {' · '}
                      {/* The scheduler works in the machine's local time and
                          offers no zone of its own, so neither does this. */}
                      machine local time
                    </p>
                  </div>
                )}
              </Step>

              {/* ── 2. sample event ────────────────────────────────── */}
              <Step n={2} title="Sample event">
                <p className="text-[11.5px] leading-relaxed text-text-muted">
                  Without one, the service cannot say whether the trigger fires or the conditions pass — only what they
                  depend on. Supply a payload and it evaluates them for real.
                </p>
                {!useSample ? (
                  <Button size="sm" variant="secondary" icon="note" className="mt-2" onClick={() => setUseSample(true)}>
                    Reason about a specific event
                  </Button>
                ) : (
                  <div className="mt-2 space-y-1.5">
                    <label className="block">
                      <span className="text-[10.5px] uppercase tracking-[0.09em] text-text-subtle">
                        Payload for a “{report.trigger.type}” event (JSON)
                      </span>
                      <textarea
                        value={sampleText}
                        onChange={(e) => setSampleText(e.target.value)}
                        rows={5}
                        spellCheck={false}
                        aria-label="Sample event payload as JSON"
                        className="mt-1 w-full rounded-lg border border-line bg-surface px-2 py-1.5 font-mono text-[11px] text-text outline-none focus:border-accent"
                      />
                    </label>
                    {sampleError && <p className="text-[11px] text-danger">{sampleError}</p>}
                    <div className="flex items-center gap-1.5">
                      <Button size="sm" variant="secondary" icon="eye" loading={busy} onClick={runWithSample}>
                        Preview against this event
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => { setUseSample(false); setSampleError(null); void run(); }}>
                        Clear
                      </Button>
                    </div>
                  </div>
                )}
              </Step>

              {/* ── 3. conditions ─────────────────────────────────── */}
              <Step n={3} title={`Conditions — ${rule.conditions.length || 'none'}`}>
                <Determined d={report.conditions.outcome} />
                {report.conditions.evaluations.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {report.conditions.evaluations.map((ev) => (
                      <li key={ev.index} className="flex items-start gap-2 rounded-lg bg-surface-active px-2.5 py-1.5">
                        <Icon
                          name={ev.passed ? 'check' : 'close'}
                          size={11}
                          className={`mt-0.5 shrink-0 ${ev.passed ? 'text-positive' : 'text-danger'}`}
                        />
                        <span className="min-w-0">
                          <code className="text-[10.5px] text-text">{ev.field}</code>{' '}
                          <span className="text-[10.5px] text-text-subtle">{ev.op}</span>
                          {ev.note && <span className="ml-1 text-[10.5px] text-text-muted">— {ev.note}</span>}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Step>

              {/* ── 4/5. actions, each with its nested workflow plan ─ */}
              <Step n={4} title={`Actions — ${report.actions.length}`}>
                {report.actions.length === 0 ? (
                  <p className="text-[11.5px] text-text-muted">This rule has no actions, so it would do nothing.</p>
                ) : (
                  <ol className="space-y-2">
                    {report.actions.map((a) => (
                      <ActionRow key={a.actionId} action={a} onOpenReport={setOpenReport} />
                    ))}
                  </ol>
                )}
              </Step>

              {/* ── 6. capability and policy ──────────────────────── */}
              <Step n={5} title="Capability and policy">
                {report.capabilitiesRequested.length === 0 ? (
                  <p className="text-[11.5px] text-text-muted">
                    Nothing this rule would do reaches the Capability Fabric.
                  </p>
                ) : (
                  <>
                    <p className="text-[11.5px] text-text-muted">
                      {report.capabilitiesRequested.length} capabilit
                      {report.capabilitiesRequested.length === 1 ? 'y' : 'ies'} would be requested.
                    </p>
                    <ul className="mt-1.5 flex flex-wrap gap-1">
                      {report.capabilitiesRequested.map((c) => (
                        <li key={c}>
                          <code className="rounded bg-surface-active px-1.5 py-0.5 text-[10.5px] text-text">{c}</code>
                        </li>
                      ))}
                    </ul>
                  </>
                )}

                {report.approvalsRequired.length > 0 && (
                  <div className="mt-2.5 rounded-lg border border-attention/30 bg-attention/[0.06] px-3 py-2">
                    <div className="flex items-center gap-2">
                      <Icon name="shield" size={12} className="text-attention" />
                      <span className="text-[11.5px] font-medium text-text">
                        {report.approvalsRequired.length} would stop and ask you
                      </span>
                    </div>
                    <ul className="mt-1 space-y-0.5">
                      {report.approvalsRequired.map((a, n) => (
                        <li key={n} className="text-[10.5px] text-text-muted">
                          <code className="rounded bg-surface-active px-1">{a.capabilityId}</code> — {a.reason}{' '}
                          <span className="text-text-subtle">({a.rule})</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {report.denials.length > 0 && (
                  <div className="mt-2.5 rounded-lg border border-danger/30 bg-danger/[0.06] px-3 py-2">
                    <div className="flex items-center gap-2">
                      <Icon name="shield" size={12} className="text-danger" />
                      <span className="text-[11.5px] font-medium text-text">
                        {report.denials.length} would be refused outright
                      </span>
                    </div>
                    <ul className="mt-1 space-y-0.5">
                      {report.denials.map((d, n) => (
                        <li key={n} className="text-[10.5px] text-text-muted">
                          <code className="rounded bg-surface-active px-1">{d.capabilityId}</code> — {d.reason}{' '}
                          <span className="text-text-subtle">({d.rule})</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </Step>

              {/* ── 7. expected outcome ───────────────────────────── */}
              <Step n={6} title="Expected outcome">
                <div className="mb-2">
                  <span className="text-[10.5px] uppercase tracking-[0.09em] text-text-subtle">
                    Would it run unattended?
                  </span>
                  <Determined d={report.wouldRunUnattended} className="mt-1" />
                </div>

                {report.unknowns.length > 0 && (
                  <div className="rounded-lg border border-line bg-surface px-3 py-2">
                    <div className="flex items-center gap-2">
                      <Icon name="eye" size={12} className="text-text-subtle" />
                      <span className="text-[11.5px] font-medium text-text">
                        What this preview cannot know
                      </span>
                    </div>
                    <ul className="mt-1 space-y-0.5">
                      {report.unknowns.map((u, n) => (
                        <li key={n} className="text-[10.5px] leading-relaxed text-text-muted">
                          <span className="text-text">{u.what}</span> — {u.why}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </Step>

              <p className="flex items-start gap-1.5 text-[10.5px] leading-relaxed text-text-subtle">
                <Icon name="shield" size={11} className="mt-0.5 shrink-0" />
                Planned by the service against{' '}
                {projectName ? <span className="text-text-muted">{projectName}</span> : 'no open project'} at{' '}
                {new Date(report.at).toLocaleString()}. Conditions and policy were evaluated by the engine that would
                run them, not by this screen.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ActionRow({
  action,
  onOpenReport,
}: {
  action: PlannedRuleAction;
  onOpenReport: (r: { name: string; report: DryRunReport }) => void;
}) {
  const meta = ACTIONS[action.action as keyof typeof ACTIONS];
  return (
    <li className="rounded-lg border border-line bg-surface px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={CERTAINTY_TONE[action.reached.certainty]}>{CERTAINTY_LABEL[action.reached.certainty]}</Badge>
        <span className="text-[12px] font-medium text-text">{action.label || meta?.label || action.action}</span>
        {action.continueOnError && (
          <span className="text-[10px] text-text-subtle" title="A failure here does not stop the chain">
            continues on error
          </span>
        )}
      </div>
      <p className="mt-0.5 text-[11px] leading-relaxed text-text-muted">{action.reached.reason}</p>
      {action.reached.dependsOn && (
        <p className="mt-0.5 text-[10.5px] text-text-subtle">Depends on {action.reached.dependsOn}.</p>
      )}

      {action.capabilities.length > 0 && (
        <ul className="mt-1.5 space-y-0.5">
          {action.capabilities.map((c, n) => (
            <li key={n} className="flex flex-wrap items-center gap-1.5 text-[10.5px]">
              <code className="rounded bg-surface-active px-1 text-text">{c.capabilityId}</code>
              <span
                className={
                  c.wouldBeDenied ? 'text-danger' : c.wouldAskHuman ? 'text-attention' : 'text-text-subtle'
                }
              >
                {c.decision}
              </span>
              <span className="text-text-subtle">· {c.risk} risk · {c.rule}</span>
            </li>
          ))}
        </ul>
      )}

      {/* The nested workflow's own dry run — the real report, opened in the
          same viewer the Workflow surface uses. Not re-implemented here. */}
      {action.workflow && (
        <div className="mt-1.5">
          {action.workflow.dryRun ? (
            <button
              onClick={() => onOpenReport({ name: action.workflow!.workflowName, report: action.workflow!.dryRun! })}
              className="flex items-center gap-1.5 rounded-lg bg-surface-active px-2 py-1 text-[10.5px] text-text-muted transition-colors hover:text-text"
            >
              <Icon name="workflows" size={11} />
              {action.workflow.workflowName} — {action.workflow.dryRun.plan.length} planned step
              {action.workflow.dryRun.plan.length === 1 ? '' : 's'}
              <span className="text-text-subtle">open plan</span>
            </button>
          ) : (
            <p className="text-[10.5px] text-attention">
              {action.workflow.error ?? 'This workflow could not be planned.'}
            </p>
          )}
        </div>
      )}
    </li>
  );
}
