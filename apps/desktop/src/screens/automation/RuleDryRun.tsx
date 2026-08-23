/**
 * RuleDryRun — what this rule would do, without doing any of it.
 * ==================================================================
 * ── How much of this is real ──────────────────────────────────────
 * The service has **no rule-level dry-run endpoint** yet (see
 * docs/BACKEND_CONTRACTS_REQUIRED.md §15). So this composes a preview
 * from contracts that do exist, and marks everything else UNKNOWN with
 * the reason:
 *
 *   Trigger      KNOWN      — read from the rule.
 *   Conditions   UNKNOWN    — evaluated by the engine against a real
 *                             event payload. Evaluating them here would
 *                             be a second engine, so this says so instead.
 *   Workflow     KNOWN      — `POST /workflows/:id/dry-run`, the real
 *                             contract, per `run-workflow` step.
 *   Capabilities KNOWN      — from that dry run's plan.
 *   Policy       KNOWN      — the Fabric's own pre-flight decisions.
 *   Approvals    KNOWN      — the questions a real run would raise.
 *   Other steps  UNKNOWN    — no dry-run contract for diagnosis, audits,
 *                             knowledge or memory actions.
 *
 * Nothing here is invented, and nothing is executed: the only network
 * calls are workflow dry runs, whose own reports carry the service's
 * proof of inertness.
 */

import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Icon } from '@aura/ui';
import type { StatusTone } from '@aura/core';
import { aiClient, type DryRunReport } from '../../ai/aiClient';
import type { AutomationRule, RuleAction } from '../../ai/automationClient';
import { DryRunReportView } from '../workflows/DryRunReport';
import { ACTIONS, CONDITION_OPS, TRIGGERS } from './automationMeta';

/** One step of the preview, with how much is actually known about it. */
type Certainty = 'KNOWN' | 'CONDITIONAL' | 'UNKNOWN';

const CERTAINTY_TONE: Record<Certainty, StatusTone> = {
  KNOWN: 'positive',
  CONDITIONAL: 'attention',
  UNKNOWN: 'neutral',
};

interface StepPreview {
  action: RuleAction;
  certainty: Certainty;
  /** Present for a `run-workflow` step whose dry run succeeded. */
  report?: DryRunReport;
  /** Why this step could not be previewed. */
  reason?: string;
}

export interface RuleDryRunProps {
  rule: AutomationRule;
  /** Project the preview is planned against. */
  projectId: string | null;
  projectName: string | null;
  onClose: () => void;
}

export function RuleDryRun({ rule, projectId, projectName, onClose }: RuleDryRunProps) {
  const [steps, setSteps] = useState<StepPreview[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [openReport, setOpenReport] = useState<DryRunReport | null>(null);

  const plan = useCallback(async () => {
    setBusy(true);
    try {
      const out: StepPreview[] = [];
      for (const a of rule.chain) {
        if (a.action !== 'run-workflow') {
          out.push({
            action: a,
            certainty: 'UNKNOWN',
            reason: `The service has no dry run for “${ACTIONS[a.action]?.label ?? a.action}”, so what it would do cannot be shown without doing it.`,
          });
          continue;
        }
        const workflowId = String(a.config.workflowId ?? '');
        if (!workflowId) {
          out.push({ action: a, certainty: 'UNKNOWN', reason: 'No workflow is chosen for this step.' });
          continue;
        }
        const res = await aiClient
          .dryRunWorkflow(workflowId, { projectId: projectId ?? undefined })
          .catch((e) => ({ error: (e as Error).message }));
        if ('error' in res) {
          out.push({ action: a, certainty: 'UNKNOWN', reason: res.error });
        } else {
          // The workflow's own plan is known; whether this step is reached
          // still depends on the conditions, which are not.
          out.push({ action: a, certainty: rule.conditions.length ? 'CONDITIONAL' : 'KNOWN', report: res });
        }
      }
      setSteps(out);
    } finally {
      setBusy(false);
    }
  }, [rule, projectId]);

  useEffect(() => { void plan(); }, [plan]);

  if (openReport) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center gap-2 border-b border-line px-4 py-2">
          <Button variant="ghost" size="sm" icon="projects" onClick={() => setOpenReport(null)}>Rule preview</Button>
          <span className="text-[13px] font-semibold text-text">{openReport.workflowName}</span>
          <span className="text-[11.5px] text-text-subtle">what this workflow would do</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <DryRunReportView report={openReport} />
        </div>
      </div>
    );
  }

  const previewed = (steps ?? []).filter((s) => s.report);
  const anyDenied = previewed.some((s) => s.report!.denials.length > 0);
  const anyApproval = previewed.some((s) => s.report!.approvalsRequired.length > 0);
  const anyUnknown = (steps ?? []).some((s) => s.certainty === 'UNKNOWN');
  const trigger = TRIGGERS[rule.trigger.type];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2.5">
        <Button variant="ghost" size="sm" icon="projects" onClick={onClose}>Back to the rule</Button>
        <span className="text-[13.5px] font-semibold text-text">{rule.name}</span>
        <Button size="sm" variant="ghost" icon="refresh" className="ml-auto" loading={busy} onClick={() => void plan()}>
          Re-check
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-3 px-6 py-5">
          {/* ── this is a preview ─────────────────────────────────── */}
          <section className="rounded-xl border border-accent/35 bg-accent-50 px-4 py-3 dark:bg-accent/10">
            <div className="flex items-center gap-2">
              <Icon name="eye" size={14} className="text-accent" />
              <h2 className="text-[13px] font-semibold text-text">THIS IS A PREVIEW. NO ACTIONS WERE EXECUTED.</h2>
            </div>
            <ul className="mt-1.5 space-y-0.5 text-[11.5px] leading-relaxed text-text-muted">
              <li>• No automation run was created.</li>
              <li>• No workflow run was created.</li>
              {previewed.length > 0 && (
                <li>
                  • For each workflow below, the service reports:{' '}
                  <span className="text-text">{previewed[0].report!.sideEffects.note}</span>
                </li>
              )}
            </ul>
            {projectName && (
              <p className="mt-1.5 text-[10.5px] text-text-subtle">Planned against {projectName}.</p>
            )}
          </section>

          {/* ── the chain, beat by beat ───────────────────────────── */}
          <Beat n={1} label="Trigger" certainty="KNOWN">
            <p className="text-[12px] text-text">
              {rule.trigger.type === 'schedule' && rule.trigger.cron ? (
                <>
                  Fires on the schedule <code className="rounded bg-surface-active px-1.5 py-0.5 text-[11px]">{rule.trigger.cron}</code>
                </>
              ) : (
                <>Fires when {trigger?.when ?? rule.trigger.type}.</>
              )}
            </p>
            {!rule.enabled && (
              <p className="mt-1 text-[11.5px] text-attention">
                This rule is disabled, so the engine would skip it entirely.
              </p>
            )}
          </Beat>

          <Beat
            n={2}
            label="Conditions"
            certainty={rule.conditions.length ? 'UNKNOWN' : 'KNOWN'}
          >
            {rule.conditions.length === 0 ? (
              <p className="text-[12px] text-text">No conditions — every matching event is acted on.</p>
            ) : (
              <>
                <ul className="space-y-1">
                  {rule.conditions.map((c, i) => (
                    <li key={i} className="flex flex-wrap items-center gap-1.5 text-[11.5px]">
                      <code className="rounded bg-surface-active px-1.5 py-0.5 text-[10.5px] text-text">{c.field}</code>
                      <span className="text-text-muted">{CONDITION_OPS[c.op]?.label ?? c.op}</span>
                      {CONDITION_OPS[c.op]?.needsValue && <span className="text-text">{String(c.value ?? '')}</span>}
                    </li>
                  ))}
                </ul>
                <p className="mt-1.5 text-[11px] leading-relaxed text-text-subtle">
                  Whether these pass depends on the event's payload, which only exists when the trigger really fires.
                  The engine evaluates them — this preview will not guess, and evaluating them here would be a second
                  engine. Everything after this point is therefore conditional on them passing.
                </p>
              </>
            )}
          </Beat>

          {/* ── steps ─────────────────────────────────────────────── */}
          {steps === null ? (
            <div className="h-32 animate-pulse rounded-xl border border-line bg-surface-active/40" aria-label="Planning this rule" />
          ) : steps.length === 0 ? (
            <Beat n={3} label="Actions" certainty="KNOWN">
              <p className="text-[12px] text-text">This rule has no actions, so nothing would happen.</p>
            </Beat>
          ) : (
            steps.map((s, i) => (
              <Beat key={s.action.id} n={3 + i} label={`Step ${i + 1} — ${ACTIONS[s.action.action]?.label ?? s.action.action}`} certainty={s.certainty}>
                {s.report ? (
                  <WorkflowStepPreview report={s.report} onOpen={() => setOpenReport(s.report!)} />
                ) : (
                  <p className="text-[11.5px] leading-relaxed text-text-muted">{s.reason}</p>
                )}
                {s.action.continueOnError && (
                  <p className="mt-1 text-[10.5px] text-text-subtle">
                    Marked “keep going on failure”, so the rest of the chain continues even if this step fails.
                  </p>
                )}
              </Beat>
            ))
          )}

          {/* ── verdict ───────────────────────────────────────────── */}
          {steps !== null && (
            <section
              className={`rounded-xl border p-3 ${
                anyDenied ? 'border-danger/40 bg-danger/[0.06]'
                  : anyApproval ? 'border-attention/40 bg-attention/[0.06]'
                  : anyUnknown ? 'border-line bg-canvas'
                  : 'border-positive/40 bg-positive/[0.06]'
              }`}
            >
              <div className="flex items-center gap-2">
                <Icon
                  name={anyDenied ? 'close' : anyApproval ? 'shield' : anyUnknown ? 'eye' : 'check'}
                  size={14}
                  className={anyDenied ? 'text-danger' : anyApproval ? 'text-attention' : anyUnknown ? 'text-text-subtle' : 'text-positive'}
                />
                <h3 className="text-[13px] font-semibold text-text">
                  {anyDenied
                    ? 'This rule would not complete'
                    : anyApproval
                      ? 'This rule would park waiting for you'
                      : anyUnknown
                        ? 'Partly unknown'
                        : 'This rule would run unattended'}
                </h3>
              </div>
              <p className="mt-1 text-[12px] leading-relaxed text-text-muted">
                {anyDenied
                  ? 'Your policy would refuse at least one action in a workflow this rule runs.'
                  : anyApproval
                    ? 'An automation fires with nobody present and authorizes nothing, so a gated step parks the workflow run at “waiting for you” until you answer it in Approvals.'
                    : anyUnknown
                      ? 'Some steps have no dry-run contract, so what they would do cannot be previewed. What is shown above is real; what is missing is marked UNKNOWN rather than assumed safe.'
                      : 'Nothing would be refused and nothing would need a person.'}
              </p>
              {rule.conditions.length > 0 && (
                <p className="mt-1 text-[11px] text-text-subtle">
                  All of it still depends on this rule's conditions passing, which only a real event can decide.
                </p>
              )}
            </section>
          )}

          <p className="px-1 text-[10.5px] leading-relaxed text-text-subtle">
            The service has no rule-level dry run yet, so this preview is composed from the real workflow dry run for
            each workflow step. Condition evaluation and the non-workflow actions are shown as UNKNOWN because there is
            no contract that can answer them without executing something.
          </p>
        </div>
      </div>
    </div>
  );
}

/* ── pieces ────────────────────────────────────────────────────────── */

function Beat({
  n,
  label,
  certainty,
  children,
}: {
  n: number;
  label: string;
  certainty: Certainty;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-line bg-canvas p-3">
      <header className="mb-1.5 flex flex-wrap items-center gap-2">
        <span className="grid h-5 w-5 shrink-0 place-items-center rounded-md bg-surface-active font-mono text-[10px] text-text-muted">
          {n}
        </span>
        <h3 className="text-[12.5px] font-semibold text-text">{label}</h3>
        <Badge tone={CERTAINTY_TONE[certainty]}>{certainty}</Badge>
      </header>
      {children}
    </section>
  );
}

function WorkflowStepPreview({ report, onOpen }: { report: DryRunReport; onOpen: () => void }) {
  const governed = report.plan.filter((s) => s.nodeClass === 'governed');
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <Icon name="workflows" size={12} className="text-text-subtle" />
        <span className="text-[12px] font-medium text-text">{report.workflowName}</span>
        <Badge tone={report.wouldRunUnattended ? 'positive' : 'attention'}>
          {report.wouldRunUnattended ? 'would run unattended' : 'would need you'}
        </Badge>
        {report.denials.length > 0 && <Badge tone="critical">{report.denials.length} refused</Badge>}
        {report.envelope.hasIrreversible && <Badge tone="critical">irreversible</Badge>}
        <Button size="sm" variant="ghost" icon="eye" className="ml-auto" onClick={onOpen}>
          Full plan
        </Button>
      </div>

      <p className="mt-1 text-[11.5px] text-text-muted">
        {report.plan.length} step{report.plan.length === 1 ? '' : 's'} planned
        {governed.length ? ` · ${governed.length} governed` : ' · none governed'}
        {report.offlineCapable ? ' · works offline' : ' · needs the network'}
      </p>

      {governed.length > 0 && (
        <ul className="mt-1.5 space-y-1">
          {governed.map((g) => (
            <li key={g.nodeId} className="flex flex-wrap items-center gap-1.5 text-[11px]">
              <code className="rounded bg-surface-active px-1.5 py-0.5 text-[10px] text-text-muted">{g.capabilityId}</code>
              <Badge tone={g.policy?.decision === 'auto-execute' ? 'positive' : g.policy?.decision === 'deny' ? 'critical' : 'attention'}>
                {g.policy?.decision ?? 'no decision'}
              </Badge>
              <span className="text-text-subtle">{g.risk}</span>
              {g.reachability !== 'certain' && <Badge tone="attention">{g.reachability}</Badge>}
            </li>
          ))}
        </ul>
      )}

      <p className="mt-1.5 text-[10px] text-text-subtle">{report.envelope.cannot}</p>
    </div>
  );
}
