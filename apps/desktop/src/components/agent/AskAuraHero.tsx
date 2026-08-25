/**
 * AskAuraHero — the flagship Home experience.
 * =====================================================================
 * "What do you want to accomplish?" — one input, then the agent's real
 * lifecycle, rendered from the Central Agent service's own contracts:
 *
 *   ask → intent → plan → approval if required → execution →
 *   verification → result (with evidence)
 *
 * Hard rules:
 *   • Everything shown comes from `centralAgentClient` responses or its
 *     SSE frames. There is no optimistic fake progress and no canned
 *     answer; when the service is unreachable the hero says so.
 *   • The plan review endpoint is reasoning-free BY CONTRACT. This UI
 *     never renders model chain-of-thought because it never receives it.
 *   • Approval is a human decision rendered through the EXISTING
 *     ApprovalGate component — this file adds no second approval UI.
 *     The decision goes to the backend route that records it in the SAME
 *     single-use ledger the Fabric spends; a replay surfaces the 409.
 *   • Outcome vocabulary is the backend's, verbatim — mapped for label
 *     and tone only, never renamed into something vaguer.
 *   • COMPLETED ≠ VERIFIED: the verified line exists only because the
 *     result carries verification outcomes and evidence ids.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { cn, spring, useAppStore } from '@aura/core';
import { Button, Icon, Input } from '@aura/ui';
import {
  centralAgentClient,
  type AgentOutcome,
  type AgentResult,
  type PlanReview,
} from '../../ai/centralAgentClient';
import { useAgentLink } from '../../ai/agentLinkStore';
import { ApprovalGate } from '../../screens/missions/ApprovalGate';
import { AgentPhaseStrip, phaseForResult, phaseFromEvents } from './AgentPhaseStrip';

/** Backend outcome → what Home says. Labels only; states stay distinct. */
const OUTCOME_LABEL: Record<AgentOutcome, string> = {
  completed: 'Completed',
  failed: 'Failed',
  blocked: 'Blocked',
  'awaiting-approval': 'Waiting for you',
  cancelled: 'Cancelled',
  denied: 'Denied by policy',
  timeout: 'Timed out',
  'needs-clarification': 'Needs your input',
  unsupported: 'Not available yet',
};

type Phase =
  | 'idle'
  | 'working'
  | 'needs-you'
  | 'needs-input'
  | 'done'
  | 'unavailable'
  | 'error';

export function AskAuraHero({ className }: { className?: string }) {
  const [intent, setIntent] = useState('');
  const [answer, setAnswer] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [result, setResult] = useState<AgentResult | null>(null);
  const [plan, setPlan] = useState<PlanReview | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [seenEvents, setSeenEvents] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const answerRef = useRef<HTMLInputElement>(null);

  /** Linkage: palette focus + deep-link into Runs. */
  const focusTick = useAgentLink((s) => s.focusTick);
  const setNav = useAppStore((s) => s.setNav);
  const recordSession = useAgentLink((s) => s.recordSession);
  const requestRunInspection = useAgentLink((s) => s.requestRunInspection);
  // The parked request lives in the AGENT service's ledger; it is fetched,
  // never assumed. `gateRequest` stays null until this resolves.
  type GateRequest = Parameters<typeof ApprovalGate>[0]['request'];
  const [gateRequest, setGateRequest] = useState<GateRequest | null | undefined>(undefined);

  useEffect(() => {
    inputRef.current?.focus();
  }, [focusTick]);

  /** Live events close over the CURRENT session id. */
  const closeStreamRef = useRef<(() => void) | null>(null);
  useEffect(() => () => closeStreamRef.current?.(), []);

  const reset = useCallback(() => {
    setPhase('idle');
    setResult(null);
    setPlan(null);
    setSessionId(null);
    setErrorText(null);
    setSeenEvents([]);
    closeStreamRef.current?.();
    closeStreamRef.current = null;
  }, []);

  const adoptResult = useCallback(
    (r: AgentResult, sid: string | null) => {
      setResult(r);
      if (sid) {
        setSessionId(sid);
        recordSession(sid, r.outcome);
      }
      if (r.outcome === 'awaiting-approval') {
        setPhase('needs-you');
        const apr = r.evidence?.approvalIds?.[0];
        setGateRequest(undefined);
        if (apr) {
          void centralAgentClient
            .pendingApprovals()
            .then((list) =>
              setGateRequest(
                (list.approvals.find((a) => a.id === apr) as typeof gateRequest) ?? null))
            .catch(() => setGateRequest(null));
        }
        // Reasoning-free plan review while the human decides.
        if (sid) {
          void centralAgentClient.planReview(sid).then(setPlan).catch(() => setPlan(null));
        }
      } else if (r.outcome === 'needs-clarification') {
        setPhase('needs-input');
      } else {
        setPhase('done');
      }
    },
    [recordSession],
  );

  const classifyError = (msg: string): Phase =>
    /failed to fetch|networkerror|load failed/i.test(msg) ? 'unavailable' : 'error';

  const submit = useCallback(async () => {
    const message = intent.trim();
    if (!message || phase === 'working') return;
    setIntent('');
    setPhase('working');
    setResult(null);
    setPlan(null);
    setErrorText(null);
    setSeenEvents([]);
    try {
      const res = await centralAgentClient.submit(message);
      // Live frames feed the phase strip; the response body stays the
      // authority on what actually happened.
      if (res.sessionId) {
        closeStreamRef.current?.();
        closeStreamRef.current = centralAgentClient.events(res.sessionId, (frame) => {
          setSeenEvents((prev) => [...prev, frame.type]);
        });
      }
      adoptResult(res.result, res.sessionId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorText(msg);
      setPhase(classifyError(msg));
    }
  }, [intent, phase, adoptResult]);

  /** Answer a pending clarification in the SAME session. */
  const sendAnswer = useCallback(async () => {
    const text = answer.trim();
    if (!text || !sessionId || phase !== 'needs-input') return;
    setAnswer('');
    setPhase('working');
    try {
      const res = await centralAgentClient.message(sessionId, text);
      adoptResult(res.result, sessionId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorText(msg);
      setPhase(classifyError(msg));
    }
  }, [answer, sessionId, phase, adoptResult]);

  /**
   * Human decision through the backend's approve route — decide + resume
   * against the same single-use ledger. A 409 lands here as an error and
   * is shown verbatim; success is whatever the returned result says.
   */
  /** Guards against double-fire (double-click, StrictMode, replays). */
  const decidingRef = useRef(false);

  const decide = useCallback(
    async (granted: boolean) => {
      const apr = result?.evidence?.approvalIds?.[0];
      if (!sessionId || !apr || phase !== 'needs-you') return;
      if (decidingRef.current) return;
      decidingRef.current = true;
      setPhase('working');
      try {
        const res = await centralAgentClient.approve(sessionId, apr, granted, 'Home decision');
        adoptResult(res.result, sessionId);
        // If the approve response raced the resume write (still parked),
        // reconcile against DURABLE session state until terminal or timeout.
        // Live SSE cannot be trusted to deliver this reliably under load.
        let current = res.result;
        if (current.outcome === 'awaiting-approval') {
          for (let waited = 0; waited < 12_000; waited += 750) {
            await new Promise((r) => setTimeout(r, 750));
            const session = await centralAgentClient.getSession(sessionId);
            const lr = session.lastResult;
            if (!lr) continue;
            if (lr.outcome !== 'awaiting-approval') {
              current = lr;
              break;
            }
          }
          // Adopt whatever durable state says — even if still parked.
          setResult(current);
          if (current.outcome === 'awaiting-approval') setPhase('needs-you');
          else setPhase('done');
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setErrorText(msg);
        setPhase('error');
      } finally {
        decidingRef.current = false;
      }
    },
    [sessionId, result, phase, adoptResult],
  );

  const cancel = useCallback(async () => {
    if (!sessionId) return;
    try {
      await centralAgentClient.cancel(sessionId);
      closeStreamRef.current?.();
      setPhase('done');
      setResult((prev) =>
        prev ?? {
          status: 'cancelled', outcome: 'cancelled',
          summary: 'Cancellation requested.', performed: [], verified: [],
          evidence: null,
        },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorText(msg);
      setPhase(classifyError(msg));
    }
  }, [sessionId]);

  const busy = phase === 'working';
  // Strip position: terminal results pin the final phase; live sessions
  // derive from REAL event types; before any event, working means intent.
  const lifecycle = result && (phase === 'done' || phase === 'needs-you' || phase === 'needs-input')
    ? phaseForResult(result.outcome)
    : seenEvents.length > 0
      ? phaseFromEvents(seenEvents)
      : busy
        ? ('intent' as const)
        : ('idle' as const);


  return (
    <section aria-label="Ask AURA" className={cn('relative overflow-hidden rounded-3xl border border-line bg-surface p-8', className)}>
      <div className="pointer-events-none absolute -right-16 -top-24 h-72 w-72 rounded-full bg-accent/10 blur-3xl" />
      <div className="relative">
        <div className="mb-2 flex items-center gap-2 text-[12px] font-medium text-accent">
          <Icon name="spark" size={15} />
          AURA Central Agent
        </div>
        <h1 className="text-[26px] font-semibold tracking-[-0.02em] text-text sm:text-[30px]">
          What do you want to accomplish?
        </h1>

        <form
          className="mt-5 flex max-w-xl items-center gap-2"
          onSubmit={(e) => { e.preventDefault(); void submit(); }}
        >
          <Input
            ref={inputRef}
            id="ask-aura-input"
            value={intent}
            onChange={(e) => setIntent(e.target.value)}
            placeholder="e.g. Show my git status · create report.md containing hello"
            aria-label="Describe what you want to accomplish"
            disabled={busy}
            className="h-11 flex-1"
          />
          <Button type="submit" size="lg" disabled={busy || !intent.trim()}>
            {busy ? <Icon name="refresh" size={15} className="animate-spin" /> : <Icon name="spark" size={15} />}
            Ask
          </Button>
        </form>

        {(busy || result) && (
          <div className="mt-4">
            <AgentPhaseStrip current={lifecycle} outcome={result?.outcome} />
          </div>
        )}

        <AnimatePresence mode="wait">
          {(phase === 'error' || phase === 'unavailable') && (
            <motion.div
              key="error"
              initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
              transition={spring.snappy}
              role="alert"
              className="mt-4 rounded-xl border border-danger/25 bg-danger/5 px-4 py-3 text-[13px] text-danger"
            >
              {phase === 'unavailable'
                ? 'Central Agent service is not reachable right now.'
                : errorText}
            </motion.div>
          )}

          {busy && (
            <motion.div
              key="busy"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="mt-4 rounded-xl border border-line bg-surface-raised px-4 py-3"
              role="status"
            >
              <span className="flex items-center gap-3">
                <span className="h-2 w-2 animate-pulse rounded-full bg-accent" aria-hidden />
                <span className="text-[13px] text-text-muted">
                  AURA is understanding, planning and checking permissions…
                </span>
                {sessionId && (
                  <Button variant="ghost" size="sm" className="ml-auto" onClick={() => void cancel()}>
                    Cancel
                  </Button>
                )}
              </span>
            </motion.div>
          )}

          {result && (
            <motion.div
              key="result"
              initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
              transition={spring.snappy}
              className="mt-4 rounded-xl border border-line bg-surface-raised p-4"
              aria-live="polite"
            >
              <div className="mb-1.5 flex items-center justify-between gap-3">
                <span
                  data-testid="agent-outcome"
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium tracking-wide',
                    result.outcome === 'completed' && 'bg-positive/10 text-positive dark:bg-positive/15',
                    (result.outcome === 'awaiting-approval' || result.outcome === 'needs-clarification'
                      || result.outcome === 'denied') && 'bg-attention/12 text-attention dark:bg-attention/15',
                    (result.outcome === 'failed' || result.outcome === 'timeout')
                      && 'bg-danger/10 text-danger dark:bg-danger/15',
                    (result.outcome === 'blocked' || result.outcome === 'cancelled'
                      || result.outcome === 'unsupported') && 'bg-surface-active text-text-muted',
                  )}
                >
                  {OUTCOME_LABEL[result.outcome]}
                </span>
                <div className="flex shrink-0 items-center gap-3">
                  {result.runId && (
                    <button
                      type="button"
                      onClick={() => {
                        requestRunInspection(result.runId as string);
                        setNav('workflows');
                      }}
                      className="inline-flex items-center gap-1 text-[12px] text-accent underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                      aria-label={`Inspect engine run ${result.runId}`}
                    >
                      <Icon name="workflows" size={13} />
                      Inspect run
                    </button>
                  )}
                  {(phase === 'done' || phase === 'needs-you' || phase === 'needs-input') && (
                    <button
                      type="button"
                      onClick={reset}
                      className="text-[12px] text-text-subtle underline-offset-2 hover:text-text hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                    >
                      New request
                    </button>
                  )}
                </div>
              </div>

              {/* Plan review — actions/capabilities/risk only, no reasoning. */}
              {plan && plan.steps.length > 0 && (
                <ol className="mb-3 space-y-1.5 border-b border-line pb-3" aria-label="What AURA plans to do">
                  {plan.steps.map((s, i) => (
                    <li key={s.id} className="flex items-center gap-2 text-[13px] text-text-muted">
                      <span className="text-text-subtle">{i + 1}.</span>
                      <span className="min-w-0 truncate">{s.action}</span>
                      {s.capability && (
                        <code className="rounded bg-surface-active px-1.5 py-0.5 text-[11px] text-text-subtle">
                          {s.capability}
                        </code>
                      )}
                      {plan.estimatedApprovals > 0 && i === plan.steps.length - 1 && (
                        <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-[11px] uppercase tracking-wide text-attention">
                          <Icon name="shield" size={12} />
                          approval needed
                        </span>
                      )}
                      <span className="ml-auto shrink-0 text-[11px] uppercase tracking-wide text-text-subtle">
                        {s.risk}
                      </span>
                    </li>
                  ))}
                </ol>
              )}

              <p className="text-[14px] leading-relaxed text-text">{result.summary}</p>

              {/* Clarification — one question, one answer, same session. */}
              {phase === 'needs-input' && (
                <form
                  className="mt-3 flex max-w-lg items-center gap-2"
                  onSubmit={(e) => { e.preventDefault(); void sendAnswer(); }}
                >
                  <Input
                    ref={answerRef}
                    value={answer}
                    onChange={(e) => setAnswer(e.target.value)}
                    placeholder="Type your answer…"
                    aria-label="Your clarifying answer"
                    className="h-9 flex-1"
                  />
                  <Button type="submit" size="sm" disabled={!answer.trim()}>Reply</Button>
                </form>
              )}

              {/* THE existing ApprovalGate, fed the REAL request object. */}
              {phase === 'needs-you' && (
                gateRequest ? (
                  <ApprovalGate
                    request={gateRequest}
                    onDecide={(_id, granted) => void decide(granted)}
                  />
                ) : gateRequest === null ? (
                  <p role="status" className="mt-3 text-[12.5px] text-text-subtle">
                    Loading authorization details… If this persists, the approval
                    list could not be read — decide from the Automation domain.
                  </p>
                ) : (
                  <p role="alert" className="mt-3 text-[12.5px] text-attention">
                    The parked approval was not found in the pending list — it may
                    already be decided elsewhere. Use “New request” to continue.
                  </p>
                )
              )}

              {result.evidence && result.evidence.auditRecordIds.length > 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-text-subtle">
                  <span>
                    Verified: {result.verified.length
                      ? `${result.verified.length} step${result.verified.length > 1 ? 's' : ''}`
                      : 'none'}
                  </span>
                  <span>Evidence: {result.evidence.auditRecordIds.length} audit record(s)</span>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </section>
  );
}

export default AskAuraHero;
