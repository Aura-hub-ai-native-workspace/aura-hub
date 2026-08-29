/**
 * RunView — what is happening now, what happened, what is waiting.
 * ==================================================================
 * One component for a live run and for one read back from the service.
 * A historical run is not a downgraded view: it renders in the same
 * instrument, so the skill of reading a run transfers between them.
 *
 * Five things it is careful about:
 *
 *   • Every wait states its cause. "Running…" is not enough.
 *   • Denied is not failed. A node the policy engine refused is the
 *     system working, and is toned so it can never read as a bug.
 *   • Cancelled is not failed either. The user's own decision is not an
 *     error.
 *   • Evidence is the service's audit references, not a retelling. Where
 *     a capability has no mechanical check, it says so.
 *   • Resumability is read from the record, never inferred.
 */

import { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { Badge, Button, Icon, IconButton } from '@aura/ui';
import type { IconName } from '@aura/ui';
import type { EvidenceRef, NodeRunRecord, NodeSpecInfo, NodeState, WorkflowRun, WorkflowRunSummary } from '../../ai/aiClient';

import type { ApprovalRequest } from '../../ai/fabricClient';
import { AiMarkdown } from '../../ai/AiMarkdown';
import { ApprovalGate } from '../missions/ApprovalGate';
import { CATEGORY } from './shared';
import { AgentTrace } from './agent/AgentTrace';
import { AgentRunPanel } from './agent/RunAgentPanel';
import { isPartialTrace, type AgentTrace as AgentTraceShape, type AnyAgentTrace } from './agent/types';
import { nodeEffect } from './effects';
import {
  NODE_STATE_LABEL,
  NODE_STATE_TONE,
  RUN_STATE_LABEL,
  RUN_STATE_TONE,
  TRIGGER_LABEL,
  elapsedMs,
  fmtDuration,
  orderedNodes,
  progressOf,
  runStateLabel,
  runStateTone,
} from './runs';


type Tab = 'steps' | 'output' | 'evidence' | 'logs' | 'agent';

const STATE_ICON: Record<NodeState, IconName> = {
  queued: 'dot',
  running: 'activity',
  'awaiting-approval': 'shield',
  succeeded: 'check',
  failed: 'close',
  denied: 'shield',
  skipped: 'more',
  cancelled: 'close',
  'timed-out': 'bell',
};

/** Why a node is waiting, in the node's own terms. */
function waitReason(node: NodeRunRecord, spec?: NodeSpecInfo): string {
  if (node.state === 'awaiting-approval') {
    return node.approval
      ? `waiting for you to authorize ${node.approval.capabilityId}`
      : 'waiting for you to authorize a governed action';
  }
  if (node.type === 'delay') return 'waiting — this node is a deliberate pause';
  if (nodeEffect(node.type, spec).needsNetwork) return 'waiting on the network';
  return 'running';
}

export interface RunViewProps {
  run: WorkflowRun;
  specs: Map<string, NodeSpecInfo>;
  /** Graph order, so queued nodes list in a stable, meaningful sequence. */
  graphOrder: string[];
  approvals?: ApprovalRequest[];
  onDecideApproval?: (id: string, granted: boolean, reason?: string) => void;
  decidingId?: string | null;
  onFocusNode?: (nodeId: string) => void;
  onCancel?: () => void;
  onResume?: () => void;
  onRerun?: () => void;
  onClose?: () => void;
  /**
   * Every leg of this logical execution, oldest first, when the run is
   * part of a chain. Fetched by whoever can open a run, because this view
   * renders a record rather than going looking for one.
   */
  chain?: WorkflowRunSummary[];
  onOpenRun?: (runId: string) => void;
  /**
   * Per node, the highest beat `seq` the previous leg reached — so a
   * resumed agent's ledger can show where the carried-forward reasoning
   * ends and this run's own work begins. Absent when there is no previous
   * leg, or when it could not be read: no marker beats a wrong one.
   */
  carriedThrough?: Record<string, number>;
}

export function RunView({
  run,
  specs,
  graphOrder,
  approvals = [],
  onDecideApproval,
  decidingId,
  onFocusNode,
  onCancel,
  onResume,
  onRerun,
  onClose,
  chain,
  onOpenRun,
  carriedThrough,
}: RunViewProps) {
  const [tab, setTab] = useState<Tab>('steps');
  const [now, setNow] = useState(() => Date.now());
  const live = run.state === 'running' || run.state === 'queued';

  useEffect(() => {
    if (!live) return;
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [live]);

  const progress = useMemo(() => progressOf(run), [run]);
  const ordered = useMemo(() => orderedNodes(run, graphOrder), [run, graphOrder]);
  const total = elapsedMs(run, now);
  const slowest = Math.max(1, ...Object.values(run.nodes).map((n) => n.ms || 0));
  const labelOf = (type: string) => specs.get(type)?.label ?? type;

  // The service parks a node on an approval and records its request id;
  // matching by that id is what keeps this from being a second store.
  const parked = ordered.filter((n) => n.state === 'awaiting-approval' && n.approval);
  const parkedRequests = parked
    .map((n) => approvals.find((a) => a.id === n.approval!.requestId))
    .filter((a): a is ApprovalRequest => Boolean(a) && a!.state === 'pending');

  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas">
      {/* ── header ──────────────────────────────────────────────── */}
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line px-4 py-2.5">
        <span className="flex items-center gap-2">
          {live ? (
            <motion.span animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1.1, ease: 'linear' }} className="text-accent">
              <Icon name="activity" size={13} />
            </motion.span>
          ) : (
            <Icon
              name={run.state === 'succeeded' ? 'check' : run.state === 'awaiting-approval' ? 'shield' : run.state === 'cancelled' ? 'bell' : 'close'}
              size={13}
              className={
                run.state === 'succeeded' ? 'text-positive'
                  : run.state === 'cancelled' || run.state === 'awaiting-approval' ? 'text-attention'
                  : 'text-danger'
              }
            />
          )}
          <Badge tone={RUN_STATE_TONE[run.state]}>{RUN_STATE_LABEL[run.state]}</Badge>
        </span>

        <span className="text-[12px] text-text-muted">
          {progress.succeeded}/{progress.total} steps
          {progress.failed > 0 && <span className="text-danger"> · {progress.failed} failed</span>}
          {progress.denied > 0 && <span className="text-attention"> · {progress.denied} denied</span>}
          {progress.skipped > 0 && <span className="text-text-subtle"> · {progress.skipped} skipped</span>}
        </span>

        <span className="text-[12px] tabular-nums text-text-muted">{fmtDuration(total)}</span>

        {progress.current && (
          <span className="flex items-center gap-1.5 text-[12px] text-text">
            <span className="text-text-subtle">now:</span>
            <span className="font-medium">{labelOf(progress.current.type)}</span>
            <span className={progress.current.state === 'awaiting-approval' ? 'text-attention' : 'text-text-muted'}>
              — {waitReason(run.nodes[progress.current.nodeId], specs.get(progress.current.type))}
            </span>
          </span>
        )}

        <div className="ml-auto flex items-center gap-1.5">
          {run.versionId && (
            <span className="hidden rounded bg-surface-active px-1.5 py-0.5 font-mono text-[10px] text-text-subtle md:inline" title="The immutable version this run executed">
              {run.versionId}
            </span>
          )}
          {live && onCancel && <Button size="sm" variant="danger" icon="close" onClick={onCancel}>Cancel</Button>}
          {!live && run.resumable && onResume && (
            <Button size="sm" variant="secondary" icon="refresh" onClick={onResume}>Resume</Button>
          )}
          {!live && onRerun && <Button size="sm" variant="ghost" icon="spark" onClick={onRerun}>Run again</Button>}
          {onClose && <IconButton icon="close" label="Hide the run panel" size="sm" onClick={onClose} />}
        </div>
      </header>

      {/* ── the run's own headline ───────────────────────────────── */}
      {(run.state === 'failed' || run.state === 'timed-out') && (
        <Notice tone="danger" icon="close" title={run.state === 'timed-out' ? 'This run ran out of time.' : 'This run failed.'}>
          {run.error && <p className="mt-0.5 break-words text-[11.5px] leading-relaxed text-text-muted">{run.error}</p>}
          <p className="mt-1 text-[10.5px] text-text-subtle">
            Steps that completed before it stopped have already had their effect. AURA does not undo them.
          </p>
        </Notice>
      )}
      {run.state === 'cancelled' && (
        <Notice tone="attention" icon="bell" title="This run was cancelled.">
          <p className="mt-0.5 text-[11.5px] leading-relaxed text-text-muted">
            {run.error ?? 'Stopped before it finished.'}
          </p>
        </Notice>
      )}
      {/* The service models a resume as a NEW run that references the one
          it continues, so both records exist and the earlier one stays
          parked. Saying so is the difference between an honest history and
          a run that looks stuck forever. */}
      {run.trigger.kind === 'resume' && typeof run.trigger.of === 'string' && (
        <Notice tone="neutral" icon="refresh" title="This run continues an earlier one.">
          <p className="mt-0.5 text-[11.5px] leading-relaxed text-text-muted">
            It picked up from{' '}
            <code className="rounded bg-surface-active px-1">{String(run.trigger.of)}</code>, which stays in the
            history as the account of where it stopped — marked continued, and no longer waiting on anyone. The agent
            kept its transcript and the budget it had already spent, so resuming did not restart the clock or reset
            its bounds. Actions that leg caused are recorded against it, not against this run.

          </p>
        </Notice>
      )}
      {/* A superseded leg is NOT waiting on anybody. Its state stays
          `awaiting-approval` because that is the honest account of how it
          ended, so the difference between "still parked" and "already
          continued" has to be drawn from the chain rather than the state —
          otherwise finished work keeps asking to be approved. */}
      {run.state === 'awaiting-approval' && !live && !run.supersededBy && (
        <Notice tone="attention" icon="shield" title="Parked, waiting on a decision.">
          <p className="mt-0.5 text-[11.5px] leading-relaxed text-text-muted">
            Approving the request below records your decision; the service then continues the work as a linked resume
            run rather than reopening this record. This one stays as the account of where it stopped.
          </p>
        </Notice>
      )}
      {run.supersededBy && (
        <Notice tone="neutral" icon="refresh" title="This run was continued as another run.">
          <p className="mt-0.5 text-[11.5px] leading-relaxed text-text-muted">
            Its question has been answered and the work was picked up by{' '}
            <code className="rounded bg-surface-active px-1">{run.supersededBy}</code>
            {run.supersededAt && <> on {new Date(run.supersededAt).toLocaleString()}</>}. Nothing here is waiting on
            you. This record stays as the account of the leg that stopped, and the actions it lists are the ones{' '}
            <em>it</em> caused — what happened next is recorded against the run that continued it.
          </p>
        </Notice>
      )}

      {!live && !run.resumable && run.notResumableReason && run.state !== 'succeeded' && (
        <Notice tone="neutral" icon="eye" title="This run cannot be resumed.">
          <p className="mt-0.5 text-[11.5px] leading-relaxed text-text-muted">{run.notResumableReason}</p>
        </Notice>
      )}

      {/* ── the whole execution, when it took more than one run ──── */}
      {chain && chain.length > 1 && <ChainStrip chain={chain} currentId={run.id} onOpenRun={onOpenRun} />}

      {/* ── approvals parked on this run ─────────────────────────── */}

      {parkedRequests.length > 0 && onDecideApproval && (
        <div className="border-b border-line px-4 py-2.5">
          <div className="mb-1.5 flex items-center gap-2">
            <Icon name="shield" size={13} className="text-attention" />
            <span className="text-[12px] font-semibold text-text">
              {parkedRequests.length === 1 ? 'This run is waiting on your authorization' : `${parkedRequests.length} actions need your authorization`}
            </span>
          </div>
          <div className="space-y-2">
            {parkedRequests.map((a) => (
              <ApprovalGate key={a.id} request={a} busy={decidingId === a.id} onDecide={onDecideApproval} />
            ))}
          </div>
        </div>
      )}

      {/* ── tabs ────────────────────────────────────────────────── */}
      <nav className="flex shrink-0 items-center gap-1 border-b border-line px-3 py-1.5" role="tablist">
        <TabButton id="steps" tab={tab} setTab={setTab} label="Steps" count={progress.total} />
        <TabButton id="output" tab={tab} setTab={setTab} label="Output" count={run.outputs.length} />
        <TabButton id="evidence" tab={tab} setTab={setTab} label="Evidence" count={run.evidence.length} />
        <TabButton id="logs" tab={tab} setTab={setTab} label="Logs" count={run.log.length} />
        <TabButton id="agent" tab={tab} setTab={setTab} label="Agent" />
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'steps' && (
          <ol className="divide-y divide-line/60">
            {ordered.map((n) => (
              <StepRow
                key={n.nodeId}
                node={n}
                spec={specs.get(n.type)}
                slowest={slowest}
                onFocus={onFocusNode}
                approvals={approvals}
                onDecideApproval={onDecideApproval}
                decidingId={decidingId}
                carriedThrough={carriedThrough?.[n.nodeId]}
              />
            ))}
            {!ordered.length && <EmptyNote text="This run has no steps yet." />}
          </ol>
        )}

        {tab === 'output' && (
          <div className="space-y-4 px-4 py-3">
            {run.outputs.length ? (
              run.outputs.map((o, i) => (
                <div key={`${o.nodeId}-${i}`}>
                  <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-subtle">
                    <Icon name="panel" size={11} /> {o.title}
                  </div>
                  <div className="selectable rounded-xl border border-line bg-surface p-3 text-[12.5px]">
                    <AiMarkdown source={o.text} />
                  </div>
                </div>
              ))
            ) : (
              <EmptyNote text={live ? 'Waiting for an Output node to produce a result…' : 'This run produced no Output nodes.'} />
            )}
          </div>
        )}

        {tab === 'evidence' && <Evidence run={run} specs={specs} total={total} live={live} />}

        {tab === 'logs' && (
          <div className="selectable space-y-0.5 px-4 py-3 font-mono text-[11px]">
            {run.log.length ? (
              run.log.map((l, i) => (
                <div key={i} className={l.level === 'error' ? 'text-danger' : l.level === 'warn' ? 'text-attention' : 'text-text-muted'}>
                  <span className="text-text-subtle">{new Date(l.at).toLocaleTimeString()} </span>
                  {l.nodeId ? `[${labelOf(run.nodes[l.nodeId]?.type ?? '')}] ` : ''}
                  {l.text}
                </div>
              ))
            ) : (
              <EmptyNote text="No log lines." />
            )}
          </div>
        )}

        {tab === 'agent' && (
          <AgentRunPanel
            run={run}
            specs={specs}
            graphOrder={graphOrder}
            approvals={approvals}
            onDecideApproval={onDecideApproval}
            decidingId={decidingId}
            chain={chain}
            carriedThrough={carriedThrough}
          />
        )}
      </div>
    </div>
  );
}

/* ── pieces ────────────────────────────────────────────────────────── */

function Notice({
  tone,
  icon,
  title,
  children,
}: {
  tone: 'danger' | 'attention' | 'neutral';
  icon: IconName;
  title: string;
  children?: React.ReactNode;
}) {
  const cls =
    tone === 'danger' ? 'border-danger/25 bg-danger/[0.06]'
      : tone === 'attention' ? 'border-attention/25 bg-attention/[0.06]'
      : 'border-line bg-surface';
  const ic = tone === 'danger' ? 'text-danger' : tone === 'attention' ? 'text-attention' : 'text-text-subtle';
  return (
    <div className={`border-b px-4 py-2 ${cls}`}>
      <div className="flex items-start gap-2">
        <Icon name={icon} size={13} className={`mt-0.5 shrink-0 ${ic}`} />
        <div className="min-w-0">
          <p className="text-[12px] font-medium text-text">{title}</p>
          {children}
        </div>
      </div>
    </div>
  );
}

function TabButton({ id, tab, setTab, label, count }: { id: Tab; tab: Tab; setTab: (t: Tab) => void; label: string; count?: number }) {
  const active = tab === id;
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={() => setTab(id)}
      className={`rounded-lg px-2.5 py-1 text-[11.5px] font-medium transition-colors ${active ? 'bg-surface-active text-text' : 'text-text-muted hover:text-text'}`}
    >
      {label}
      {count !== undefined && count > 0 && <span className="ml-1 text-text-subtle">{count}</span>}
    </button>
  );
}

/**
 * One logical execution, drawn as the several records it really is.
 *
 * The chain is not a cosmetic grouping: each leg has its own version, its
 * own wall clock and its own partition of the audit trail, and evidence is
 * never copied between them. So the strip shows the legs rather than
 * merging them, and says which one you are reading — a merged view would
 * imply a single record that does not exist, and would double-count
 * effects the moment anyone tried to total them.
 */
function ChainStrip({
  chain,
  currentId,
  onOpenRun,
}: {
  chain: WorkflowRunSummary[];
  currentId: string;
  onOpenRun?: (runId: string) => void;
}) {
  return (
    <div className="border-b border-line bg-surface/40 px-4 py-2">
      <div className="flex items-center gap-1.5">
        <Icon name="refresh" size={11} className="text-text-subtle" />
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.09em] text-text-subtle">
          One execution, {chain.length} legs
        </span>
      </div>
      <ol className="mt-1.5 flex flex-wrap items-center gap-1">
        {chain.map((leg, i) => {
          const current = leg.id === currentId;
          const body = (
            <span className="flex items-center gap-1.5">
              <span className="text-[10px] tabular-nums text-text-subtle">{i + 1}</span>
              <Badge tone={runStateTone(leg)}>{runStateLabel(leg)}</Badge>
              <span className="font-mono text-[10px] text-text-subtle">{leg.id.slice(0, 8)}</span>
            </span>
          );
          return (
            <li key={leg.id} className="flex items-center gap-1">
              {i > 0 && <Icon name="chevron-right" size={10} className="text-text-subtle" />}
              {current || !onOpenRun ? (
                <span
                  aria-current={current ? 'true' : undefined}
                  className={`rounded-lg px-2 py-1 ${current ? 'bg-surface-active ring-1 ring-accent/40' : ''}`}
                >
                  {body}
                  {current && <span className="ml-1.5 text-[10px] text-accent">you are here</span>}
                </span>
              ) : (
                <button
                  onClick={() => onOpenRun(leg.id)}
                  className="rounded-lg px-2 py-1 transition-colors hover:bg-surface-hover"
                  title={`Open leg ${i + 1} of this execution`}
                >
                  {body}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/**
 * Narrow the run record's `agentTrace`.

 *
 * The service types it `unknown` so its run module need not depend on the
 * agent module. This is the one place it is narrowed, and it checks the
 * fields the renderer actually reads rather than casting and hoping.
 */
function asAgentTrace(v: unknown): AnyAgentTrace | null {
  if (!v || typeof v !== 'object') return null;
  const t = v as Omit<Partial<AgentTraceShape>, 'partial'> & { partial?: boolean };
  if (!Array.isArray(t.beats)) return null;

  // A snapshot of a ledger still being written: beats, and nothing else.
  // It is a real record, not a malformed one, so it is narrowed to the
  // partial shape rather than rejected — rejecting it is what made a
  // reader that connected mid-agent see nothing at all until the node
  // ended.
  if (t.partial === true) return { partial: true, beats: t.beats };
  return t.effectiveBounds && typeof t.stopReason === 'string' ? (t as AgentTraceShape) : null;
}


/**
 * One redacted, bounded payload — what a step received, or what it emitted.
 *
 * The service redacts and truncates before writing the record, so this
 * renders what it was given and says when something was cut rather than
 * implying it has the whole value. There is no "reveal" affordance,
 * because there is no contract behind one: a secret is not hidden here,
 * it was never written here.
 */
function Payload({
  title,
  hint,
  text,
  truncated,
  files,
  provenance,
  from,
  port,
}: {
  title: string;
  hint: string;
  text: string;
  truncated?: boolean;
  files?: string[];
  provenance?: string;
  from?: string[];
  port?: string;
}) {
  const empty = !text?.trim();
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10.5px] font-semibold uppercase tracking-wide text-text-subtle">{title}</span>
        {provenance && (
          <span title="Where this value came from, as the service classified it">
            <Badge tone="neutral">{provenance}</Badge>
          </span>
        )}

        {port && (
          <span className="rounded bg-surface-active px-1.5 py-0.5 font-mono text-[10px] text-text-subtle" title="The port it left by">
            → {port}
          </span>
        )}
      </div>
      <p className="mt-0.5 text-[10.5px] leading-relaxed text-text-subtle">{hint}</p>
      {from && from.length > 0 && (
        <p className="mt-0.5 text-[10.5px] text-text-subtle">
          Merged from {from.length} upstream step{from.length === 1 ? '' : 's'}:{' '}
          {from.map((id) => <code key={id} className="mr-1 rounded bg-surface-active px-1">{id}</code>)}
        </p>
      )}
      {empty ? (
        <p className="mt-1 text-[11px] italic text-text-subtle">Nothing recorded.</p>
      ) : (
        <pre className="selectable mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface-active px-2.5 py-1.5 font-mono text-[10.5px] leading-relaxed text-text-muted">
          {text}
        </pre>
      )}
      {truncated && (
        <p className="mt-0.5 text-[10px] text-attention">
          Truncated by the service when it was recorded — this is not the whole value.
        </p>
      )}
      {files && files.length > 0 && (
        <p className="mt-0.5 text-[10.5px] text-text-subtle">
          {files.length} file{files.length === 1 ? '' : 's'}: {files.join(', ')}
        </p>
      )}
    </div>
  );
}

function StepRow({
  node,
  spec,
  slowest,

  onFocus,
  approvals,
  onDecideApproval,
  decidingId,
  carriedThrough,
}: {
  node: NodeRunRecord;
  spec?: NodeSpecInfo;
  slowest: number;
  onFocus?: (id: string) => void;
  approvals: ApprovalRequest[];
  onDecideApproval?: (id: string, granted: boolean, reason?: string) => void;
  decidingId?: string | null;
  carriedThrough?: number;
}) {
  const cat = spec?.category ?? 'source';
  const label = spec?.label ?? node.type;
  const share = node.ms ? Math.max(2, Math.round((node.ms / slowest) * 100)) : 0;
  const trace = asAgentTrace(node.agentTrace);
  const [openTrace, setOpenTrace] = useState(false);
  const [openDetail, setOpenDetail] = useState(false);


  return (
    <li>
      <button
        onClick={() => onFocus?.(node.nodeId)}
        disabled={!onFocus}
        className="flex w-full items-start gap-2.5 px-4 py-2 text-left transition-colors enabled:hover:bg-surface-hover disabled:cursor-default"
      >
        <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md" style={{ background: `${CATEGORY[cat].color}1f`, color: CATEGORY[cat].color }}>
          {node.state === 'running' ? (
            <motion.span animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1.2, ease: 'linear' }}>
              <Icon name="activity" size={11} />
            </motion.span>
          ) : (
            <Icon name={STATE_ICON[node.state]} size={11} />
          )}
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-[12.5px] font-medium text-text">{label}</span>
            <Badge tone={NODE_STATE_TONE[node.state]}>{NODE_STATE_LABEL[node.state]}</Badge>
            {node.ms > 0 && <span className="text-[11px] tabular-nums text-text-subtle">{fmtDuration(node.ms)}</span>}
            {node.attempts > 1 && <span className="text-[10.5px] text-attention">attempt {node.attempts}</span>}
            {node.evidence.length > 0 && (
              <span className="text-[10.5px] text-text-subtle" title="Governed actions this step caused">
                {node.evidence.length} governed action{node.evidence.length === 1 ? '' : 's'}
              </span>
            )}
          </span>

          {node.state === 'denied' && (
            <span className="mt-0.5 block text-[11.5px] leading-snug text-attention">
              {node.error ?? 'Your policy refused this action. The workflow is not broken — it was not permitted.'}
            </span>
          )}
          {node.state === 'awaiting-approval' && (
            <span className="mt-0.5 block text-[11.5px] text-attention">{waitReason(node, spec)}</span>
          )}
          {(node.state === 'failed' || node.state === 'timed-out') && node.error && (
            <span className="mt-0.5 block break-words text-[11.5px] leading-snug text-danger">{node.error}</span>
          )}
          {node.state === 'skipped' && (
            <span className="mt-0.5 block text-[11.5px] text-text-subtle">
              {node.summary ?? 'skipped — an upstream branch did not reach it'}
            </span>
          )}
          {node.state === 'succeeded' && node.summary && (
            <span className="mt-0.5 block truncate text-[11.5px] text-text-muted">{node.summary}</span>
          )}

          {share > 0 && (
            <span className="mt-1.5 block h-1 w-full max-w-[280px] overflow-hidden rounded-full bg-surface-active">
              <span
                className="block h-full rounded-full"
                style={{
                  width: `${share}%`,
                  background: node.state === 'failed' || node.state === 'timed-out' ? 'var(--danger)' : node.state === 'denied' ? 'var(--attention)' : CATEGORY[cat].color,
                }}
              />
            </span>
          )}
        </span>
      </button>

      {/* ── what this step received, did and became ────────────────
          Configured input is what an author wrote; resolved input is what
          actually arrived after interpolation and after however many
          edges merged into this node. Keeping them apart is the whole
          point — a node that produced the wrong thing is diagnosed by
          what it GOT, and inferring that from an upstream output is wrong
          the moment two edges merge.

          Everything here is redacted and bounded by the service before it
          is written. This view never un-redacts and never asks for a raw
          value: there is no contract that would return one. */}
      {(node.input || node.output || node.transitions?.length > 0) && (
        <div className="border-t border-line/50 bg-surface/40">
          <button
            onClick={() => setOpenDetail((o) => !o)}
            aria-expanded={openDetail}
            className="flex w-full items-center gap-2 px-4 py-1.5 text-left transition-colors hover:bg-surface-hover"
          >
            <Icon name="knowledge" size={11} className="text-text-subtle" />
            <span className="text-[11.5px] font-medium text-text">Input, output and state</span>
            <span className="text-[10.5px] text-text-subtle">
              {[
                node.input ? 'input' : null,
                node.output ? 'output' : null,
                node.transitions?.length ? `${node.transitions.length} transitions` : null,
              ].filter(Boolean).join(' · ')}
            </span>
            <span className="ml-auto text-[10.5px] text-text-subtle">{openDetail ? 'hide' : 'show'}</span>
          </button>

          {openDetail && (
            <div className="space-y-2.5 border-t border-line/50 px-4 py-2.5">
              {node.input && (
                <Payload
                  title="Resolved input"
                  hint="What this step actually received when it ran — not what the node is configured with."
                  text={node.input.text}
                  truncated={node.input.truncated}
                  files={node.input.files}
                  provenance={node.input.provenance}
                  from={node.input.fromNodeIds}
                />
              )}
              {node.output && (
                <Payload
                  title="Output"
                  hint="What it emitted, as checkpointed. A resume feeds this downstream rather than running the step again."
                  text={node.output.text}
                  truncated={node.output.truncated}
                  files={node.output.files}
                  provenance={node.output.provenance}
                  port={node.output.port}
                />
              )}
              {node.transitions?.length > 0 && (
                <div>
                  <div className="text-[10.5px] font-semibold uppercase tracking-wide text-text-subtle">
                    State history
                  </div>
                  <ol className="mt-1 space-y-0.5">
                    {node.transitions.map((t, i) => (
                      <li key={`${i}-${t.at}`} className="flex flex-wrap items-baseline gap-1.5 text-[10.5px]">
                        <span className="tabular-nums text-text-subtle">
                          {new Date(t.at).toLocaleTimeString()}
                        </span>
                        <span className="text-text-muted">{NODE_STATE_LABEL[t.from]}</span>
                        <Icon name="chevron-right" size={9} className="text-text-subtle" />
                        <span className="font-medium text-text">{NODE_STATE_LABEL[t.to]}</span>
                        {t.note && <span className="text-text-muted">— {t.note}</span>}
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* An agent step's reasoning, reviewable where the run is. The trace

          renders in its own component — this view is not a second one. */}
      {trace && (
        <div className="border-t border-line/50 bg-surface/40">
          <button
            onClick={() => setOpenTrace((o) => !o)}
            aria-expanded={openTrace}
            className="flex w-full items-center gap-2 px-4 py-1.5 text-left transition-colors hover:bg-surface-hover"
          >
            <Icon name="spark" size={11} style={{ color: '#6366f1' }} />
            <span className="text-[11.5px] font-medium text-text">Agent reasoning</span>
            {/* A snapshot has no verdict, so it does not get a verdict-shaped
                badge. "thinking" is a state, not an outcome. */}
            {isPartialTrace(trace) ? (
              <>
                <Badge tone="neutral">thinking</Badge>
                <span className="text-[10.5px] text-text-subtle">
                  {trace.beats.length} beat{trace.beats.length === 1 ? '' : 's'} so far
                </span>
              </>
            ) : (
              <>
                <Badge tone={trace.stopReason === 'completed' ? 'positive' : trace.stopReason === 'failed' || trace.stopReason === 'consecutive-failures' ? 'critical' : 'attention'}>
                  {trace.stopReason}
                </Badge>
                <span className="text-[10.5px] text-text-subtle">
                  {trace.iterations} iteration{trace.iterations === 1 ? '' : 's'} · {trace.beats.length} beats
                </span>
              </>
            )}

            <span className="ml-auto text-[10.5px] text-text-subtle">{openTrace ? 'hide' : 'show'}</span>
          </button>
          {openTrace && (
            <div className="max-h-[420px] overflow-y-auto border-t border-line/50">
              <AgentTrace
                trace={trace}
                approvals={approvals}
                onDecideApproval={onDecideApproval}
                decidingId={decidingId}
                carriedThrough={carriedThrough}
              />
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/* ── evidence ──────────────────────────────────────────────────────── */

function Evidence({
  run,
  specs,
  total,
  live,
}: {
  run: WorkflowRun;
  specs: Map<string, NodeSpecInfo>;
  total: number;
  live: boolean;
}) {
  const reported = Object.values(run.nodes).filter((n) => n.summary || n.error);

  return (
    <div className="space-y-3 px-4 py-3">
      <section className="rounded-xl border border-line bg-surface p-3">
        <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-text-subtle">What ran</h4>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[12px]">
          <Row label="Workflow" value={run.workflowName} />
          <Row label="Version" value={<code className="text-[11px]">{run.versionId || '—'}</code>} />
          <Row label="Project" value={run.projectId || '—'} />
          <Row label="Trigger" value={TRIGGER_LABEL[run.trigger.kind] ?? run.trigger.kind} />
          <Row label="Started" value={new Date(run.startedAt ?? run.createdAt).toLocaleString()} />
          <Row label="Duration" value={fmtDuration(total)} />
          <Row label="Resumable" value={run.resumable ? 'yes' : run.notResumableReason ? 'no' : '—'} />
        </dl>
      </section>

      <section className="rounded-xl border border-line bg-surface p-3">
        <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-text-subtle">
          Governed actions ({run.evidence.length})
        </h4>
        {run.evidence.length ? (
          <ul className="space-y-2">
            {run.evidence.map((e) => (
              <EvidenceRow key={e.invocationId} ev={e} />
            ))}
          </ul>
        ) : (
          <p className="text-[11.5px] leading-relaxed text-text-muted">
            {live
              ? 'No governed action has run yet.'
              : 'This run caused no governed actions — nothing it did needed a policy decision or produced an audit record.'}
          </p>
        )}
      </section>

      <section className="rounded-xl border border-line bg-surface p-3">
        <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-text-subtle">What each step reported</h4>
        {reported.length ? (
          <ul className="space-y-1.5">
            {reported.map((n) => (
              <li key={n.nodeId} className="flex gap-2 text-[11.5px]">
                <span className="shrink-0 font-medium text-text">{specs.get(n.type)?.label ?? n.type}</span>
                <span className={n.error ? 'text-danger' : 'text-text-muted'}>{n.error ?? n.summary}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[11.5px] text-text-muted">No step reported a summary.</p>
        )}
      </section>
    </div>
  );
}

function EvidenceRow({ ev }: { ev: EvidenceRef }) {
  return (
    <li className="rounded-lg border border-line bg-canvas px-2.5 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <code className="rounded bg-surface-active px-1.5 py-0.5 text-[10.5px] text-text">{ev.capabilityId}</code>
        <Badge tone={ev.outcome === 'succeeded' ? 'positive' : ev.outcome === 'denied' ? 'attention' : 'critical'}>{ev.outcome}</Badge>
        <Badge tone={ev.risk === 'high' ? 'critical' : ev.risk === 'medium' ? 'attention' : 'positive'}>{ev.risk}</Badge>
        <span className="text-[10.5px] tabular-nums text-text-subtle">{fmtDuration(ev.durationMs)}</span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10.5px] text-text-muted">
        <span>decided <span className="text-text">{ev.decision}</span> by rule <code className="rounded bg-surface-active px-1">{ev.decisionRule}</code></span>
        {ev.approvalId && <span>authorized by you</span>}
        {ev.nodeId && <span>on node {ev.nodeId}</span>}
      </div>
      <div className="mt-1 flex items-center gap-1.5 text-[10.5px]">
        {ev.verified === true && <><Icon name="check" size={10} className="text-positive" /><span className="text-positive">verified — the effect was read back</span></>}
        {ev.verified === false && <><Icon name="close" size={10} className="text-danger" /><span className="text-danger">verification failed</span></>}
        {ev.verified === null && <span className="text-text-subtle">no mechanical check exists for this capability, so the effect is recorded but not proven</span>}
      </div>
      <code className="mt-1 block text-[10px] text-text-subtle">audit {ev.invocationId}</code>
    </li>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <>
      <dt className="text-text-subtle">{label}</dt>
      <dd className="truncate text-text">{value}</dd>
    </>
  );
}

function EmptyNote({ text }: { text: string }) {
  return <p className="px-4 py-6 text-center text-[12px] text-text-muted">{text}</p>;
}
