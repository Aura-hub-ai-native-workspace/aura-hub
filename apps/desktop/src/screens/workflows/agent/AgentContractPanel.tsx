/**
 * AgentContractPanel — the agent node at author time.
 * ==================================================================
 * Not a settings form. An agent is the only node whose behaviour is not
 * knowable when you place it, so what you author is a *contract*: an
 * objective, an allowlist, and bounds.
 *
 * Everything authoritative here is read from the service:
 *
 *   • `GET /agent/bounds` — the defaults and the ceilings the runtime
 *     clamps to. The panel shows the **effective** value beside anything
 *     the runtime would lower, because a number that will be clamped is a
 *     number that misdescribes what will happen.
 *   • `GET /agent/tools?workflowId=` — which capabilities an agent in
 *     *this* workflow could actually be given, and the service's own
 *     reason for every refusal. The renderer never decides which tools
 *     are permissible; deciding that would be deciding authority.
 */

import { useEffect, useMemo, useState } from 'react';
import { Badge, Icon, Input } from '@aura/ui';
import { aiClient, type AgentBoundsContract, type AgentToolsResult } from '../../../ai/aiClient';
import { RISK_TONE } from '../PermissionEnvelope';
import { AGENT_COLOR, type AgentBounds } from './types';

export interface AgentContractPanelProps {
  objective: string;
  bounds: AgentBounds;
  /** The workflow whose authority narrows the agent's tools. */
  workflowId: string | null;
  onChange?: (next: { objective: string; bounds: AgentBounds }) => void;
  readOnly?: boolean;
}

/** Worst case, stated plainly, using the bounds that would actually apply. */
function worstCase(b: AgentBounds): string {
  return [
    `up to ${b.maxIterations} iteration${b.maxIterations === 1 ? '' : 's'}`,
    `up to ${Math.round(b.timeoutMs / 1000)}s`,
    `up to ${(b.maxTokens / 1000).toFixed(1)}K tokens`,
    `stops after ${b.maxConsecutiveFailures} failures in a row`,
  ].join(' · ');
}

export function AgentContractPanel({ objective, bounds, workflowId, onChange, readOnly }: AgentContractPanelProps) {
  const [contract, setContract] = useState<{ defaults: AgentBoundsContract; ceilings: AgentBoundsContract } | null>(null);
  const [tools, setTools] = useState<AgentToolsResult | null>(null);
  const [toolsError, setToolsError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void aiClient.agentBounds().then((c) => { if (live) setContract(c); }).catch(() => { if (live) setContract(null); });
    return () => { live = false; };
  }, []);

  // The selectable set is the service's answer for this workflow, not a
  // filter the renderer applies to the manifest.
  useEffect(() => {
    if (!workflowId) { setTools(null); return; }
    let live = true;
    void aiClient
      .agentTools(workflowId)
      .then((r) => {
        if (!live) return;
        if ('error' in r) { setTools(null); setToolsError(r.error); }
        else { setTools(r); setToolsError(null); }
      })
      .catch((e) => { if (live) { setTools(null); setToolsError((e as Error).message); } });
    return () => { live = false; };
  }, [workflowId]);

  const ceilings = contract?.ceilings ?? null;

  /** What the runtime would actually enforce, after clamping. */
  const effective: AgentBounds = useMemo(() => {
    if (!ceilings) return bounds;
    return {
      ...bounds,
      maxIterations: Math.min(bounds.maxIterations, ceilings.maxIterations),
      timeoutMs: Math.min(bounds.timeoutMs, ceilings.timeoutMs),
      maxTokens: Math.min(bounds.maxTokens, ceilings.maxTokens),
      maxConsecutiveFailures: Math.min(bounds.maxConsecutiveFailures, ceilings.maxConsecutiveFailures),
    };
  }, [bounds, ceilings]);

  const setBound = <K extends keyof AgentBounds>(key: K, value: AgentBounds[K]) =>
    onChange?.({ objective, bounds: { ...bounds, [key]: value } });

  const selected = new Set(bounds.tools);
  const allowed = tools?.allowed ?? [];
  const refused = tools?.refused ?? [];
  const enabledCount = allowed.filter((id) => selected.has(id)).length;

  const toggle = (id: string, on: boolean) =>
    onChange?.({ objective, bounds: { ...bounds, tools: on ? [...bounds.tools, id] : bounds.tools.filter((t) => t !== id) } });

  return (
    <div className="space-y-4">
      <Block icon="spark" title="Task" hint="What this agent is for.">
        <textarea
          value={objective}
          readOnly={readOnly}
          onChange={(e) => onChange?.({ objective: e.target.value, bounds })}
          rows={3}
          placeholder="Triage the changed files and identify duplicated route handlers."
          aria-label="Agent task"
          className="w-full resize-y rounded-xl border border-line bg-surface px-2.5 py-2 text-[12px] text-text outline-none transition-colors placeholder:text-text-subtle focus:border-accent read-only:opacity-70"
        />
      </Block>

      {/* ── tools ─────────────────────────────────────────────────── */}
      <Block
        icon="shield"
        title="Tools"
        hint="Narrowed by the service to this workflow's own authority. The agent cannot define its own."
      >
        {!workflowId ? (
          <p className="text-[11.5px] text-text-muted">Open a workflow to see which tools its agent could be given.</p>
        ) : toolsError ? (
          <p className="text-[11.5px] text-attention">
            The service could not report this workflow's tools — {toolsError}. Nothing is being hidden; the answer is
            unavailable.
          </p>
        ) : !tools ? (
          <div className="h-12 animate-pulse rounded-lg bg-surface-active/40" aria-label="Reading available tools" />
        ) : (
          <>
            <ul className="divide-y divide-line/60">
              {allowed.map((id) => {
                const described = tools.describe.find((d) => d.name === id);
                const cap = tools.envelope.capabilities.find((c) => c.capabilityId === id);
                return (
                  <li key={id} className="py-1.5">
                    <div className="flex items-center gap-2.5">
                      <input
                        type="checkbox"
                        checked={selected.has(id)}
                        disabled={readOnly}
                        onChange={(e) => toggle(id, e.target.checked)}
                        className="h-3.5 w-3.5 accent-[var(--accent)]"
                        aria-label={id}
                      />
                      <span className="min-w-0 flex-1 truncate text-[12px] text-text">{cap?.name ?? id}</span>
                      <code className="shrink-0 rounded bg-surface-active px-1.5 py-0.5 text-[10px] text-text-muted">{id}</code>
                      {cap && <Badge tone={RISK_TONE[cap.risk]}>{cap.risk}</Badge>}
                    </div>
                    {described?.description && (
                      <p className="ml-6 mt-0.5 text-[10.5px] text-text-subtle">{described.description}</p>
                    )}
                  </li>
                );
              })}
              {!allowed.length && (
                <li className="py-2 text-[11.5px] text-text-muted">
                  This workflow has no governed capability, so its agent can only reason and answer.
                </li>
              )}
            </ul>

            {refused.length > 0 && (
              <div className="mt-2.5 rounded-lg border border-line bg-surface px-2.5 py-2">
                <div className="text-[10.5px] font-semibold uppercase tracking-wide text-text-subtle">
                  Refused by the service ({refused.length})
                </div>
                <ul className="mt-1 space-y-1">
                  {refused.map((r) => (
                    <li key={r.capabilityId} className="text-[10.5px] leading-relaxed text-text-muted">
                      <code className="rounded bg-surface-active px-1 text-text-subtle line-through">{r.capabilityId}</code>{' '}
                      {r.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
        <p className="mt-2 text-[10.5px] leading-relaxed text-text-subtle">
          The service enforces this list as a subset of the workflow's authority, refuses anything irreversible, and
          refuses anything needing a human-only scope. Every surviving tool is still evaluated, gated and audited on
          every call.
        </p>
      </Block>

      {/* ── bounds ────────────────────────────────────────────────── */}
      <Block icon="cpu" title="Bounds" hint="What makes this node safe to run unattended.">
        <div className="grid grid-cols-2 gap-3">
          <NumberField
            label="Max iterations"
            value={bounds.maxIterations}
            effective={effective.maxIterations}
            ceiling={ceilings?.maxIterations}
            readOnly={readOnly}
            onChange={(v) => setBound('maxIterations', v)}
          />
          <NumberField
            label="Timeout (seconds)"
            value={Math.round(bounds.timeoutMs / 1000)}
            effective={Math.round(effective.timeoutMs / 1000)}
            ceiling={ceilings ? Math.round(ceilings.timeoutMs / 1000) : undefined}
            readOnly={readOnly}
            onChange={(v) => setBound('timeoutMs', v * 1000)}
          />
          <NumberField
            label="Token budget"
            value={bounds.maxTokens}
            effective={effective.maxTokens}
            ceiling={ceilings?.maxTokens}
            step={500}
            readOnly={readOnly}
            onChange={(v) => setBound('maxTokens', v)}
          />
          <NumberField
            label="Failures in a row"
            value={bounds.maxConsecutiveFailures}
            effective={effective.maxConsecutiveFailures}
            ceiling={ceilings?.maxConsecutiveFailures}
            readOnly={readOnly}
            onChange={(v) => setBound('maxConsecutiveFailures', v)}
          />
        </div>

        <div className="mt-3 rounded-xl border px-3 py-2" style={{ borderColor: `${AGENT_COLOR}55`, background: `${AGENT_COLOR}0f` }}>
          <div className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: AGENT_COLOR }}>
            Worst case, as the runtime would enforce it
          </div>
          <p className="mt-0.5 text-[12px] text-text">{worstCase(effective)}</p>
          <p className="mt-1 text-[10.5px] leading-relaxed text-text-muted">
            {enabledCount === 0
              ? 'No tools are enabled, so this agent can only reason and answer.'
              : `It may call ${enabledCount} tool${enabledCount === 1 ? '' : 's'}, each evaluated by the Capability Fabric at the moment it is called.`}
          </p>
        </div>

        {ceilings && (
          <p className="mt-2 text-[10.5px] leading-relaxed text-text-subtle">
            The service clamps every configuration to its ceilings — {ceilings.maxIterations} iterations,{' '}
            {Math.round(ceilings.timeoutMs / 60_000)} minutes, {(ceilings.maxTokens / 1000).toFixed(0)}K tokens — because
            a bound a definition can raise is not a bound. These ceilings are read from the service, not assumed here.
          </p>
        )}
      </Block>

      <Block icon="bug" title="How it can end" hint="Three ports, because an agent legitimately ends three ways.">
        <ul className="space-y-1.5 text-[11.5px]">
          <li><code className="rounded bg-surface-active px-1.5 py-0.5 text-[10.5px]">done</code> <span className="text-text-muted">— it produced an answer.</span></li>
          <li><code className="rounded bg-surface-active px-1.5 py-0.5 text-[10.5px]">needs-human</code> <span className="text-text-muted">— parked on an approval, or refused by policy. Not a failure.</span></li>
          <li><code className="rounded bg-surface-active px-1.5 py-0.5 text-[10.5px]">failed</code> <span className="text-text-muted">— it hit a bound, or a terminal error.</span></li>
        </ul>
      </Block>
    </div>
  );
}

/* ── pieces ────────────────────────────────────────────────────────── */

function Block({
  icon,
  title,
  hint,
  children,
}: {
  icon: 'spark' | 'shield' | 'cpu' | 'bug';
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-line bg-canvas p-3">
      <header className="mb-2">
        <div className="flex items-center gap-2">
          <Icon name={icon} size={13} style={{ color: AGENT_COLOR }} />
          <h4 className="text-[12.5px] font-semibold text-text">{title}</h4>
        </div>
        <p className="mt-0.5 text-[10.5px] leading-relaxed text-text-subtle">{hint}</p>
      </header>
      {children}
    </section>
  );
}

/**
 * A bound, with the value the runtime would actually enforce.
 *
 * When a configured value exceeds the ceiling the field says so instead of
 * silently accepting a number that will be lowered — a form that takes 1000
 * and runs 25 has told the author something untrue.
 */
function NumberField({
  label,
  value,
  effective,
  ceiling,
  step = 1,
  readOnly,
  onChange,
}: {
  label: string;
  value: number;
  effective: number;
  ceiling?: number;
  step?: number;
  readOnly?: boolean;
  onChange: (v: number) => void;
}) {
  const clamped = effective !== value;
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium text-text">
        {label}{' '}
        <span className="text-text-subtle">{ceiling === undefined ? '· reading ceiling…' : `· max ${ceiling}`}</span>
      </span>
      <Input
        type="number"
        inputSize="sm"
        value={String(value)}
        min={1}
        max={ceiling}
        step={step}
        readOnly={readOnly}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {clamped && (
        <span className="mt-1 flex items-center gap-1 text-[10.5px] text-attention">
          <Icon name="bell" size={9} />
          the runtime would use {effective}
        </span>
      )}
    </label>
  );
}
