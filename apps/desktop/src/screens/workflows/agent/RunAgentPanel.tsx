/**
 * RunView — Agent-native panel
 * ==================================================================
 * Shows the agent-native view of a workflow run: what the agent was
 * asked to do, what it planned, how far it got, what it was allowed
 * to do, what it actually did, and how it ended.
 *
 * Everything here is derived from the backend's durable records.
 * No chain-of-thought is rendered — only the beats the service chose
 * to record, the bounds the runtime enforced, and the evidence it
 * collected.
 */

import { useMemo } from 'react';
import { cn } from '@aura/core';
import { Badge, Icon } from '@aura/ui';
import { AgentTrace } from './AgentTrace';

interface AgentRunPanelProps {
  run: any;
  specs: Map<string, any>;
  graphOrder: string[];
  approvals?: any[];
  onDecideApproval?: (id: string, granted: boolean, reason?: string) => void;
  decidingId?: string | null;
  chain?: any[];
  carriedThrough?: Record<string, number>;
}

type LifecycleSignal = 'intent' | 'plan' | 'permission' | 'execution' | 'verification' | 'result';

function agentPhaseFromRun(run: any): LifecycleSignal {
  if (run.state === 'running' || run.state === 'queued') return 'execution';
  if (run.state === 'awaiting-approval') return 'permission';
  if (run.state === 'succeeded') return 'result';
  if (run.state === 'failed' || run.state === 'timed-out') return 'verification';
  if (run.state === 'cancelled' || run.state === 'denied') return 'verification';
  return 'intent';
}

interface Progress {
  total: number;
  succeeded: number;
  failed: number;
  denied: number;
  skipped: number;
}

export function AgentRunPanel({
  run,
  specs,
  approvals = [],
  onDecideApproval,
  decidingId,
  chain,
}: AgentRunPanelProps) {
  const phase = useMemo<LifecycleSignal>(() => agentPhaseFromRun(run), [run.state]);
  const trace = run.agentTrace;
  const isRunning = run.state === 'running' || run.state === 'queued';
  const isTerminal = ['succeeded', 'failed', 'cancelled', 'timed-out', 'denied'].includes(run.state);

  const progress = useMemo<Progress>(() => {
    if (!run.nodes) return { total: 0, succeeded: 0, failed: 0, denied: 0, skipped: 0 };
    const nodes = Object.values(run.nodes) as Array<{ state: string }>;
    return {
      total: nodes.length,
      succeeded: nodes.filter((n) => n.state === 'succeeded').length,
      failed: nodes.filter((n) => n.state === 'failed').length,
      denied: nodes.filter((n) => n.state === 'denied').length,
      skipped: nodes.filter((n) => n.state === 'skipped').length,
    };
  }, [run.nodes]);

  const intent = useMemo<string>(() => {
    if (run.trigger.kind === 'manual') return 'Manual workflow execution';
    if (run.trigger.kind === 'webhook') return `Webhook trigger`;
    if (run.trigger.kind === 'automation') return `Automation rule ${String(run.trigger.ruleId ?? '')}`;
    if (run.trigger.kind === 'resume') return `Resumed from an earlier run leg`;
    return 'Workflow execution';
  }, [run.trigger]);

  const plan = useMemo<Array<{ id: string; label: string; state: string }>>(() => {
    if (!run.nodes) return [];
    return Object.values(run.nodes).map((n: any) => ({
      id: n.nodeId,
      label: specs.get(n.type)?.label ?? n.type,
      state: n.state,
    }));
  }, [run.nodes, specs]);

  const effectiveBounds = {
    maxIterations: (trace as any)?.effectiveBounds?.maxIterations ?? 50,
    timeoutMs: (trace as any)?.effectiveBounds?.timeoutMs ?? 300000,
    maxTokens: (trace as any)?.effectiveBounds?.maxTokens ?? 8000,
  };
  const evidenceCount = run.evidence?.length ?? 0;

  return (
    <div className="flex flex-col h-full min-h-0">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line bg-surface px-4 py-2.5">
        <span className="grid h-6 w-6 place-items-center rounded-lg bg-accent/10 text-accent">
          <Icon name="spark" size={13} />
        </span>
        <span className="text-[12.5px] font-semibold text-text">Agent</span>
        <Badge tone={isRunning ? 'info' : isTerminal ? 'neutral' : 'attention'}>
          {isRunning ? 'Executing' : run.state === 'awaiting-approval' ? 'Waiting for you' : phase}
        </Badge>
        <span className="ml-auto text-[11px] text-text-muted">{progress.total} steps</span>
      </header>

      <section className="border-b border-line px-4 py-3">
        <div className="mb-2 text-[10.5px] font-semibold uppercase tracking-wide text-text-subtle">Intent</div>
        <p className="text-[13px] leading-relaxed text-text">{intent}</p>
      </section>

      <section className="border-b border-line px-4 py-3">
        <div className="mb-2 text-[10.5px] font-semibold uppercase tracking-wide text-text-subtle">Plan</div>
        {plan.length > 0 ? (
          <ol className="space-y-1.5">
            {plan.map((step, i) => (
              <li key={step.id} className="flex items-start gap-2 text-[13px] text-text">
                <span className="shrink-0 text-text-subtle">{i + 1}.</span>
                <span className="min-w-0 flex-1 truncate">{step.label}</span>
                <StatusChipLike state={step.state} />
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-[12px] text-text-subtle">No plan recorded.</p>
        )}
      </section>

      <section className="border-b border-line px-4 py-3">
        <div className="mb-2 text-[10.5px] font-semibold uppercase tracking-wide text-text-subtle">Effective Bounds</div>
        <div className="grid grid-cols-3 gap-3">
          <BoundCard label="Iterations" used={String(run.agentTrace?.iterations ?? 0)} limit={String(effectiveBounds.maxIterations)} />
          <BoundCard
            label="Wall-clock"
            used={run.ms ? `${Math.floor(run.ms / 1000)}s` : '0s'}
            limit={`${Math.floor(effectiveBounds.timeoutMs / 1000)}s`}
          />
          <BoundCard
            label="Tokens"
            used={((run.agentTrace?.tokensUsed ?? 0) / 1000).toFixed(1) + 'K'}
            limit={(effectiveBounds.maxTokens / 1000).toFixed(0) + 'K'}
          />
        </div>
      </section>

      <section className="border-b border-line px-4 py-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[10.5px] font-semibold uppercase tracking-wide text-text-subtle">Agent Trace</span>
          <span className="rounded bg-surface-active px-2 py-0.5 text-[11px] text-text-subtle">
            {(trace as any)?.beats?.length ?? 0} beats
          </span>
        </div>
        {trace && (trace as any).beats ? (
          <AgentTrace
            trace={(trace as unknown) as Parameters<typeof AgentTrace>[0]['trace']}
            running={isRunning}
            approvals={approvals}
            onDecideApproval={onDecideApproval}
            decidingId={decidingId}
          />
        ) : (
          <p className="mt-2 text-[12px] text-text-muted">No agent trace recorded for this run.</p>
        )}
      </section>

      <section className="border-b border-line px-4 py-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[10.5px] font-semibold uppercase tracking-wide text-text-subtle">Verification & Evidence</span>
        </div>
        <p className="text-[12px] text-text-muted">{evidenceCount} evidence record(s) linked to this run.</p>
      </section>

      {chain && chain.length > 1 && (
        <section className="border-b border-line px-4 py-3">
          <div className="mb-2 text-[10.5px] font-semibold uppercase tracking-wide text-text-subtle">Execution Chain</div>
          <ul className="space-y-1.5">
            {chain.map((c) => (
              <li key={c.id} className="rounded-lg border border-line bg-surface p-3">
                <div className="flex items-center justify-between">
                  <span className="truncate text-[13px] font-medium text-text">{c.workflowName}</span>
                  <StatusChipLike state={c.state} />
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function BoundCard({ label, used, limit }: { label: string; used: string; limit: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface p-3">
      <div className="text-[10px] font-medium uppercase tracking-wide text-text-subtle">{label}</div>
      <div className="mt-1 text-[16px] font-semibold tabular-nums text-text">
        {used} / {limit}
      </div>
      <div className="mt-0.5 text-[10.5px] text-text-subtle">limit {limit}</div>
    </div>
  );
}

function StatusChipLike({ state }: { state: string }) {
  const tone =
    state === 'succeeded' || state === 'completed'
      ? 'bg-positive/10 text-positive'
      : state === 'failed' || state === 'timed-out'
        ? 'bg-danger/10 text-danger'
        : state === 'awaiting-approval' || state === 'denied'
          ? 'bg-attention/10 text-attention'
          : 'bg-surface-active text-text-muted';
  return (
    <span className={cn('inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10.5px] font-medium', tone)}>
      {state}
    </span>
  );
}
