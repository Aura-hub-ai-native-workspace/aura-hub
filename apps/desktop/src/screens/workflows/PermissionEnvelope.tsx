/**
 * PermissionEnvelope — what this workflow can do, and what it cannot.
 * ==================================================================
 * Renders `GET /workflows/:id/envelope` verbatim. The service computes it
 * from the graph and its own capability manifest, which is what keeps
 * risk out of the renderer's hands: this component reads risk, it never
 * derives it, and it never decides policy. The Capability Fabric decides
 * at call time and can only ever be stricter than anything shown here.
 *
 * The "cannot do" sentence is the service's own `cannot` field, shown as
 * prominently as the capability list. A list of granted authority tells
 * you what to fear; only a statement of absent authority lets you stop
 * worrying, and it is the half every permission UI omits.
 */

import { Badge, Icon } from '@aura/ui';
import type { StatusTone } from '@aura/core';
import type { AuthorityEnvelope, CapabilityRisk, EnvelopeCapability, EnvelopeDiff } from '../../ai/aiClient';

export const RISK_TONE: Record<CapabilityRisk, StatusTone> = {
  low: 'positive',
  medium: 'attention',
  high: 'critical',
};

export interface PermissionEnvelopeProps {
  envelope: AuthorityEnvelope | null;
  /** Privilege creep against the last published version, when there is one. */
  diff?: EnvelopeDiff | null;
  /** False once the service could not be read. Null while loading. */
  available: boolean | null;
  labelOf: (nodeId: string) => string;
  onSelectNode?: (nodeId: string) => void;
  variant?: 'full' | 'compact';
}

export function PermissionEnvelope({
  envelope,
  diff,
  available,
  labelOf,
  onSelectNode,
  variant = 'full',
}: PermissionEnvelopeProps) {
  if (available === false || (!envelope && available !== null)) {
    return (
      <div className="rounded-xl border border-attention/40 bg-attention/5 px-4 py-3">
        <div className="flex items-center gap-2">
          <Icon name="shield" size={14} className="text-attention" />
          <span className="text-[12.5px] font-semibold text-text">Permissions unavailable</span>
        </div>
        <p className="mt-1 text-[11.5px] leading-relaxed text-text-muted">
          AURA could not read this workflow's authority envelope from the local service, so what it is permitted to do
          cannot be shown. Nothing is being suppressed — the information is not available. Start the service
          (<code className="rounded bg-surface-active px-1">npm run ai</code>) and reopen this view.
        </p>
      </div>
    );
  }

  if (!envelope) {
    return <div className="h-16 animate-pulse rounded-xl border border-line bg-surface-active/40" aria-label="Reading permissions" />;
  }

  const nothing = !envelope.capabilities.length && !envelope.auraInternalEffects.length;

  return (
    <div className="space-y-3">
      {/* ── privilege creep, when there is any ─────────────────────── */}
      {diff?.widened && (
        <div className="rounded-xl border border-attention/40 bg-attention/5 px-4 py-2.5">
          <div className="flex items-center gap-2">
            <Icon name="bell" size={13} className="text-attention" />
            <span className="text-[12px] font-semibold text-text">This version asks for more than the last one</span>
          </div>
          <p className="mt-1 text-[11.5px] leading-relaxed text-text-muted">{diff.summary}</p>
        </div>
      )}

      {/* ── what it can do ────────────────────────────────────────── */}
      <section className="rounded-xl border border-line bg-canvas">
        <header className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
          <Icon name="shield" size={14} className="text-accent" />
          <span className="text-[12.5px] font-semibold text-text">What this workflow can do</span>
          {envelope.highestRisk && <Badge tone={RISK_TONE[envelope.highestRisk]}>{envelope.highestRisk} risk</Badge>}
          {envelope.hasIrreversible && <Badge tone="critical">irreversible</Badge>}
          {envelope.offlineCapable && <Badge tone="positive">offline-capable</Badge>}
        </header>

        {nothing ? (
          <p className="px-4 py-3 text-[12px] text-text-muted">
            Nothing in this workflow has an effect outside the run. It reads, reasons and presents a result.
          </p>
        ) : (
          <div className="divide-y divide-line">
            {envelope.capabilities.map((c) => (
              <CapabilityRow key={c.capabilityId} cap={c} labelOf={labelOf} onSelectNode={onSelectNode} variant={variant} />
            ))}

            {envelope.auraInternalEffects.length > 0 && (
              <div className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[12.5px] font-medium text-text">Changes inside AURA</span>
                  <Badge tone="neutral">no capability</Badge>
                </div>
                <p className="mt-1 text-[11.5px] leading-relaxed text-text-muted">
                  {envelope.auraInternalEffects.length} node
                  {envelope.auraInternalEffects.length === 1 ? '' : 's'} write to AURA's own storage — memory and notes —
                  rather than to your project. No policy check or audit record covers them.
                </p>
                <NodeChips nodeIds={envelope.auraInternalEffects.map((e) => e.nodeId)} labelOf={labelOf} onSelectNode={onSelectNode} />
              </div>
            )}
          </div>
        )}

        {/* Hosts, when they can be known without running. */}
        {(envelope.hosts.known.length > 0 || envelope.hosts.dynamic) && (
          <div className="border-t border-line px-4 py-2.5">
            <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-text-subtle">Network reach</div>
            {envelope.hosts.known.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {envelope.hosts.known.map((h) => (
                  <code key={h} className="rounded bg-surface-active px-1.5 py-0.5 text-[10.5px] text-text-muted">{h}</code>
                ))}
              </div>
            )}
            {envelope.hosts.dynamic && (
              <p className="mt-1 text-[11px] leading-relaxed text-attention">
                At least one URL is built at run time, so the hosts this workflow contacts cannot be known in advance.
              </p>
            )}
          </div>
        )}
      </section>

      {/* ── what it cannot do ─────────────────────────────────────── */}
      <section className="rounded-xl border border-line bg-canvas px-4 py-3">
        <div className="flex items-center gap-2">
          <Icon name="check" size={14} className="text-positive" />
          <span className="text-[12.5px] font-semibold text-text">What it cannot do</span>
        </div>
        <p className="mt-1 text-[12px] leading-relaxed text-text">{envelope.cannot}</p>
        {variant === 'full' && envelope.notRequested.length > 0 && (
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {envelope.notRequested.map((s) => (
              <span key={s} className="rounded-full bg-surface-active px-2.5 py-0.5 text-[10.5px] text-text-subtle line-through">
                {s}
              </span>
            ))}
          </div>
        )}
      </section>

      {/* ── things the service could not classify ─────────────────── */}
      {envelope.unknownNodes.length > 0 && (
        <div className="rounded-xl border border-danger/35 bg-danger/[0.05] px-4 py-3">
          <div className="flex items-center gap-2">
            <Icon name="close" size={13} className="text-danger" />
            <span className="text-[12px] font-semibold text-text">
              {envelope.unknownNodes.length} node{envelope.unknownNodes.length === 1 ? '' : 's'} this build does not recognise
            </span>
          </div>
          <p className="mt-1 text-[11.5px] leading-relaxed text-text-muted">
            Their authority cannot be described, so this envelope is incomplete. They are listed rather than silently
            ignored: {envelope.unknownNodes.map(labelOf).join(', ')}.
          </p>
        </div>
      )}

      {variant === 'full' && (
        <p className="px-1 text-[10.5px] leading-relaxed text-text-subtle">
          Computed by the local service from this graph and its own capability manifest. The Capability Fabric evaluates
          every call at the moment it happens and can be stricter than this — never looser.
        </p>
      )}
    </div>
  );
}

function CapabilityRow({
  cap,
  labelOf,
  onSelectNode,
  variant,
}: {
  cap: EnvelopeCapability;
  labelOf: (id: string) => string;
  onSelectNode?: (id: string) => void;
  variant: 'full' | 'compact';
}) {
  return (
    <div className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12.5px] font-medium text-text">{cap.name}</span>
        <code className="rounded bg-surface-active px-1.5 py-0.5 text-[10.5px] text-text-muted">{cap.capabilityId}</code>
        <Badge tone={RISK_TONE[cap.risk]}>{cap.risk} risk</Badge>
        {cap.irreversible && <Badge tone="critical">irreversible</Badge>}
      </div>

      {variant === 'full' && cap.permissions.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {cap.permissions.map((p) => (
            <span key={p} className="rounded-full bg-accent-50 px-2.5 py-0.5 text-[10.5px] text-accent-700 dark:bg-accent/15 dark:text-accent-200">
              {p}
            </span>
          ))}
        </div>
      )}

      <NodeChips nodeIds={cap.nodeIds} labelOf={labelOf} onSelectNode={onSelectNode} />
    </div>
  );
}

function NodeChips({
  nodeIds,
  labelOf,
  onSelectNode,
}: {
  nodeIds: string[];
  labelOf: (id: string) => string;
  onSelectNode?: (id: string) => void;
}) {
  if (!nodeIds.length) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {nodeIds.map((id) =>
        onSelectNode ? (
          <button
            key={id}
            onClick={() => onSelectNode(id)}
            className="rounded-md border border-line px-2 py-0.5 text-[10.5px] text-text-muted transition-colors hover:border-accent/50 hover:text-text"
          >
            {labelOf(id)}
          </button>
        ) : (
          <span key={id} className="rounded-md border border-line px-2 py-0.5 text-[10.5px] text-text-muted">
            {labelOf(id)}
          </span>
        ),
      )}
    </div>
  );
}

/** One-line summary for a library card. Leads with what makes you hesitate. */
export function envelopeSummary(env: AuthorityEnvelope): { text: string; tone: 'neutral' | 'info' | 'attention' | 'critical' } {
  if (env.hasIrreversible) return { text: 'irreversible actions', tone: 'critical' };
  if (env.highestRisk === 'high') return { text: 'high-risk actions', tone: 'critical' };
  const scopes = env.scopes.map((s) => s.scope);
  if (scopes.includes('process.execute')) return { text: 'runs commands', tone: 'attention' };
  if (scopes.includes('project.write')) return { text: 'changes your project', tone: 'attention' };
  if (scopes.includes('network.outbound')) return { text: 'reaches the network', tone: 'info' };
  if (env.capabilities.length || env.auraInternalEffects.length) return { text: 'reads only', tone: 'info' };
  return { text: 'no effects outside AURA', tone: 'neutral' };
}
