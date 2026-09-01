/**
 * RunNowDialog — fire a rule now, against an event you describe.
 * ==================================================================
 * ── This is not a simulation ──────────────────────────────────────
 * `POST /automation/rules/:id/run` is a **real run**: the engine builds a
 * real event, evaluates the rule's real conditions against it, and
 * executes the real action chain. A `run-workflow` step really hands the
 * workflow to the Workflow Engine, and any governed action really goes
 * through the Capability Fabric. The dialog says so plainly, because a
 * control that looks like a preview and isn't one is the worst kind of
 * button. A dry-run UI is not built and will not be until the backend has
 * a dry-run contract.
 *
 * ── Why the payload field exists ──────────────────────────────────
 * Conditions read the event's payload by dot-path. Firing with an empty
 * payload means every condition that tests a field fails, so a rule with
 * conditions could never be exercised by hand. The service already
 * accepts a `payload`; this is the field for it, seeded with the paths
 * that trigger actually carries.
 */

import { useMemo, useState } from 'react';
import { Badge, Button, Dialog, Icon } from '@aura/ui';
import type { AutomationRule } from '../../ai/automationClient';
import { CONDITION_OPS, TRIGGERS } from './automationMeta';

export interface RunNowDialogProps {
  rule: AutomationRule | null;
  open: boolean;
  projectName: string | null;
  busy?: boolean;
  onClose: () => void;
  onRun: (payload: Record<string, unknown>) => void;
}

/** A payload skeleton from the paths this trigger's conditions read. */
function seedPayload(rule: AutomationRule | null): string {
  if (!rule) return '{}';
  const paths = new Set<string>();
  for (const c of rule.conditions) if (c.field.trim()) paths.add(c.field.trim());
  // Fall back to the trigger's documented fields when there are no
  // conditions, so the shape is still discoverable.
  if (!paths.size) for (const f of TRIGGERS[rule.trigger.type]?.fields ?? []) paths.add(f);

  const obj: Record<string, unknown> = {};
  for (const p of paths) {
    const parts = p.split('.');
    let cursor = obj;
    parts.forEach((part, i) => {
      if (i === parts.length - 1) cursor[part] = '';
      else cursor = (cursor[part] as Record<string, unknown>) ?? (cursor[part] = {});
    });
  }
  return JSON.stringify(obj, null, 2);
}

export function RunNowDialog({ rule, open, projectName, busy, onClose, onRun }: RunNowDialogProps) {
  const [text, setText] = useState('{}');
  const [touched, setTouched] = useState(false);

  // Reseed whenever a different rule opens the dialog.
  const seed = useMemo(() => seedPayload(rule), [rule]);
  const value = touched ? text : seed;

  let parsed: Record<string, unknown> | null = null;
  let parseError: string | null = null;
  try {
    const v = JSON.parse(value || '{}') as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v)) parsed = v as Record<string, unknown>;
    else parseError = 'The payload has to be a JSON object.';
  } catch (e) {
    parseError = (e as Error).message;
  }

  const trigger = rule ? TRIGGERS[rule.trigger.type] : null;
  const workflowSteps = (rule?.chain ?? []).filter((a) => a.action === 'run-workflow');

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Run this rule now"
      description="This is a real run, not a preview."
      size="md"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            icon="spark"
            loading={busy}
            disabled={Boolean(parseError)}
            onClick={() => parsed && onRun(parsed)}
          >
            Run for real
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="rounded-xl border border-attention/35 bg-attention/[0.06] px-3 py-2">
          <div className="flex items-start gap-2">
            <Icon name="bell" size={13} className="mt-0.5 shrink-0 text-attention" />
            <div className="min-w-0 text-[11.5px] leading-relaxed text-text-muted">
              <p className="font-medium text-text">Everything this rule does will actually happen.</p>
              <p className="mt-0.5">
                {workflowSteps.length
                  ? 'Its workflow runs through the Capability Fabric exactly as it would on the real trigger. Governed actions above auto-execute will park for your approval.'
                  : 'Its actions run against the open project.'}
                {projectName ? ` Running against ${projectName}.` : ''}
              </p>
            </div>
          </div>
        </div>

        {trigger && (
          <p className="text-[12px] text-text-muted">
            The engine builds a <code className="rounded bg-surface-active px-1">{rule!.trigger.type}</code> event —
            normally raised when {trigger.when} — and evaluates this rule against it.
          </p>
        )}

        {rule && rule.conditions.length > 0 && (
          <div className="rounded-xl border border-line bg-canvas p-3">
            <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-subtle">
              These have to pass
            </h4>
            <ul className="space-y-1">
              {rule.conditions.map((c, i) => (
                <li key={i} className="flex flex-wrap items-center gap-1.5 text-[11.5px]">
                  <code className="rounded bg-surface-active px-1.5 py-0.5 text-[10.5px] text-text">{c.field}</code>
                  <span className="text-text-muted">{CONDITION_OPS[c.op]?.label ?? c.op}</span>
                  {CONDITION_OPS[c.op]?.needsValue && <span className="text-text">{String(c.value ?? '')}</span>}
                </li>
              ))}
            </ul>
            <p className="mt-1.5 text-[10.5px] leading-relaxed text-text-subtle">
              Conditions read the event's payload below. An empty payload means a condition testing a field will not
              pass, and nothing will run.
            </p>
          </div>
        )}

        <label className="block">
          <span className="mb-1 flex items-center gap-2 text-[11px] font-medium text-text">
            Event payload
            {parseError ? <Badge tone="critical">not valid JSON</Badge> : <Badge tone="positive">valid</Badge>}
          </span>
          <textarea
            value={value}
            onChange={(e) => { setTouched(true); setText(e.target.value); }}
            rows={7}
            spellCheck={false}
            aria-label="Event payload"
            className="w-full resize-y rounded-xl border border-line bg-surface px-2.5 py-2 font-mono text-[11.5px] text-text outline-none transition-colors focus:border-accent"
          />
          {parseError && <span className="mt-1 block text-[10.5px] text-danger">{parseError}</span>}
        </label>
      </div>
    </Dialog>
  );
}
