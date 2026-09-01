/**
 * AgentTrace — the agent node at run time.
 * ==================================================================
 * A ledger, not a chat log. It renders the service's own `AgentTrace`
 * beats, and holds to seven rules that make it trustworthy:
 *
 *   1. Beats are typed by kind, with the actor badges MissionTimeline
 *      already uses. One vocabulary across the product, not two.
 *   2. Untrusted beats are quarantined — monospace, dimmed, ruled,
 *      byte-counted, never Markdown. `untrusted` is a field on the record,
 *      so this is a control the service asserts and the UI honours.
 *   3. Permission beats appear even when the Fabric auto-executed. Silent
 *      auto-execution is where trust dies quietly.
 *   4. Execution beats carry their audit reference, so a claim in the
 *      ledger can be followed to the Fabric's own record of it.
 *   5. The bounds deplete in the header and turn to attention at 80%.
 *   6. An intervention renders the real ApprovalGate inline — never a
 *      modal, which would divorce the decision from its reasoning.
 *   7. No confidence scores. Only measured quantities.
 */

import { useState } from 'react';
import { motion } from 'framer-motion';
import { Badge, Icon } from '@aura/ui';
import type { IconName } from '@aura/ui';
import type { EvidenceRef } from '../../../ai/aiClient';
import type { ApprovalRequest } from '../../../ai/fabricClient';
import { ApprovalGate } from '../../missions/ApprovalGate';
import { fmtDuration } from '../runs';
import {
  ACTOR_LABEL,
  AGENT_COLOR,
  BEAT_LABEL,
  PROVENANCE_LABEL,
  isInstruction,
  STOP_SENTENCE,
  STOP_TONE,
  isPartialTrace,
  type AgentBeat,
  type AgentTrace as Trace,
  type AnyAgentTrace,
  type BeatKind,
  type PartialAgentTrace,
} from './types';


const BEAT_ICON: Record<BeatKind, IconName> = {
  intent: 'note',
  plan: 'spark',
  proposal: 'command',
  permission: 'shield',
  execution: 'activity',
  observation: 'eye',
  decision: 'knowledge',
  intervention: 'bell',
  result: 'check',
};

const BEAT_COLOR: Record<BeatKind, string> = {
  intent: 'var(--accent)',
  plan: AGENT_COLOR,
  proposal: AGENT_COLOR,
  permission: 'var(--positive)',
  execution: 'var(--accent)',
  observation: 'var(--text-subtle)',
  decision: AGENT_COLOR,
  intervention: 'var(--attention)',
  result: 'var(--positive)',
};

export interface AgentTraceProps {
  /**
   * Either a finished ledger or a snapshot of one still being written.
   * The two are different types on purpose — a snapshot has beats and
   * nothing else — so this component branches once, here, rather than
   * letting a half-written record reach code that reads a verdict off it.
   */
  trace: AnyAgentTrace;
  model?: string;
  running?: boolean;
  approvals?: ApprovalRequest[];
  onDecideApproval?: (id: string, granted: boolean, reason?: string) => void;
  decidingId?: string | null;
  /**
   * The last `seq` the previous leg of this execution reached, when this
   * run continues another. Used only to mark where the resume happened.
   */
  carriedThrough?: number;
}

export function AgentTrace(props: AgentTraceProps) {
  return isPartialTrace(props.trace)
    ? <PartialTrace {...props} trace={props.trace} />
    : <FinishedTrace {...props} trace={props.trace} />;
}

/**
 * An agent that is still thinking.
 *
 * Deliberately spare. There is no stop reason yet, no effective bounds, no
 * evidence and no output — so none of those are drawn, not even greyed
 * out, because a placeholder where a verdict will go reads as a verdict
 * that has not loaded. What exists is the reasoning so far, and the fact
 * that it is unfinished, said plainly.
 */
function PartialTrace({
  trace,
  model,
  carriedThrough,
}: AgentTraceProps & { trace: PartialAgentTrace }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-surface px-4 py-2.5">
        <span className="flex items-center gap-2">
          <span className="grid h-6 w-6 place-items-center rounded-lg" style={{ background: `${AGENT_COLOR}1f`, color: AGENT_COLOR }}>
            <motion.span animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1.2, ease: 'linear' }}>
              <Icon name="activity" size={12} />
            </motion.span>
          </span>
          <span className="text-[12.5px] font-semibold text-text">Agent</span>
        </span>
        <Badge tone="neutral">thinking</Badge>
        <span className="text-[11px] text-text-subtle">
          {trace.beats.length} beat{trace.beats.length === 1 ? '' : 's'} so far
        </span>
        {model && <span className="ml-auto text-[11px] text-text-subtle">{model}</span>}
      </header>

      <div className="border-b border-line px-4 py-2">
        <p className="text-[11.5px] leading-relaxed text-text-muted">
          This is the reasoning as it happens, not a verdict. How it ended, what it
          actually cost against its bounds, and what it caused are recorded when the
          node finishes — nothing here should be read as a result yet.
        </p>
      </div>

      <Ledger
        beats={trace.beats}
        hiddenAuto={0}
        onShowAuto={() => {}}
        carriedThrough={carriedThrough}
        parked={null}
      />
    </div>
  );
}

function FinishedTrace({
  trace,
  model,
  running,
  approvals = [],
  onDecideApproval,
  decidingId,
  carriedThrough,
}: AgentTraceProps & { trace: Trace }) {

  // The bounds that ACTUALLY applied. A trace showing the configuration
  // would misdescribe a node configured with 1000 iterations that ran 25.
  const bounds = trace.effectiveBounds;
  const [showAuto, setShowAuto] = useState(false);

  // Auto-executed beats collapse in aggregate once a run gets long — but
  // never disappear, and only ever the ones the Fabric ran without asking.
  const auto = trace.beats.filter((b) => b.kind === 'permission' && b.decision === 'auto-execute');
  const collapse = !showAuto && auto.length > 4;
  const beats = collapse ? trace.beats.filter((b) => !auto.includes(b)) : trace.beats;

  const parked = trace.approval ? approvals.find((a) => a.id === trace.approval!.requestId && a.state === 'pending') ?? null : null;
  const resumable = trace.stopReason === 'awaiting-approval' && Boolean(trace.resume);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* ── the bounds, depleting ─────────────────────────────────── */}
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-surface px-4 py-2.5">
        <span className="flex items-center gap-2">
          <span className="grid h-6 w-6 place-items-center rounded-lg" style={{ background: `${AGENT_COLOR}1f`, color: AGENT_COLOR }}>
            {running ? (
              <motion.span animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1.2, ease: 'linear' }}>
                <Icon name="activity" size={12} />
              </motion.span>
            ) : (
              <Icon name="spark" size={12} />
            )}
          </span>
          <span className="text-[12.5px] font-semibold text-text">Agent</span>
        </span>

        <Meter icon="refresh" used={trace.iterations} total={bounds.maxIterations} text={`${trace.iterations}/${bounds.maxIterations}`} label="iterations" />
        <Meter icon="activity" used={trace.ms} total={bounds.timeoutMs} text={`${fmtDuration(trace.ms)} / ${fmtDuration(bounds.timeoutMs)}`} label="time" />
        <Meter
          icon="cpu"
          used={trace.tokensUsed}
          total={bounds.maxTokens}
          text={`${(trace.tokensUsed / 1000).toFixed(1)}K / ${(bounds.maxTokens / 1000).toFixed(0)}K`}
          label="tokens"
        />
        {/* A budget enforced on an estimate is a different promise from one
            enforced on a measurement, so the number says which it is. */}
        <span
          className={`text-[10px] ${trace.tokenSource === 'provider' ? 'text-text-subtle' : 'text-attention'}`}
          title={
            trace.tokenSource === 'provider'
              ? 'The model reported usage for every call.'
              : trace.tokenSource === 'estimated'
                ? 'No call reported usage; this is a character-count estimate.'
                : 'Some calls reported usage and some did not; this is part measurement, part estimate.'
          }
        >
          {trace.tokenSource === 'provider' ? 'measured' : trace.tokenSource === 'estimated' ? 'estimated' : 'part-estimated'}
        </span>

        <Badge tone={STOP_TONE[trace.stopReason]}>{trace.stopReason}</Badge>
        <span className="text-[10px] text-text-subtle" title="These are the bounds the runtime enforced, after clamping the node's configuration.">
          effective bounds
        </span>
        <span className="rounded bg-surface-active px-1.5 py-0.5 font-mono text-[10px] text-text-subtle" title="Which port the outer graph continued from">
          → {trace.port}
        </span>
        {model && <span className="ml-auto text-[11px] text-text-subtle">{model}</span>}
      </header>

      {/* ── what the agent was actually asked ─────────────────────
          `authored` is the only provenance that is an instruction. Anything
          else reached the model fenced as data, and if the node had no
          authored task the agent was asked to summarise its input rather
          than pursue it — which changes what the run means. */}
      {(trace.taskWasQuarantined || !isInstruction(trace.inputProvenance)) && (
        <div className="border-b border-line bg-surface/60 px-4 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <Icon name="shield" size={12} className="text-text-subtle" />
            <span className="text-[11.5px] font-medium text-text">
              {trace.taskWasQuarantined ? 'The agent was asked to summarise its input, not to follow it' : 'Input treated as data'}
            </span>
            <Badge tone="neutral">input {PROVENANCE_LABEL[trace.inputProvenance]}</Badge>
          </div>
          <p className="mt-0.5 text-[10.5px] leading-relaxed text-text-muted">
            {trace.taskWasQuarantined
              ? 'This node had no task typed by a person, and its upstream value was not trusted as instruction — so the value was fenced and the agent was told to describe it. Text arriving from a tool or from outside AURA never becomes an instruction.'
              : 'Only a task a person typed into the node counts as an instruction. This input reached the model fenced as data.'}
          </p>
        </div>
      )}

      {/* ── why it stopped, said out loud ─────────────────────────── */}
      {!running && (
        <div className="border-b border-line px-4 py-2">
          <p className="text-[12px] text-text">{STOP_SENTENCE[trace.stopReason]}</p>
          <p className="mt-0.5 text-[10.5px] text-text-subtle">
            The workflow continued from this node's{' '}
            <code className="rounded bg-surface-active px-1">{trace.port}</code> port.
          </p>
        </div>
      )}

      {/* ── the parked call, and what resuming would do ───────────── */}
      {resumable && trace.resume && (
        <div className="border-b border-attention/25 bg-attention/[0.06] px-4 py-2.5">
          <div className="flex items-center gap-2">
            <Icon name="shield" size={13} className="text-attention" />
            <span className="text-[12px] font-semibold text-text">A tool call is parked on your decision</span>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <code className="rounded bg-surface-active px-1.5 py-0.5 text-[10.5px] text-text">
              {trace.resume.pendingCall.capabilityId}
            </code>
            <span className="text-[10.5px] text-text-subtle">
              iteration {trace.resume.iteration} · {trace.resume.tokensUsed.toLocaleString()} tokens used ·{' '}
              {fmtDuration(trace.resume.elapsedMs)} elapsed
            </span>
          </div>
          {Object.keys(trace.resume.pendingCall.input).length > 0 && (
            <code className="mt-1 block break-words rounded bg-surface-active px-2 py-1 text-[10.5px] text-text-muted">
              {JSON.stringify(trace.resume.pendingCall.input)}
            </code>
          )}
          <p className="mt-1.5 text-[10.5px] leading-relaxed text-text-muted">
            Approving re-issues exactly this call and the agent continues from iteration {trace.resume.iteration} with
            the budget it has already spent — resuming does not restart the clock. Declining ends the run here. Its
            reasoning so far ({trace.resume.transcript.length} turn
            {trace.resume.transcript.length === 1 ? '' : 's'}) is kept so it does not lose its place.
          </p>
        </div>
      )}

      {/* ── a policy refusal is not a malfunction ─────────────────── */}
      {trace.stopReason === 'denied' && (
        <div className="border-b border-attention/25 bg-attention/[0.06] px-4 py-2">
          <div className="flex items-center gap-2">
            <Icon name="shield" size={13} className="text-attention" />
            <span className="text-[12px] font-medium text-text">Refused by policy, not broken</span>
          </div>
          <p className="mt-0.5 text-[11px] leading-relaxed text-text-muted">
            Retrying would spend the remaining budget rediscovering the same refusal. Change the policy or the
            workflow's authority instead.
          </p>
        </div>
      )}

      {/* ── tools it asked for and did not get ────────────────────── */}
      {trace.refusedTools.length > 0 && (
        <div className="border-b border-attention/25 bg-attention/[0.06] px-4 py-2">
          <div className="flex items-center gap-2">
            <Icon name="shield" size={12} className="text-attention" />
            <span className="text-[12px] font-medium text-text">
              {trace.refusedTools.length} tool{trace.refusedTools.length === 1 ? '' : 's'} refused before it started
            </span>
          </div>
          <ul className="mt-1 space-y-0.5">
            {trace.refusedTools.map((t) => (
              <li key={t.capabilityId} className="text-[11px] text-text-muted">
                <code className="rounded bg-surface-active px-1">{t.capabilityId}</code> — {t.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── the ledger ────────────────────────────────────────────── */}
      <Ledger
        beats={beats}
        hiddenAuto={collapse ? auto.length : 0}
        onShowAuto={() => setShowAuto(true)}
        carriedThrough={carriedThrough}
        parked={parked}
        onDecideApproval={onDecideApproval}
        decidingId={decidingId}
      >
        {/* The typed result, or the reason there is none. */}
        {!running && trace.output && (
          <div className="border-t border-line px-4 py-3">
            <div className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-text-subtle">Result</div>
            <p className="selectable whitespace-pre-wrap text-[12.5px] leading-relaxed text-text">{trace.output}</p>
          </div>
        )}
      </Ledger>
    </div>
  );
}

/**
 * The beat list itself — the one part a finished ledger and a snapshot of
 * one in progress genuinely share.
 */
function Ledger({
  beats,
  hiddenAuto,
  onShowAuto,
  carriedThrough,
  parked,
  onDecideApproval,
  decidingId,
  children,
}: {
  beats: AgentBeat[];
  hiddenAuto: number;
  onShowAuto: () => void;
  carriedThrough?: number;
  parked: ApprovalRequest | null;
  onDecideApproval?: (id: string, granted: boolean, reason?: string) => void;
  decidingId?: string | null;
  children?: React.ReactNode;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {hiddenAuto > 0 && (
        <button
          onClick={onShowAuto}
          className="flex w-full items-center gap-2 border-b border-line/60 px-4 py-1.5 text-left text-[11px] text-text-muted transition-colors hover:bg-surface-hover"
        >
          <Icon name="shield" size={11} className="text-positive" />
          {hiddenAuto} calls the Fabric ran without asking — show them
        </button>
      )}

      <ol>
        {beats.map((b, i) => (
          <BeatRow
            key={b.seq}
            /* The leg boundary, when the caller knows it.
             *
             * It used to be inferred from `seq` going backwards, because a
             * resumed leg restarted numbering at 0 while carrying the
             * earlier leg's beats forward at their original numbers. The
             * service has since made `seq` continue past whatever it
             * carried — one logical execution, one ascending sequence — so
             * that inference can no longer fire and would be wrong if it
             * did. The boundary is now a fact from the run chain: the last
             * `seq` the earlier leg reached. Absent, no marker is drawn,
             * which is the honest answer when nothing told us. */
            resumedHere={
              carriedThrough !== undefined &&
              b.seq > carriedThrough &&
              (i === 0 || beats[i - 1].seq <= carriedThrough)
            }
            beat={b}
            approval={b.kind === 'intervention' ? parked : null}
            onDecideApproval={onDecideApproval}
            decidingId={decidingId}
          />
        ))}
      </ol>

      {!beats.length && <p className="px-4 py-8 text-center text-[12px] text-text-muted">No reasoning recorded yet.</p>}

      {children}
    </div>
  );
}


function BeatRow({
  beat,
  resumedHere,
  approval,
  onDecideApproval,
  decidingId,
}: {
  beat: AgentBeat;
  /** True when this beat begins a new leg after a resume. */
  resumedHere?: boolean;
  approval: ApprovalRequest | null;
  onDecideApproval?: (id: string, granted: boolean, reason?: string) => void;
  decidingId?: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const lines = beat.text.split('\n');
  const long = lines.length > 6;

  return (
    <>
      {resumedHere && (
        <li className="flex items-center gap-2 border-b border-line/50 bg-surface/60 px-4 py-1">
          <Icon name="refresh" size={10} className="text-accent" />
          <span className="text-[10.5px] font-medium text-text">
            Resumed here — everything above is the earlier leg, carried forward
          </span>
          <span className="text-[10px] text-text-subtle">
            the agent kept its transcript and its spent budget
          </span>
        </li>
      )}
    <li className="grid grid-cols-[104px_1fr] gap-3 border-b border-line/50 px-4 py-2">
      <span className="flex items-start gap-1.5 pt-0.5">
        <Icon name={BEAT_ICON[beat.kind]} size={11} style={{ color: BEAT_COLOR[beat.kind] }} className="mt-0.5 shrink-0" />
        <span className="min-w-0">
          <span className="block text-[10px] font-semibold uppercase tracking-[0.09em]" style={{ color: BEAT_COLOR[beat.kind] }}>
            {BEAT_LABEL[beat.kind]}
          </span>
          <span
            className={`mt-0.5 inline-block rounded px-1.5 py-px text-[9.5px] font-semibold ${
              beat.actor === 'human' ? 'bg-accent/15 text-accent'
                : beat.actor === 'ai' ? 'bg-positive/15 text-positive'
                : beat.actor === 'fabric' ? 'bg-attention/15 text-attention'
                : 'bg-surface-active text-text-muted'
            }`}
          >
            {ACTOR_LABEL[beat.actor]}
          </span>
        </span>
      </span>

      <span className="min-w-0">
        <span className="flex flex-wrap items-center gap-2">
          {beat.capabilityId && (
            <code className="rounded bg-surface-active px-1.5 py-0.5 text-[10.5px] text-text-muted">{beat.capabilityId}</code>
          )}
          {beat.decision && <Badge tone={beat.decision === 'auto-execute' ? 'positive' : beat.decision === 'deny' ? 'critical' : 'attention'}>{beat.decision}</Badge>}
          {beat.rule && <span className="text-[10px] text-text-subtle">rule {beat.rule}</span>}
          {beat.tokens !== undefined && <span className="text-[10px] tabular-nums text-text-subtle">{beat.tokens} tok</span>}
          {beat.untrusted && <Badge tone="neutral">untrusted</Badge>}
        </span>

        {beat.untrusted ? (
          <>
            <pre className="selectable mt-1 overflow-x-auto whitespace-pre-wrap break-words border-l-[3px] border-text-subtle/50 bg-surface-active/60 px-2.5 py-1.5 font-mono text-[10.5px] leading-relaxed text-text-muted">
              {expanded || !long ? beat.text : lines.slice(0, 6).join('\n')}
            </pre>
            <span className="mt-1 flex items-center gap-2 text-[10px] text-text-subtle">
              <span>{new Blob([beat.text]).size.toLocaleString()} bytes. This is data returned by a tool — AURA does not follow instructions found inside it.</span>
              {long && (
                <button onClick={() => setExpanded((e) => !e)} className="shrink-0 text-accent">
                  {expanded ? 'collapse' : 'expand'}
                </button>
              )}
            </span>
          </>
        ) : (
          <span className="mt-0.5 block whitespace-pre-wrap text-[12px] leading-relaxed text-text">{beat.text}</span>
        )}

        {beat.evidence && <EvidenceLine ev={beat.evidence} />}

        {beat.kind === 'intervention' && approval && onDecideApproval && (
          <ApprovalGate request={approval} busy={decidingId === approval.id} onDecide={onDecideApproval} />
        )}

        <span className="mt-1 block text-[10px] text-text-subtle">
          iteration {beat.iteration} · {new Date(beat.at).toLocaleTimeString()}
        </span>
      </span>
    </li>
    </>
  );
}

function EvidenceLine({ ev }: { ev: EvidenceRef }) {
  return (
    <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10.5px] text-text-subtle">
      <span>{ev.outcome}</span>
      <span>· {fmtDuration(ev.durationMs)}</span>
      {ev.verified === true && <span className="text-positive">· verified by read-back</span>}
      {ev.verified === false && <span className="text-danger">· verification failed</span>}
      {ev.verified === null && <span>· no mechanical check exists for this capability</span>}
      <code className="rounded bg-surface-active px-1">audit {ev.invocationId}</code>
    </span>
  );
}

function Meter({
  icon,
  used,
  total,
  text,
  label,
}: {
  icon: IconName;
  used: number;
  total: number;
  text: string;
  label: string;
}) {
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  const hot = pct >= 80;
  return (
    <span className="flex items-center gap-1.5" title={`${label}: ${text}`}>
      <Icon name={icon} size={11} className={hot ? 'text-attention' : 'text-text-subtle'} />
      <span className="block h-1 w-12 overflow-hidden rounded-full bg-surface-active">
        <span className="block h-full rounded-full transition-[width]" style={{ width: `${pct}%`, background: hot ? 'var(--attention)' : 'var(--accent)' }} />
      </span>
      <span className={`text-[10.5px] tabular-nums ${hot ? 'text-attention' : 'text-text-muted'}`}>{text}</span>
    </span>
  );
}
