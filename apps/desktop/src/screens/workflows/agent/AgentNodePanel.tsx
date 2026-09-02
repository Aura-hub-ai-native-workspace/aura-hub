/**
 * AgentNodePanel — the Agentic AI Node surface.
 * ==================================================================
 * ── Availability is the service's answer ──────────────────────────
 * Whether the node can be used is read from `NodeSpecInfo.disabled` on
 * `GET /workflows/specs` — never assumed, never hardcoded either way. If
 * the service marks it disabled this panel says so; if it does not, the
 * panel is a live editor.
 *
 * Everything authoritative is likewise served: `GET /agent/bounds` for the
 * ceilings the runtime clamps to, and `GET /agent/tools` for which
 * capabilities this workflow's agent may be given and the service's own
 * reason for each refusal.
 *
 * A trace appears only when a real run produced one. There is no example
 * trace: showing one as if it were yours would be exactly the failure this
 * surface exists to prevent.
 */

import { useEffect, useState } from 'react';
import { Badge, Icon } from '@aura/ui';
import { AgentContractPanel } from './AgentContractPanel';
import { AgentTrace } from './AgentTrace';
import { aiClient, type NodeSpecInfo } from '../../../ai/aiClient';

import { AGENT_COLOR, AGENT_DEFAULTS, type AgentBounds, type AgentTrace as Trace } from './types';

export interface AgentNodePanelProps {
  /** The workflow whose authority narrows the agent's tools. */
  workflowId: string | null;
  /**
   * The service's own spec for the agent node. `disabled` on it is the
   * single source of truth for availability; `null` means the spec list
   * has not been read yet.
   */
  spec?: NodeSpecInfo | null;
  /** A real trace, once a real run produces one. */
  trace?: Trace | null;
  onClose?: () => void;
}

export function AgentNodePanel({ workflowId, spec = null, trace = null, onClose }: AgentNodePanelProps) {
  const [tab, setTab] = useState<'contract' | 'trace'>('contract');
  const [objective, setObjective] = useState('');
  const [bounds, setBounds] = useState<AgentBounds>(AGENT_DEFAULTS);
  /**
   * Whether the service has a model provider connected.
   *
   * `null` until asked. AURA is BYOAK — it ships no model — so an agent
   * node with no provider behind it will reach the runtime, emit its
   * `intent` beat and stop on the provider's refusal. That is a real,
   * correct failure, but it is a *configuration* problem, and saying so
   * before the run is cheaper than saying it afterwards.
   *
   * Read from `GET /health`, which is the service's own answer, the same
   * way every other surface in this app asks. Nothing here infers a
   * provider's absence from a failed run.
   */
  const [providerReady, setProviderReady] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    aiClient.health()
      .then((h) => alive && setProviderReady(Boolean(h?.key?.configured)))
      // Unreachable is not the same as unconfigured, and this panel has no
      // business guessing which. It simply stays quiet.
      .catch(() => alive && setProviderReady(null));
    return () => { alive = false; };
  }, []);

  // The service decides. `disabled` absent or falsy means usable.
  const gated = spec ? spec.disabled === true : false;
  const specKnown = Boolean(spec);


  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-line px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="grid h-6 w-6 place-items-center rounded-lg" style={{ background: `${AGENT_COLOR}1f`, color: AGENT_COLOR }}>
            <Icon name="spark" size={12} />
          </span>
          <h3 className="text-[13px] font-semibold text-text">Agentic AI Node</h3>
          {specKnown && gated && <Badge tone="neutral">disabled by the service</Badge>}
          {specKnown && !gated && <Badge tone="positive" dot>enabled</Badge>}
          {onClose && (
            <button onClick={onClose} className="ml-auto text-[11px] text-text-subtle hover:text-text">close</button>
          )}
        </div>
        <p className="mt-1 text-[11px] leading-relaxed text-text-muted">
          An AI step with a stated objective, a fixed tool allowlist and hard bounds. Every tool call goes through the
          Capability Fabric — the agent cannot define its own tools and cannot exceed this workflow’s authority.
        </p>
      </header>

      {specKnown && gated && (
        <div className="shrink-0 border-b border-attention/30 bg-attention/[0.06] px-4 py-2">
          <p className="text-[11.5px] leading-relaxed text-text-muted">
            <span className="font-medium text-text">The service reports this node as disabled.</span> It cannot be added
            to a graph. Everything below is still read from the running service — the ceilings the runtime clamps to,
            and the tools this workflow could offer — so the moment the service enables it, this panel is already the
            live editor.
          </p>
        </div>
      )}

      {/* Not a failure, and not styled as one: the node is enabled and its
          contract is real, but nothing behind it can reason yet. Shown
          only when the service actually says so — `null` (unreachable, or
          not yet asked) stays silent rather than guessing. */}
      {specKnown && !gated && providerReady === false && (
        <div className="shrink-0 border-b border-attention/30 bg-attention/[0.06] px-4 py-2">
          <div className="flex items-center gap-2">
            <Icon name="cpu" size={12} className="text-attention" />
            <span className="text-[11.5px] font-medium text-text">No AI provider is connected</span>
          </div>
          <p className="mt-0.5 text-[11px] leading-relaxed text-text-muted">
            AURA ships no model of its own. This node will still run, reach the agent runtime and record its opening
            beat — and then stop, because there is nothing to reason with. Connect a provider in Settings to give it
            one. The bounds and tools below are read from the service and are already correct.
          </p>
        </div>
      )}

      <nav className="flex shrink-0 items-center gap-1 border-b border-line px-3 py-1.5" role="tablist">

        {(['contract', 'trace'] as const).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`rounded-lg px-2.5 py-1 text-[11.5px] font-medium capitalize transition-colors ${
              tab === t ? 'bg-surface-active text-text' : 'text-text-muted hover:text-text'
            }`}
          >
            {t}
            {t === 'contract' && bounds.tools.length > 0 && <span className="ml-1 text-text-subtle">{bounds.tools.length} tools</span>}
          </button>
        ))}
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {tab === 'contract' ? (
          <AgentContractPanel
            objective={objective}
            bounds={bounds}
            workflowId={workflowId}
            readOnly={gated}
            onChange={(next) => { setObjective(next.objective); setBounds(next.bounds); }}
          />
        ) : trace ? (
          <AgentTrace trace={trace} />
        ) : (
          <div className="space-y-3">
            <div className="rounded-xl border border-line bg-canvas p-4">
              <div className="flex items-center gap-2">
                <Icon name="eye" size={13} className="text-text-subtle" />
                <span className="text-[12.5px] font-semibold text-text">No trace to show</span>
              </div>
              <p className="mt-1 text-[11.5px] leading-relaxed text-text-muted">
                {gated
                  ? 'A trace is produced by a running agent. With the node disabled there is nothing to display — and AURA will not show an example run as if it were yours.'
                  : 'A trace appears here once a run of this workflow executes an agent step. Open that run to read its ledger — nothing is shown until one exists.'}
              </p>
            </div>

            <div className="rounded-xl border border-line bg-canvas p-4">
              <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-text-subtle">What the trace will show</h4>
              <ol className="space-y-1.5 text-[11.5px] text-text-muted">
                {[
                  ['Intent', 'the objective, and the context actually sent'],
                  ['Plan', 'the approach for this iteration, before any tool runs'],
                  ['Proposal', 'a named capability with concrete arguments'],
                  ['Permission', 'the Fabric’s decision and the rule behind it — shown even when it auto-executed'],
                  ['Execution', 'duration, audit record, and whether the effect was verified'],
                  ['Observation', 'what came back, quarantined as untrusted data'],
                  ['Decision', 'a claim about what it found'],
                  ['Intervention', 'the approval gate, inline, where the reasoning is'],
                  ['Result', 'the answer, or which bound stopped the loop'],
                ].map(([beat, detail], i) => (
                  <li key={beat} className="flex gap-2">
                    <span className="w-4 shrink-0 font-mono text-[10px] text-text-subtle">{i + 1}</span>
                    <span><span className="font-medium text-text">{beat}</span> — {detail}</span>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
