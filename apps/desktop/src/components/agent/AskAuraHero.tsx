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
 *   • Approval is a human decision. The button calls the backend's
 *     approve route, which records the decision in the SAME single-use
 *     ledger the Fabric spends. A replay surfaces the backend's refusal.
 *   • Outcome vocabulary is the backend's, verbatim — mapped for label
 *     and tone only, never renamed into something vaguer.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { cn, spring } from '@aura/core';
import { Button, Icon, Input } from '@aura/ui';
import {
  centralAgentClient,
  type AgentOutcome,
  type AgentResult,
  type PlanReview,
} from '../../ai/centralAgentClient';

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

type Phase = 'idle' | 'working' | 'needs-you' | 'done' | 'unavailable' | 'error';

export function AskAuraHero({ className }: { className?: string }) {
  const [intent, setIntent] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [result, setResult] = useState<AgentResult | null>(null);
  const [plan, setPlan] = useState<PlanReview | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  /** Live events close over the CURRENT session id. */
  const closeStreamRef = useRef<(() => void) | null>(null);
  useEffect(() => () => closeStreamRef.current?.(), []);

  const reset = useCallback(() => {
    setPhase('idle');
    setResult(null);
    setPlan(null);
    setSessionId(null);
    setErrorText(null);
    closeStreamRef.current?.();
    closeStreamRef.current = null;
  }, []);

  const submit = useCallback(async () => {
    const message = intent.trim();
    if (!message || phase === 'working') return;
    setIntent('');
    setPhase('working');
    setResult(null);
    setPlan(null);
    setErrorText(null);
    try {
      const res = await centralAgentClient.submit(message);
      if (res.sessionId) {
        setSessionId(res.sessionId);
        // Live frames drive the working state; the durable result still
        // comes from the submit response — SSE loss cannot fake one.
        closeStreamRef.current?.();
        closeStreamRef.current = centralAgentClient.events(
          res.sessionId,
          () => { /* frames arrive; the terminal response governs */ },
        );
      }
      applyResult(res.result);
      // A parked or clarified session exposes its plan for review.
      if (res.result.outcome === 'awaiting-approval' && res.sessionId) {
        void centralAgentClient.planReview(res.sessionId).then(setPlan).catch(() => setPlan(null));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorText(msg);
      // A failed FETCH means the service is down; a backend error body
      // means it answered and refused. The two states look different.
      setPhase(/failed to fetch|networkerror|load failed/i.test(msg)
        ? 'unavailable' : 'error');
    }
  }, [intent, phase]);

  /** Map a terminal/parked result onto the visible phase. */
  const applyResult = (r: AgentResult) => {
    setResult(r);
    if (r.outcome === 'awaiting-approval') setPhase('needs-you');
    else if (r.outcome === 'completed') setPhase('done');
    else setPhase('done');
  };

  const decide = useCallback(async (granted: boolean) => {
    const apr = result?.evidence?.approvalIds?.[0];
    if (!sessionId || !apr || phase !== 'needs-you') return;
    setPhase('working');
    try {
      const res = await centralAgentClient.approve(sessionId, apr, granted, 'Home decision');
      applyResult(res.result);
      if (res.result.outcome === 'awaiting-approval') {
        void centralAgentClient.planReview(sessionId).then(setPlan).catch(() => setPlan(null));
        setPhase('needs-you');
      }
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : String(err));
      setPhase('error');
    }
  }, [sessionId, result, phase]);

  const busy = phase === 'working';

  return (
    <section
      aria-label="Ask AURA"
      className={cn(
        'relative overflow-hidden rounded-3xl border border-line bg-surface p-8',
        className,
      )}
    >
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
              className="mt-4 flex items-center gap-3 rounded-xl border border-line bg-surface-raised px-4 py-3"
              role="status"
            >
              <span className="h-2 w-2 animate-pulse rounded-full bg-accent" aria-hidden />
              <span className="text-[13px] text-text-muted">
                AURA is understanding, planning and checking permissions…
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
              {/* Plan review — actions/capabilities/risk only, no reasoning. */}
              {plan && plan.steps.length > 0 && (
                <ol className="mb-3 space-y-1.5" aria-label="Planned steps">
                  {plan.steps.map((s, i) => (
                    <li key={s.id} className="flex items-center gap-2 text-[13px] text-text-muted">
                      <span className="text-text-subtle">{i + 1}.</span>
                      <span className="min-w-0 truncate">{s.action}</span>
                      {s.capability && (
                        <code className="rounded bg-surface-active px-1.5 py-0.5 text-[11px] text-text-subtle">
                          {s.capability}
                        </code>
                      )}
                      <span className="ml-auto shrink-0 text-[11px] uppercase tracking-wide text-text-subtle">
                        {s.risk}
                      </span>
                    </li>
                  ))}
                </ol>
              )}

              <div className="mb-1.5 flex items-center justify-between gap-3">
                <span
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
                {(phase === 'done' || phase === 'needs-you') && (
                  <button
                    type="button"
                    onClick={reset}
                    className="shrink-0 text-[12px] text-text-subtle underline-offset-2 hover:text-text hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                  >
                    New request
                  </button>
                )}
              </div>
              <p className="text-[14px] leading-relaxed text-text">{result.summary}</p>

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

              {phase === 'needs-you' && result.evidence && (
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button
                    onClick={() => void decide(true)}
                    data-testid="agent-approve"
                    aria-label="Approve the requested action"
                  >
                    <Icon name="check" size={15} />
                    Approve
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => void decide(false)}
                    aria-label="Deny the requested action"
                  >
                    <Icon name="close" size={15} />
                    Deny
                  </Button>
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
