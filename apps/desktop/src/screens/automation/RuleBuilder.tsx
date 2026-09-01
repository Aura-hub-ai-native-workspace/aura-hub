/**
 * RuleBuilder — trigger → conditions → actions → retry.
 * ==================================================================
 * The order is the sentence a rule makes: *when* this happens, *if* these
 * hold, *do* these things, *retrying* like so. Each block states what the
 * engine will actually do rather than naming a field.
 *
 * Three rules this editor holds to:
 *
 *   • Trigger types come from the service's own union. There is no
 *     free-text trigger and no invented semantics.
 *   • A workflow step picks from the real workflow library and shows that
 *     workflow's authority envelope, because "this rule can commit to your
 *     repository at 3am" is the fact a person needs before enabling it.
 *   • Nothing is validated for permission here. The Capability Fabric
 *     decides at call time, and an automation grants nothing — a gated
 *     node parks the workflow run at `awaiting-approval` and waits.
 */

import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Icon, IconButton, Input, useToast } from '@aura/ui';
import type { AutomationActionType, Condition, ConditionOp, RuleAction } from '../../ai/automationClient';
import { useAutomation } from '../../data/useAutomation';
import { useWorkspace } from '../../data/useWorkspace';
import { useWorkflows } from '../../data/useWorkflows';
import { aiClient, type AuthorityEnvelope } from '../../ai/aiClient';
import { PermissionEnvelope, envelopeSummary } from '../workflows/PermissionEnvelope';
import {
  ACTIONS,
  ACTION_LIST,
  CONDITION_OPS,
  CONDITION_OP_LIST,
  TRIGGERS,
  TRIGGER_LIST,
  fmtRetry,
} from './automationMeta';
import { draftFrom, emptyDraft, newActionId, validateRule, type RuleDraft } from './ruleValidation';
import { RuleDryRun } from './RuleDryRun';

export interface RuleBuilderProps {
  /** Null creates a new rule. */
  ruleId: string | null;
  onClose: () => void;
  onSaved: (id: string) => void;
}

export function RuleBuilder({ ruleId, onClose, onSaved }: RuleBuilderProps) {
  const auto = useAutomation();
  const toast = useToast();
  const workflows = useWorkflows((s) => s.list);
  const projects = useWorkspace((s) => s.projects);
  const openProjectId = useWorkspace((s) => s.openId);
  const openProjectName = useWorkspace((s) => s.projects.find((p) => p.id === s.openId)?.name ?? null);
  const [draft, setDraft] = useState<RuleDraft>(() => emptyDraft());
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(Boolean(ruleId));
  const [previewing, setPreviewing] = useState(false);

  useEffect(() => {
    if (!ruleId) {
      setDraft(emptyDraft());
      setLoading(false);
      return;
    }
    let live = true;
    void auto.loadRule(ruleId).then((rule) => {
      if (!live) return;
      if (rule) setDraft(draftFrom(rule));
      setLoading(false);
    });
    return () => { live = false; };
  }, [ruleId]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = <K extends keyof RuleDraft>(key: K, value: RuleDraft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setDirty(true);
  };

  const workflowIds = useMemo(() => new Set(workflows.map((w) => w.id)), [workflows]);
  const report = useMemo(() => validateRule(draft, workflowIds), [draft, workflowIds]);
  const trigger = TRIGGERS[draft.trigger.type];

  const save = async () => {
    if (!report.savable) return;
    const saved = ruleId
      ? await auto.save(ruleId, draft)
      : await auto.create(draft);
    if (!saved) {
      toast.push({ title: 'Could not save the rule', description: auto.error ?? 'The service refused it.', tone: 'critical' });
      return;
    }
    setDirty(false);
    toast.push({ title: ruleId ? 'Rule saved' : 'Rule created', tone: 'positive' });
    onSaved(saved.id);
  };

  if (loading) {
    return <div className="mx-auto mt-8 h-40 max-w-3xl animate-pulse rounded-xl border border-line bg-surface-active/40" aria-label="Reading the rule" />;
  }

  const saved = ruleId ? auto.defs[ruleId] : null;
  if (previewing && saved) {
    return (
      <RuleDryRun
        rule={saved}
        projectId={openProjectId}
        projectName={openProjectName}
        onClose={() => setPreviewing(false)}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* header */}
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-line px-4 py-2.5">
        <Button variant="ghost" size="sm" icon="projects" onClick={onClose}>All rules</Button>
        <div className="h-5 w-px bg-line" />
        <span className="text-[14px] font-semibold text-text">
          {ruleId ? draft.name || 'Untitled automation' : 'New rule'}
          {dirty && <span className="ml-1.5 align-middle text-accent">•</span>}
        </span>
        <Badge tone={draft.enabled ? 'positive' : 'neutral'} dot>{draft.enabled ? 'enabled' : 'disabled'}</Badge>

        <div className="ml-auto flex items-center gap-1.5">
          <button
            onClick={() => set('enabled', !draft.enabled)}
            aria-label={draft.enabled ? 'Disable this rule' : 'Enable this rule'}
            className={`flex h-5 w-9 items-center rounded-full p-0.5 transition-colors ${draft.enabled ? 'bg-accent' : 'bg-surface-active'}`}
          >
            <span className={`h-4 w-4 rounded-full bg-white shadow transition-transform ${draft.enabled ? 'translate-x-4' : ''}`} />
          </button>
          <Button
            size="sm"
            variant="secondary"
            icon="eye"
            disabled={!ruleId || !report.savable || dirty}
            title={
              !ruleId ? 'Save the rule first — a preview plans the rule as the service holds it'
                : dirty ? 'Save your changes first, so the preview matches what you are looking at'
                : 'Show what this rule would do, without doing any of it'
            }
            onClick={() => setPreviewing(true)}
          >
            Dry run
          </Button>
          <Button
            size="sm"
            icon="check"
            onClick={() => void save()}
            disabled={!report.savable || auto.busy !== null}
            title={report.savable ? 'Save this rule' : `${report.errors} problem${report.errors === 1 ? '' : 's'} must be fixed first`}
          >
            Save{!report.savable && ` · ${report.errors}`}
          </Button>
        </div>
      </div>

      {/* The service refused it — its verdict, not ours. */}
      {auto.issues.length > 0 && (
        <ul className="shrink-0 border-b border-danger/30 bg-danger/[0.05]">
          {auto.issues.map((i, n) => (
            <li key={n} className="flex items-start gap-2 px-4 py-1.5">
              <Icon name="close" size={11} className="mt-0.5 shrink-0 text-danger" />
              <span className="text-[11.5px] leading-snug text-text">
                <span className="text-text-subtle">{i.field}: </span>{i.message}
              </span>
            </li>
          ))}
        </ul>
      )}

      {/* validation */}
      {report.findings.length > 0 && (
        <ul className={`shrink-0 border-b ${report.errors ? 'border-danger/30 bg-danger/[0.05]' : 'border-attention/30 bg-attention/[0.05]'}`}>
          {report.findings.map((f) => (
            <li key={f.id} className="flex items-start gap-2 px-4 py-1.5">
              <Icon
                name={f.level === 'error' ? 'close' : 'bell'}
                size={11}
                className={`mt-0.5 shrink-0 ${f.level === 'error' ? 'text-danger' : 'text-attention'}`}
              />
              <span className="min-w-0">
                <span className="block text-[11.5px] leading-snug text-text">{f.message}</span>
                {f.fix && <span className="block text-[10.5px] leading-snug text-text-muted">{f.fix}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-4 px-6 py-6">
          {/* ── identity ───────────────────────────────────────────── */}
          <Section step="Rule" title="What is this rule called?">
            <div className="space-y-2.5">
              <Field label="Name">
                <Input value={draft.name} onChange={(e) => set('name', e.target.value)} placeholder="PR merged → security review" />
              </Field>
              <Field label="Description">
                <textarea
                  value={draft.description}
                  onChange={(e) => set('description', e.target.value)}
                  rows={2}
                  placeholder="What this automates, and why."
                  className="w-full resize-y rounded-xl border border-line bg-surface px-2.5 py-2 text-[12px] text-text outline-none transition-colors placeholder:text-text-subtle focus:border-accent"
                />
              </Field>
              <Field label="Category">
                <Input value={draft.category} onChange={(e) => set('category', e.target.value)} className="w-56" />
              </Field>
            </div>
          </Section>

          {/* ── trigger ────────────────────────────────────────────── */}
          <Section step="When" title="What starts it?">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {TRIGGER_LIST.map((t) => {
                const m = TRIGGERS[t];
                const active = draft.trigger.type === t;
                return (
                  <button
                    key={t}
                    onClick={() => set('trigger', { ...draft.trigger, type: t })}
                    className={`flex items-start gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors ${
                      active ? 'border-accent bg-accent-50 dark:bg-accent/10' : 'border-line bg-surface hover:border-line-strong'
                    }`}
                  >
                    <Icon name={m.icon} size={14} className={active ? 'mt-0.5 text-accent' : 'mt-0.5 text-text-subtle'} />
                    <span className="min-w-0">
                      <span className="block text-[12.5px] font-medium text-text">{m.label}</span>
                      <span className="block text-[10.5px] leading-snug text-text-muted">{m.when}</span>
                    </span>
                  </button>
                );
              })}
            </div>
            {draft.trigger.type === 'schedule' ? (
              <div className="mt-3 space-y-2.5 rounded-xl border border-line bg-surface p-3">
                <Field label="Cron expression">
                  <Input
                    value={draft.trigger.cron ?? ''}
                    onChange={(e) => set('trigger', { ...draft.trigger, cron: e.target.value })}
                    placeholder="0 9 * * 1-5"
                    aria-label="Cron expression"
                    className="font-mono"
                  />
                  <span className="mt-1 block text-[10.5px] text-text-subtle">
                    Five fields: minute hour day-of-month month day-of-week. The service validates it on save and
                    refuses a schedule that could never fire.
                  </span>
                </Field>
                <Field label="Project this runs against">
                  <select
                    value={draft.trigger.projectId ?? ''}
                    onChange={(e) => set('trigger', { ...draft.trigger, projectId: e.target.value })}
                    aria-label="Project this schedule runs against"
                    className="w-full rounded-lg border border-line bg-canvas px-2 py-1.5 text-[12px] text-text outline-none focus:border-accent"
                  >
                    <option value="">Choose a project…</option>
                    {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                  <span className="mt-1 block text-[10.5px] leading-relaxed text-text-subtle">
                    A time trigger carries no event to say which project it is about, so it has to be named here rather
                    than guessed from whatever happens to be open at that hour.
                  </span>
                </Field>
              </div>
            ) : (
              <p className="mt-2.5 text-[10.5px] leading-relaxed text-text-subtle">
                This is an event, not a time — the rule fires when the thing happens. Only a schedule trigger has a next
                run.
              </p>
            )}
          </Section>

          {/* ── conditions ─────────────────────────────────────────── */}
          <Section
            step="If"
            title="Which of those should it act on?"
            action={
              <Button
                size="sm"
                variant="ghost"
                icon="plus"
                onClick={() => set('conditions', [...draft.conditions, { field: trigger?.fields[0] ?? '', op: 'equals', value: '' }])}
              >
                Add condition
              </Button>
            }
          >
            {draft.conditions.length === 0 ? (
              <p className="text-[12px] text-text-muted">
                No conditions — the rule acts on every {trigger?.label.toLowerCase() ?? 'event'}.
              </p>
            ) : (
              <ul className="space-y-2">
                {draft.conditions.map((c, i) => (
                  <ConditionRow
                    key={i}
                    condition={c}
                    fields={trigger?.fields ?? []}
                    onChange={(next) => set('conditions', draft.conditions.map((x, j) => (j === i ? next : x)))}
                    onRemove={() => set('conditions', draft.conditions.filter((_, j) => j !== i))}
                  />
                ))}
              </ul>
            )}
            <p className="mt-2.5 text-[10.5px] leading-relaxed text-text-subtle">
              Conditions read the event's own payload by dot-path. Every one must pass; the engine records which did and
              which did not on each run.
            </p>
          </Section>

          {/* ── actions ────────────────────────────────────────────── */}
          <Section
            step="Do"
            title="What should happen?"
            action={
              <Button
                size="sm"
                variant="ghost"
                icon="plus"
                onClick={() =>
                  set('chain', [...draft.chain, { id: newActionId(), action: 'run-workflow', label: ACTIONS['run-workflow'].label, config: {} }])
                }
              >
                Add step
              </Button>
            }
          >
            {draft.chain.length === 0 ? (
              <p className="text-[12px] text-text-muted">No steps yet — this rule would do nothing.</p>
            ) : (
              <ol className="space-y-2.5">
                {draft.chain.map((a, i) => (
                  <ActionRow
                    key={a.id}
                    index={i}
                    action={a}
                    onChange={(next) => set('chain', draft.chain.map((x, j) => (j === i ? next : x)))}
                    onRemove={() => set('chain', draft.chain.filter((_, j) => j !== i))}
                    onMove={(dir) => {
                      const to = i + dir;
                      if (to < 0 || to >= draft.chain.length) return;
                      const next = [...draft.chain];
                      [next[i], next[to]] = [next[to], next[i]];
                      set('chain', next);
                    }}
                    canMoveUp={i > 0}
                    canMoveDown={i < draft.chain.length - 1}
                  />
                ))}
              </ol>
            )}
          </Section>

          {/* ── retry ──────────────────────────────────────────────── */}
          <Section step="Retry" title="What if a step fails?">
            <div className="grid grid-cols-3 gap-3">
              <Field label="Attempts per step">
                <Input
                  type="number"
                  inputSize="sm"
                  min={1}
                  max={10}
                  value={String(draft.retry.maxAttempts)}
                  onChange={(e) => set('retry', { ...draft.retry, maxAttempts: Number(e.target.value) })}
                />
              </Field>
              <Field label="First delay (ms)">
                <Input
                  type="number"
                  inputSize="sm"
                  min={0}
                  step={250}
                  value={String(draft.retry.delayMs)}
                  onChange={(e) => set('retry', { ...draft.retry, delayMs: Number(e.target.value) })}
                />
              </Field>
              <Field label="Backoff ×">
                <Input
                  type="number"
                  inputSize="sm"
                  min={1}
                  step={0.5}
                  value={String(draft.retry.backoffFactor)}
                  onChange={(e) => set('retry', { ...draft.retry, backoffFactor: Number(e.target.value) })}
                />
              </Field>
            </div>
            <p className="mt-2.5 text-[12px] text-text">{fmtRetry(draft.retry)}</p>
            <p className="mt-1 text-[10.5px] leading-relaxed text-text-subtle">
              A step marked “keep going on failure” lets the rest of the chain continue. Retrying a step that already had
              an effect will repeat that effect — the engine does not undo anything.
            </p>
          </Section>
        </div>
      </div>
    </div>
  );
}

/* ── pieces ────────────────────────────────────────────────────────── */

function Section({
  step,
  title,
  action,
  children,
}: {
  step: string;
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-line bg-canvas p-4">
      <header className="mb-3 flex items-center gap-2.5">
        <span className="rounded-md bg-surface-active px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-text-subtle">
          {step}
        </span>
        <h3 className="text-[13px] font-semibold text-text">{title}</h3>
        {action && <div className="ml-auto">{action}</div>}
      </header>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium text-text">{label}</span>
      {children}
    </label>
  );
}

function ConditionRow({
  condition,
  fields,
  onChange,
  onRemove,
}: {
  condition: Condition;
  fields: string[];
  onChange: (c: Condition) => void;
  onRemove: () => void;
}) {
  const op = CONDITION_OPS[condition.op];
  return (
    <li className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface px-2.5 py-2">
      <input
        list="automation-condition-fields"
        value={condition.field}
        onChange={(e) => onChange({ ...condition, field: e.target.value })}
        placeholder="payload.field"
        aria-label="Condition field"
        className="w-48 rounded-lg border border-line bg-canvas px-2 py-1 font-mono text-[11.5px] text-text outline-none focus:border-accent"
      />
      <datalist id="automation-condition-fields">
        {fields.map((f) => <option key={f} value={f} />)}
      </datalist>

      <select
        value={condition.op}
        onChange={(e) => onChange({ ...condition, op: e.target.value as ConditionOp })}
        aria-label="Condition operator"
        className="rounded-lg border border-line bg-canvas px-2 py-1 text-[11.5px] text-text outline-none focus:border-accent"
      >
        {CONDITION_OP_LIST.map((o) => <option key={o} value={o}>{CONDITION_OPS[o].label}</option>)}
      </select>

      {op?.needsValue && (
        <input
          value={String(condition.value ?? '')}
          onChange={(e) => onChange({ ...condition, value: e.target.value })}
          placeholder={condition.op === 'in' ? 'a, b, c' : 'value'}
          aria-label="Condition value"
          className="min-w-0 flex-1 rounded-lg border border-line bg-canvas px-2 py-1 text-[11.5px] text-text outline-none focus:border-accent"
        />
      )}

      <IconButton icon="close" label="Remove this condition" size="sm" onClick={onRemove} />
    </li>
  );
}

function ActionRow({
  index,
  action,
  onChange,
  onRemove,
  onMove,
  canMoveUp,
  canMoveDown,
}: {
  index: number;
  action: RuleAction;
  onChange: (a: RuleAction) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
}) {
  const meta = ACTIONS[action.action];

  return (
    <li className="rounded-xl border border-line bg-surface p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="grid h-5 w-5 shrink-0 place-items-center rounded-md bg-surface-active font-mono text-[10px] text-text-muted">
          {index + 1}
        </span>
        <select
          value={action.action}
          onChange={(e) => {
            const next = e.target.value as AutomationActionType;
            onChange({ ...action, action: next, label: ACTIONS[next].label, config: {} });
          }}
          aria-label={`Step ${index + 1} action`}
          className="rounded-lg border border-line bg-canvas px-2 py-1 text-[12px] text-text outline-none focus:border-accent"
        >
          {ACTION_LIST.map((a) => <option key={a} value={a}>{ACTIONS[a].label}</option>)}
        </select>

        <div className="ml-auto flex items-center gap-0.5">
          <IconButton icon="minimize" label="Move step up" size="sm" onClick={() => onMove(-1)} className={canMoveUp ? '' : 'opacity-30'} />
          <IconButton icon="maximize" label="Move step down" size="sm" onClick={() => onMove(1)} className={canMoveDown ? '' : 'opacity-30'} />
          <IconButton icon="close" label="Remove this step" size="sm" onClick={onRemove} />
        </div>
      </div>

      <p className="mt-1.5 text-[11px] leading-relaxed text-text-muted">{meta?.does}</p>

      {action.action === 'run-workflow' ? (
        <WorkflowStep
          workflowId={String(action.config.workflowId ?? '')}
          onPick={(id) => onChange({ ...action, config: { ...action.config, workflowId: id } })}
        />
      ) : (
        meta?.fields.length > 0 && (
          <div className="mt-2 space-y-2">
            {meta.fields.map((f) => (
              <Field key={f.key} label={f.label}>
                <Input
                  inputSize="sm"
                  value={String(action.config[f.key] ?? '')}
                  placeholder={f.placeholder}
                  onChange={(e) => onChange({ ...action, config: { ...action.config, [f.key]: e.target.value } })}
                />
                {f.help && <span className="mt-0.5 block text-[10px] text-text-subtle">{f.help}</span>}
              </Field>
            ))}
          </div>
        )
      )}

      <label className="mt-2.5 flex cursor-pointer items-center gap-2">
        <input
          type="checkbox"
          checked={action.continueOnError === true}
          onChange={(e) => onChange({ ...action, continueOnError: e.target.checked })}
          className="h-3.5 w-3.5 accent-[var(--accent)]"
        />
        <span className="text-[11px] text-text-muted">Keep going if this step fails</span>
      </label>
    </li>
  );
}

/**
 * A workflow step, with the chosen workflow's real authority shown.
 *
 * This is the most important disclosure in the builder: enabling a rule
 * hands a workflow the ability to act without a person present, and the
 * envelope is the only place that says what that workflow may do.
 */
function WorkflowStep({ workflowId, onPick }: { workflowId: string; onPick: (id: string) => void }) {
  const workflows = useWorkflows((s) => s.list);
  const cached = useWorkflows((s) => s.envelopes[workflowId]);
  const [envelope, setEnvelope] = useState<AuthorityEnvelope | null>(cached ?? null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!workflowId) { setEnvelope(null); return; }
    if (cached) { setEnvelope(cached); return; }
    let live = true;
    void aiClient.workflowEnvelope(workflowId)
      .then((r) => { if (live && 'envelope' in r) setEnvelope(r.envelope); })
      .catch(() => { if (live) setEnvelope(null); });
    return () => { live = false; };
  }, [workflowId, cached]);

  const summary = envelope ? envelopeSummary(envelope) : null;

  return (
    <div className="mt-2">
      <Field label="Workflow">
        <select
          value={workflowId}
          onChange={(e) => onPick(e.target.value)}
          aria-label="Workflow to run"
          className="w-full rounded-lg border border-line bg-canvas px-2 py-1.5 text-[12px] text-text outline-none focus:border-accent"
        >
          <option value="">Choose a workflow…</option>
          {workflows.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
      </Field>

      {workflowId && (
        <div className="mt-2 rounded-lg border border-line bg-canvas px-2.5 py-2">
          <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 text-left">
            <Icon
              name="shield"
              size={12}
              className={summary?.tone === 'critical' ? 'text-danger' : summary?.tone === 'attention' ? 'text-attention' : 'text-text-subtle'}
            />
            <span className="text-[11.5px] text-text">
              {summary ? `This workflow ${summary.text}` : 'Reading what this workflow can do…'}
            </span>
            {envelope?.hasIrreversible && <Badge tone="critical">irreversible</Badge>}
            <span className="ml-auto text-[10.5px] text-text-subtle">{open ? 'hide' : 'details'}</span>
          </button>

          {open && (
            <div className="mt-2">
              <PermissionEnvelope
                envelope={envelope}
                available={envelope ? true : null}
                labelOf={(id) => id}
                variant="compact"
              />
            </div>
          )}

          <p className="mt-2 text-[10.5px] leading-relaxed text-text-subtle">
            An automation runs with nobody present, so it authorizes nothing. A step whose policy decision is above
            auto-execute parks the workflow run at “waiting for you” until it is answered in Approvals.
          </p>
        </div>
      )}
    </div>
  );
}
