/**
 * DryRunReport — what this workflow would do, without doing any of it.
 * ==================================================================
 * Renders `POST /workflows/:id/dry-run` verbatim. Three disciplines hold
 * it honest, and they are the whole point of the screen:
 *
 *   1. **Nothing is presented as a guarantee.** Every step carries the
 *      service's own `reachability`, shown as KNOWN / CONDITIONAL /
 *      UNKNOWN. A conditional step is one the run may never reach, and
 *      saying "it will do X" about it would be a lie with a progress bar.
 *
 *   2. **The zero-side-effect claim is the service's, not ours.** The
 *      report carries `sideEffects` — how many capabilities it asked the
 *      policy engine about, that it invoked none, and a sentence saying
 *      so. That sentence is displayed as it arrives. The renderer never
 *      asserts inertness on its own authority, because it has none.
 *
 *   3. **Policy is read, never derived.** Each governed step carries the
 *      Fabric's pre-flight `PolicyEvaluation` — decision, rule, risk and
 *      reason. This screen shows them; it does not compute them, and the
 *      real decision is still made at call time.
 */

import { useMemo, useState } from 'react';
import { Badge, Button, Icon } from '@aura/ui';
import type { StatusTone } from '@aura/core';
import type { DryRunReport as Report, NodeClass, PlannedStep, Reachability } from '../../ai/aiClient';
import { PermissionEnvelope } from './PermissionEnvelope';

/* ── the three certainty levels, in the brief's own words ─────────── */

const CERTAINTY: Record<Reachability, { word: string; tone: StatusTone; means: string }> = {
  certain: { word: 'KNOWN', tone: 'positive', means: 'Every run reaches this step.' },
  conditional: {
    word: 'CONDITIONAL',
    tone: 'attention',
    means: 'Downstream of a branch or a loop — whether it runs depends on data this preview cannot see.',
  },
  unreachable: {
    word: 'UNKNOWN',
    tone: 'critical',
    means: 'No path reaches this step, so it would not run at all. That is a graph mistake, not a prediction.',
  },
};

const CLASS_LABEL: Record<NodeClass, string> = {
  pure: 'no effect',
  control: 'routing only',
  intelligence: 'calls a model',
  'aura-internal': 'writes inside AURA',
  governed: 'governed by the Fabric',
};

const DECISION_TONE: Record<string, StatusTone> = {
  'auto-execute': 'positive',
  'ask-user': 'attention',
  'require-approval': 'critical',
  deny: 'critical',
};

const DECISION_WORD: Record<string, string> = {
  'auto-execute': 'runs without asking',
  'ask-user': 'asks you first',
  'require-approval': 'needs your approval',
  deny: 'refused',
};

export interface DryRunReportViewProps {
  report: Report;
  /** Focus a node on the canvas. Absent outside the editor. */
  onFocusNode?: (nodeId: string) => void;
  /** Re-request the preview. */
  onRefresh?: () => void;
  busy?: boolean;
}

export function DryRunReportView({ report, onFocusNode, onRefresh, busy }: DryRunReportViewProps) {
  const [showAll, setShowAll] = useState(false);

  const counts = useMemo(() => {
    const by = (r: Reachability) => report.plan.filter((s) => s.reachability === r).length;
    return { certain: by('certain'), conditional: by('conditional'), unreachable: by('unreachable') };
  }, [report.plan]);

  const shown = showAll ? report.plan : report.plan.filter((s) => s.nodeClass !== 'pure' && s.nodeClass !== 'control');
  const hidden = report.plan.length - shown.length;

  const errors = report.validation.findings.filter((f) => f.level === 'error');
  const warnings = report.validation.findings.filter((f) => f.level === 'warning');

  return (
    <div className="mx-auto max-w-3xl space-y-3 px-6 py-5">
      {/* ── this is a preview ─────────────────────────────────────── */}
      <section className="rounded-xl border border-accent/35 bg-accent-50 px-4 py-3 dark:bg-accent/10">
        <div className="flex items-center gap-2">
          <Icon name="eye" size={14} className="text-accent" />
          <h2 className="text-[13px] font-semibold text-text">This is a preview. Nothing was executed.</h2>
        </div>
        {/* The service's own words about its own inertness. */}
        <p className="mt-1 text-[12px] leading-relaxed text-text-muted">{report.sideEffects.note}</p>
        <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[11px]">
          <span className="flex items-center gap-1.5">
            <dt className="text-text-subtle">capabilities invoked</dt>
            <dd className="font-semibold text-positive">{report.sideEffects.invocations}</dd>
          </span>
          <span className="flex items-center gap-1.5">
            <dt className="text-text-subtle">policy questions asked</dt>
            <dd className="font-medium text-text">{report.sideEffects.policyEvaluations}</dd>
          </span>
          <span className="ml-auto text-text-subtle">planned {new Date(report.at).toLocaleTimeString()}</span>
        </dl>
        {onRefresh && (
          <Button size="sm" variant="ghost" icon="refresh" className="mt-2" loading={busy} onClick={onRefresh}>
            Re-check
          </Button>
        )}
      </section>

      {/* ── the verdict ───────────────────────────────────────────── */}
      <Verdict report={report} />

      {/* ── what would stop it ────────────────────────────────────── */}
      {report.denials.length > 0 && (
        <section className="rounded-xl border border-danger/40 bg-danger/[0.06] p-3">
          <div className="mb-1.5 flex items-center gap-2">
            <Icon name="close" size={13} className="text-danger" />
            <h3 className="text-[12.5px] font-semibold text-text">
              {report.denials.length === 1 ? 'One action would be refused' : `${report.denials.length} actions would be refused`}
            </h3>
          </div>
          <ul className="space-y-1.5">
            {report.denials.map((d) => (
              <li key={d.nodeId} className="text-[11.5px]">
                <code className="rounded bg-surface-active px-1.5 py-0.5 text-[10.5px] text-text">{d.capabilityId}</code>
                <span className="ml-1.5 text-text-muted">{d.reason}</span>
                <span className="ml-1.5 text-[10px] text-text-subtle">rule {d.rule}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[10.5px] leading-relaxed text-text-subtle">
            A refused step stops the run there. This is your policy working, not the workflow being broken.
          </p>
        </section>
      )}

      {report.approvalsRequired.length > 0 && (
        <section className="rounded-xl border border-attention/40 bg-attention/[0.06] p-3">
          <div className="mb-1.5 flex items-center gap-2">
            <Icon name="shield" size={13} className="text-attention" />
            <h3 className="text-[12.5px] font-semibold text-text">
              {report.approvalsRequired.length === 1
                ? 'One step would stop and ask you'
                : `${report.approvalsRequired.length} steps would stop and ask you`}
            </h3>
          </div>
          <ul className="space-y-1.5">
            {report.approvalsRequired.map((a) => (
              <li key={a.nodeId} className="text-[11.5px]">
                <code className="rounded bg-surface-active px-1.5 py-0.5 text-[10.5px] text-text">{a.capabilityId}</code>
                <span className="ml-1.5 text-text-muted">{a.reason}</span>
                <span className="ml-1.5 text-[10px] text-text-subtle">rule {a.rule}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[10.5px] leading-relaxed text-text-subtle">
            No approval request has been created. These are the questions a real run would raise.
          </p>
        </section>
      )}

      {/* ── validation ────────────────────────────────────────────── */}
      {(errors.length > 0 || warnings.length > 0 || report.secretsMissing.length > 0) && (
        <section className="rounded-xl border border-line bg-canvas p-3">
          <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-subtle">
            {report.validation.valid ? 'Worth knowing' : 'This graph cannot run as written'}
          </h3>
          <ul className="space-y-1.5">
            {[...errors, ...warnings].map((f, i) => (
              <li key={i} className="flex items-start gap-2 text-[11.5px]">
                <Icon
                  name={f.level === 'error' ? 'close' : 'bell'}
                  size={11}
                  className={`mt-0.5 shrink-0 ${f.level === 'error' ? 'text-danger' : 'text-attention'}`}
                />
                <span className="min-w-0">
                  <span className="text-text">{f.message}</span>
                  <span className="ml-1.5 text-[10px] uppercase tracking-wide text-text-subtle">{f.layer}</span>
                </span>
              </li>
            ))}
            {report.secretsMissing.map((n) => (
              <li key={n} className="flex items-start gap-2 text-[11.5px]">
                <Icon name="close" size={11} className="mt-0.5 shrink-0 text-danger" />
                <span className="text-text">
                  The secret <code className="rounded bg-surface-active px-1">{n}</code> is referenced but not stored —
                  that step would fail.
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ── the plan ──────────────────────────────────────────────── */}
      <section className="rounded-xl border border-line bg-canvas">
        <header className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
          <Icon name="workflows" size={14} className="text-accent" />
          <h3 className="text-[12.5px] font-semibold text-text">The plan</h3>
          <span className="flex flex-wrap items-center gap-1.5">
            {counts.certain > 0 && <Badge tone="positive">{counts.certain} known</Badge>}
            {counts.conditional > 0 && <Badge tone="attention">{counts.conditional} conditional</Badge>}
            {counts.unreachable > 0 && <Badge tone="critical">{counts.unreachable} unreachable</Badge>}
          </span>
          {hidden > 0 && (
            <button onClick={() => setShowAll(true)} className="ml-auto text-[10.5px] text-accent">
              show {hidden} step{hidden === 1 ? '' : 's'} with no effect
            </button>
          )}
          {showAll && hidden === 0 && report.plan.some((s) => s.nodeClass === 'pure' || s.nodeClass === 'control') && (
            <button onClick={() => setShowAll(false)} className="ml-auto text-[10.5px] text-accent">
              hide steps with no effect
            </button>
          )}
        </header>

        <ol className="divide-y divide-line/60">
          {shown.map((s) => (
            <StepRow key={s.nodeId} step={s} onFocus={onFocusNode} />
          ))}
          {!shown.length && (
            <li className="px-4 py-6 text-center text-[12px] text-text-muted">
              Nothing in this workflow reaches outside AURA.
            </li>
          )}
        </ol>

        <footer className="border-t border-line px-4 py-2 text-[10.5px] leading-relaxed text-text-subtle">
          Order is the service's planned sequence. Steps at the same depth may interleave, and a CONDITIONAL step may
          never run at all — this is a plan, not a recording.
        </footer>
      </section>

      {/* ── authority ─────────────────────────────────────────────── */}
      <section>
        <h3 className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wide text-text-subtle">
          Authority this run would receive
        </h3>
        <PermissionEnvelope
          envelope={report.envelope}
          available
          labelOf={(id) => report.plan.find((s) => s.nodeId === id)?.label ?? id}
          onSelectNode={onFocusNode}
          variant="compact"
        />
        <div className="mt-2 rounded-xl border border-line bg-canvas px-3 py-2">
          <div className="text-[10.5px] font-semibold uppercase tracking-wide text-text-subtle">Least-privilege grants</div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {(['read', 'write', 'execute', 'autonomous'] as const).map((g) => (
              <span
                key={g}
                className={`rounded-full px-2.5 py-0.5 text-[10.5px] ${
                  report.grants[g]
                    ? 'bg-accent-50 text-accent-700 dark:bg-accent/15 dark:text-accent-200'
                    : 'bg-surface-active text-text-subtle line-through'
                }`}
              >
                {g}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* ── what a preview cannot know ────────────────────────────── */}
      <section className="rounded-xl border border-line bg-canvas p-3">
        <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-subtle">
          What this preview cannot tell you
        </h3>
        <ul className="space-y-1 text-[11.5px] leading-relaxed text-text-muted">
          <li>• Whether a branch is taken. Conditions are decided by data that only exists during a real run.</li>
          <li>• How many times a loop repeats — only its configured maximum is known.</li>
          <li>• What a model will return, or how long anything takes.</li>
          <li>• Whether an external service will answer. Reachability of a host is not tested here.</li>
          <li>
            • The final policy decision. The Fabric evaluates every call at the moment it happens and can be stricter
            than this preview — never looser.
          </li>
        </ul>
      </section>
    </div>
  );
}

/* ── verdict ───────────────────────────────────────────────────────── */

function Verdict({ report }: { report: Report }) {
  const blocked = !report.validation.valid || report.denials.length > 0;
  const gated = report.approvalsRequired.length > 0;

  const tone = blocked ? 'danger' : gated ? 'attention' : 'positive';
  const cls =
    tone === 'danger' ? 'border-danger/40 bg-danger/[0.06]'
      : tone === 'attention' ? 'border-attention/40 bg-attention/[0.06]'
      : 'border-positive/40 bg-positive/[0.06]';

  return (
    <section className={`rounded-xl border p-3 ${cls}`}>
      <div className="flex items-center gap-2">
        <Icon
          name={blocked ? 'close' : gated ? 'shield' : 'check'}
          size={14}
          className={tone === 'danger' ? 'text-danger' : tone === 'attention' ? 'text-attention' : 'text-positive'}
        />
        <h3 className="text-[13px] font-semibold text-text">
          {blocked
            ? 'This would not finish'
            : gated
              ? 'This would stop and wait for you'
              : 'This would run unattended'}
        </h3>
      </div>
      <p className="mt-1 text-[12px] leading-relaxed text-text-muted">
        {blocked
          ? report.denials.length
            ? 'Your policy would refuse at least one action, so the run stops there.'
            : 'The graph has an error that prevents it running at all.'
          : gated
            ? `${report.approvalsRequired.length} step${report.approvalsRequired.length === 1 ? '' : 's'} would pause for a decision. Started by an automation, the run would park until answered.`
            : 'Nothing would be refused and nothing would need a person, so this could run with nobody watching.'}
      </p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <Badge tone={report.wouldRunUnattended ? 'positive' : 'attention'}>
          {report.wouldRunUnattended ? 'unattended: yes' : 'unattended: no'}
        </Badge>
        <Badge tone={report.offlineCapable ? 'positive' : 'neutral'}>
          {report.offlineCapable ? 'works offline' : 'needs the network'}
        </Badge>
        {report.secretsRequired.length > 0 && (
          <Badge tone={report.secretsMissing.length ? 'critical' : 'neutral'}>
            {report.secretsRequired.length} secret{report.secretsRequired.length === 1 ? '' : 's'}
            {report.secretsMissing.length ? ` · ${report.secretsMissing.length} missing` : ''}
          </Badge>
        )}
        {report.validation.requiresReview && <Badge tone="attention">needs review before activation</Badge>}
      </div>
    </section>
  );
}

/* ── one planned step ──────────────────────────────────────────────── */

function StepRow({ step, onFocus }: { step: PlannedStep; onFocus?: (id: string) => void }) {
  const certainty = CERTAINTY[step.reachability];
  return (
    <li>
      <button
        onClick={() => onFocus?.(step.nodeId)}
        disabled={!onFocus}
        className="flex w-full items-start gap-3 px-4 py-2.5 text-left transition-colors enabled:hover:bg-surface-hover disabled:cursor-default"
      >
        <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md bg-surface-active font-mono text-[10px] text-text-muted">
          {step.order}
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-[12.5px] font-medium text-text">{step.label}</span>
            <Badge tone={certainty.tone}>{certainty.word}</Badge>
            <span className="text-[10.5px] text-text-subtle">{CLASS_LABEL[step.nodeClass]}</span>
            {step.needsNetwork && <Icon name="link" size={10} className="text-text-subtle" aria-label="needs the network" />}
            {step.irreversible && <Badge tone="critical">irreversible</Badge>}
          </span>

          {step.describes && (
            <span className="mt-0.5 block text-[11.5px] text-text-muted">would {step.describes}</span>
          )}
          {step.planError && (
            <span className="mt-0.5 block text-[11.5px] text-attention">
              arguments could not be planned — {step.planError}
            </span>
          )}
          {step.maxIterations !== undefined && (
            <span className="mt-0.5 block text-[11px] text-text-subtle">
              repeats at most {step.maxIterations} time{step.maxIterations === 1 ? '' : 's'} — the actual count depends on
              the data
            </span>
          )}

          {step.policy && (
            <span className="mt-1 flex flex-wrap items-center gap-2">
              <code className="rounded bg-surface-active px-1.5 py-0.5 text-[10.5px] text-text-muted">
                {step.capabilityId}
              </code>
              <Badge tone={DECISION_TONE[step.policy.decision] ?? 'neutral'}>
                {DECISION_WORD[step.policy.decision] ?? step.policy.decision}
              </Badge>
              <Badge tone={step.policy.risk === 'high' ? 'critical' : step.policy.risk === 'medium' ? 'attention' : 'positive'}>
                {step.policy.risk}
              </Badge>
              <span className="text-[10px] text-text-subtle">rule {step.policy.rule}</span>
            </span>
          )}
          {step.policy && (
            <span className="mt-0.5 block text-[11px] leading-snug text-text-muted">{step.policy.reason}</span>
          )}

          {step.secretsUsed && step.secretsUsed.length > 0 && (
            <span className="mt-1 block text-[10.5px] text-text-subtle">
              would resolve {step.secretsUsed.map((n) => `{{secret:${n}}}`).join(', ')} at execution time — values are
              never shown here
            </span>
          )}

          {step.reachability !== 'certain' && (
            <span className="mt-1 block text-[10.5px] leading-snug text-text-subtle">{certainty.means}</span>
          )}
        </span>
      </button>
    </li>
  );
}
