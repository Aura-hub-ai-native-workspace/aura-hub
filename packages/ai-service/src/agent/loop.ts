/**
 * agent/loop — bounded plan → act → observe.
 * ==================================================================
 * The loop's only actuators are Fabric capabilities. It spawns no
 * process, opens no file and makes no network call of its own; every
 * effect it can cause is a `fabric.invoke(...)`, which means every effect
 * it can cause was validated against the manifest, decided by the one
 * policy engine, gated where policy said so, verified where a check
 * exists, and written to the audit trail.
 *
 * This is a NEW loop and not a change to Mission Control v3.
 * `mission/execution/engine.ts` forbids re-planning and continues to;
 * that engine remains the deterministic governed path for a plan a human
 * approved. This one is for the case Mission Control deliberately does not
 * serve: an objective whose steps are not known in advance. The two do not
 * share a control flow, and neither is allowed to become the other.
 *
 * Every bound below is enforced here, in the controller, by a counter this
 * file owns — never by asking the model to be reasonable.
 *
 * The loop ships behind `agent/flag.ts` and defaults OFF. See that file
 * for why, and for the durability precondition that no configuration can
 * skip.
 */

import type { Runtime, GenerateRequest, RuntimeMessage, RuntimeToolCall } from '@aura/runtime';
import {
  toolSpecsFor,
  type CapabilityFabric,
  type InvocationContext,
  type PolicyEvaluation,
} from '@aura/capability-fabric';
import {
  type AgentBudget,
  type AgentJournal,
  type AgentLimits,
  type AgentRunResult,
  type AutonomyLevel,
  type RunOutcome,
  type StepOutcome,
  type TokenRates,
} from './types';
import { autonomyScope, policyFingerprint, policyMatchesLevel, DEFAULT_AUTONOMY_LEVEL } from './ladder';
import { LimitTracker, costEnforceable, resolveLimits } from './limits';
import { KILL_SWITCH, KillSwitch } from './killSwitch';
import { RunJournalWriter, newRunId } from './journal';
import { captureCheckpoint, isMutating, mayProceedWithout } from './checkpoint';
import {
  countsAsFailure,
  journalUnknownTool,
  readOutcome,
  renderObservation,
  resolveToolCall,
} from './toolBroker';
import type { AgentLoopGate } from './flag';

export interface AgentLoopDeps {
  fabric: CapabilityFabric;
  runtime: Runtime;
  journal: AgentJournal;
  /** Identifier of the model in use. Recorded, never used to route. */
  model: string;
  /**
   * Per-1000-token prices for `model`, when the provider publishes them
   * (`ModelCapabilities.inputCostPer1k` / `outputCostPer1k`). Null means a
   * cost cap cannot be enforced — see `costEnforceable`.
   */
  rates?: TokenRates | null;
  /** Defaults to the process-wide switch, which is what a person pulls. */
  killSwitch?: KillSwitch;
}

export interface AgentRunRequest {
  /** What the run is for, in the user's own words. */
  objective: string;
  /**
   * Correlation and targeting for every invocation this run makes.
   *
   * `actor` and `initiator` are overwritten, not merged — see
   * `contextFor`. Everything else (project, cwd, mission, task, timeout)
   * is carried through so the run's actions are filed where the user
   * expects to find them.
   */
  context: InvocationContext;
  level?: AutonomyLevel;
  limits?: Partial<AgentLimits>;
  /**
   * A capability set narrower than the level's. Widening is not possible:
   * anything outside the level's scope is dropped, silently on purpose —
   * a caller asking for more than its level allows has made a mistake, and
   * the mistake should not become the run's authority.
   */
  scope?: readonly string[];
  /** Set when this run is a sub-agent. Recorded in its journal. */
  parentRunId?: string;
  temperature?: number;
  /** Cap on ONE turn's completion. The run-wide budget is in `limits`. */
  maxTokensPerTurn?: number;
}

/* ══════════════════════════════════════════════════════════════════
   Prompt
   ══════════════════════════════════════════════════════════════════ */

/**
 * The system prompt.
 *
 * Written to be true rather than persuasive. Everything it says about
 * governance is enforced elsewhere and would hold if the model ignored
 * every word of it — the point of stating it is that a model which knows
 * an action will be refused does not waste an iteration discovering it,
 * and a model which knows what `unknown` means does not retry a step that
 * may already have happened.
 */
function systemPrompt(objective: string, limits: AgentLimits, level: AutonomyLevel): string {
  return [
    'You are AURA acting on a stated objective by calling capabilities.',
    '',
    `OBJECTIVE: ${objective}`,
    '',
    'How this works:',
    '- The tools you were given are AURA capabilities. Calling one is a REQUEST.',
    '  AURA re-validates the name against its manifest, re-runs its policy engine and',
    '  re-checks permissions before anything happens. Naming a tool you were not given,',
    '  or arguments outside a tool’s declared schema, is refused and recorded.',
    '- Some actions need a person. When a result says `requires-approval`, NOTHING RAN.',
    '  Do not retry it; either work around it or explain what needs authorizing.',
    '- Every result carries an `outcome`:',
    '    success           it ran and nothing contradicted it',
    '    partial           it ran; the effect could not be confirmed',
    '    failure           it did not run, or provably had no effect',
    '    unknown           it MAY have taken effect. Never repeat it as if it had not.',
    '    not-executed      refused before anything happened',
    '    requires-approval parked on a person; has not run',
    '',
    'Your bounds for this run:',
    `- at most ${limits.maxIterations} turns and ${limits.maxToolCalls} actions in total`,
    `- at most ${limits.maxToolCallsPerIteration} actions per turn`,
    `- the run stops after ${limits.maxConsecutiveFailures} steps in a row that do not succeed`,
    `- autonomy level ${level}: anything above it needs a person, whatever you ask for`,
    '',
    'Work in small steps. Read before you write. When the objective is met — or you can',
    'establish that it cannot be met — stop calling tools and answer in plain language,',
    'saying what you did, what you could not do, and why.',
  ].join('\n');
}

/* ══════════════════════════════════════════════════════════════════
   Context
   ══════════════════════════════════════════════════════════════════ */

/**
 * The context every invocation in this run carries.
 *
 * Two fields are overwritten rather than merged, and both matter:
 *
 *   actor      forced to `kind: 'agent'`. A run acting on its own is an
 *              agent by definition, and letting a caller label it
 *              otherwise would put a false attribution in the audit trail.
 *   initiator  forced to `request`. `user-direct` is an attested statement
 *              by the transport that a person clicked a labelled control,
 *              and it suppresses a policy floor. Nothing in an autonomous
 *              loop can honestly claim it, so it is stripped here even if
 *              a caller set it — a mistake at a call site must not be able
 *              to buy the loop a floor exemption.
 *
 * `approvedCapabilities` and `resumeApprovalId` are dropped for the same
 * reason: an approval a caller was carrying belongs to the call it was
 * given for, and must not become a blanket grant for every step of a run.
 */
function contextFor(request: AgentRunRequest, runId: string): InvocationContext {
  const {
    approvedCapabilities: _approved,
    resumeApprovalId: _resume,
    initiator: _initiator,
    actor: _actor,
    ...rest
  } = request.context;
  return {
    ...rest,
    actor: { kind: 'agent', id: `agent:loop:${runId}` },
    initiator: 'request',
  };
}

/* ══════════════════════════════════════════════════════════════════
   The loop
   ══════════════════════════════════════════════════════════════════ */

/**
 * The result of racing work against the kill switch.
 *
 * A tagged union rather than a sentinel value, so the compiler refuses any
 * path that reads a response field off a kill. That is not fussiness: the
 * failure it prevents is reporting an abandoned step as though its result
 * had arrived, which is precisely the "unknown became a success" error the
 * outcome vocabulary exists to make impossible.
 */
type Raced<T> = { killed: true } | { killed: false; value: T };

/**
 * Await `work`, unless the switch is pulled first.
 *
 * Written by hand rather than with `Promise.race` for two reasons that
 * both bite in a long run:
 *
 *   • The kill listener is UNREGISTERED whichever side wins. A race would
 *     leave one listener per tool call attached to a process-wide switch —
 *     two hundred of them by the end of a capped run, all firing at once
 *     on a kill that arrived afterwards.
 *   • `work` always has a handler attached, so abandoning it on a kill
 *     cannot surface as an unhandled rejection. Losing a race is a normal
 *     outcome here; taking the process down for it would not be.
 */
function raceKill<T>(work: Promise<T>, kill: KillSwitch): Promise<Raced<T>> {
  if (kill.halted) {
    work.catch(() => { /* abandoned deliberately */ });
    return Promise.resolve({ killed: true });
  }
  return new Promise<Raced<T>>((resolve, reject) => {
    const off = kill.onTrip(() => { off(); resolve({ killed: true }); });
    work.then(
      (value) => { off(); resolve({ killed: false, value }); },
      (error) => { off(); reject(error); },
    );
  });
}

export async function runAgentLoop(
  gate: AgentLoopGate,
  deps: AgentLoopDeps,
  request: AgentRunRequest,
): Promise<AgentRunResult> {
  const runId = newRunId(request.parentRunId ? 'sub' : 'run');
  const level = request.level ?? DEFAULT_AUTONOMY_LEVEL;
  const limits = resolveLimits(request.limits);
  const rates = deps.rates ?? null;
  const kill = deps.killSwitch ?? KILL_SWITCH;

  const refuse = (detail: string): AgentRunResult => ({
    runId,
    outcome: 'refused',
    answer: '',
    detail,
    iterations: 0,
    toolCalls: 0,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    costUsd: null,
    steps: [],
    pendingApprovals: [],
    budget: { limits, scope: [] },
  });

  /* ── preconditions, all of which refuse rather than degrade ──── */

  if (!gate.enabled) return refuse(gate.reason);

  if (kill.halted) {
    const report = kill.report();
    return refuse(
      `AURA is halted (${report.reason ?? 'no reason recorded'}, by ${report.by ?? 'unknown'}). `
      + 'Re-arm it before starting new work.',
    );
  }

  if (!costEnforceable(limits, rates)) {
    // Fail closed. A cost cap that cannot be measured is not a weak cap,
    // it is no cap wearing the word, and the user set it precisely so they
    // would not be surprised.
    return refuse(
      `A $${limits.maxCostUsd} spend limit was set, but ${deps.model} publishes no per-token prices, `
      + 'so the limit could not be enforced. The run was not started.',
    );
  }

  const policy = deps.fabric.getPolicy();
  if (!policyMatchesLevel(level, policy)) {
    return refuse(
      `The policy installed on this machine is not the one autonomy level ${level} describes, `
      + 'so the run would have been governed by rules other than the ones it claims. '
      + 'Set the level through the policy store and try again.',
    );
  }

  /* ── budget ──────────────────────────────────────────────────── */

  const levelScope = new Set(autonomyScope(level, deps.fabric.supported()));
  const scope = request.scope
    // Narrowing only. A requested capability outside the level's scope is
    // dropped, never granted — a caller cannot widen its own authority by
    // asking for more.
    ? request.scope.filter((id) => levelScope.has(id))
    : [...levelScope];

  if (scope.length === 0) {
    return refuse(
      `Autonomy level ${level} leaves this run no capabilities it may call, so there is nothing for it to do.`,
    );
  }

  const { tools } = toolSpecsFor(scope);
  const prompt = systemPrompt(request.objective, limits, level);

  /* ── journal ─────────────────────────────────────────────────── */

  const journal = new RunJournalWriter(deps.journal, runId);
  journal.write('run.started', {
    parentRunId: request.parentRunId,
    objective: request.objective,
    systemPrompt: prompt,
    level,
    limits,
    scope,
    policy: policyFingerprint(policy),
    model: deps.model,
  });

  /* ── state ───────────────────────────────────────────────────── */

  const context = contextFor(request, runId);
  const tracker = new LimitTracker(limits, rates);
  tracker.begin();

  const messages: RuntimeMessage[] = [
    { role: 'system', content: prompt },
    { role: 'user', content: request.objective },
  ];
  const steps: AgentRunResult['steps'] = [];
  const pendingApprovals: string[] = [];
  const inFlight = new Set<string>();

  let outcome: RunOutcome = 'completed';
  let limitHit: keyof AgentLimits | undefined;
  let answer = '';
  let detail = '';
  let consecutiveParkedIterations = 0;

  const finish = (): AgentRunResult => {
    journal.write('run.finished', {
      outcome,
      iterations: tracker.iterationCount,
      toolCalls: tracker.toolCallCount,
      promptTokens: tracker.usage.promptTokens,
      completionTokens: tracker.usage.completionTokens,
      costUsd: tracker.costUsd,
      answer,
    });
    return {
      runId,
      outcome,
      limit: limitHit,
      answer,
      detail: detail || answer,
      iterations: tracker.iterationCount,
      toolCalls: tracker.toolCallCount,
      usage: tracker.usage,
      costUsd: tracker.costUsd,
      steps,
      pendingApprovals,
      budget: { limits, scope },
    };
  };

  const recordKill = () => {
    const report = kill.report();
    journal.write('kill', {
      by: report.by ?? 'unknown',
      reason: report.reason ?? 'no reason recorded',
      inFlight: [...inFlight],
    });
    outcome = 'killed';
    detail = `Stopped: ${report.reason ?? 'the kill switch was pulled'}.`;
  };

  /* ── plan → act → observe ────────────────────────────────────── */

  for (;;) {
    if (kill.halted) { recordKill(); return finish(); }

    const breach = tracker.breachBeforeTurn();
    if (breach) {
      journal.write('limit.reached', { limit: breach.limit, observed: breach.observed, cap: breach.cap });
      outcome = 'limit-reached';
      limitHit = breach.limit;
      detail = breach.reason;
      return finish();
    }

    /* ── plan ── */

    const generateRequest: GenerateRequest = {
      messages,
      model: deps.model,
      tools,
      toolChoice: 'auto',
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.maxTokensPerTurn !== undefined ? { maxTokens: request.maxTokensPerTurn } : {}),
    };

    tracker.countIteration();
    const iteration = tracker.iterationCount;

    // Racing the switch rather than waiting the request out: a halted loop
    // sitting through a 30-second generate is a halted loop still spending
    // the budget it was halted to stop spending.
    let turn: Raced<Awaited<ReturnType<Runtime['generate']>>>;
    try {
      turn = await raceKill(deps.runtime.generate(generateRequest), kill);
    } catch (error) {
      outcome = 'failed';
      detail = `The model could not be reached: ${(error as Error).message}`;
      journal.write('model.turn', {
        iteration, text: '', finishReason: 'error',
        promptTokens: 0, completionTokens: 0, requested: [],
      });
      return finish();
    }

    if (turn.killed) {
      // Tear the request down rather than let it finish into a halted loop.
      deps.runtime.cancel();
      recordKill();
      return finish();
    }
    const response = turn.value;

    tracker.countUsage(response.usage.promptTokens, response.usage.completionTokens);
    const calls: RuntimeToolCall[] = response.toolCalls ?? [];

    journal.write('model.turn', {
      iteration,
      text: response.content,
      finishReason: response.finishReason,
      promptTokens: response.usage.promptTokens,
      completionTokens: response.usage.completionTokens,
      requested: calls.map((c) => ({ id: c.id, name: c.name, argumentsSummary: '' })),
    });

    if (calls.length === 0) {
      // No tools asked for. The model has said what it has to say.
      answer = response.content;
      outcome = pendingApprovals.length ? 'blocked-on-approval' : 'completed';
      detail = pendingApprovals.length
        ? `Stopped: ${pendingApprovals.length} action(s) are waiting on your authorization.`
        : 'The objective was answered without further actions.';
      return finish();
    }

    /* ── act ── */

    // The per-iteration cap is enforced by TAKING the first N, and telling
    // the model the rest were not attempted. Silently dropping them would
    // leave it believing work happened that never did.
    const attempted = calls.slice(0, limits.maxToolCallsPerIteration);
    const overflow = calls.slice(limits.maxToolCallsPerIteration);

    messages.push({
      role: 'assistant',
      content: response.content,
      toolCalls: calls,
    });

    let parkedThisIteration = 0;

    for (const call of attempted) {
      if (kill.halted) { recordKill(); return finish(); }

      const callBreach = tracker.breachBeforeToolCall();
      if (callBreach) {
        journal.write('limit.reached', { limit: callBreach.limit, observed: callBreach.observed, cap: callBreach.cap });
        messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: JSON.stringify({ outcome: 'not-executed', detail: callBreach.reason }) });
        outcome = 'limit-reached';
        limitHit = callBreach.limit;
        detail = callBreach.reason;
        return finish();
      }

      const resolved = resolveToolCall(call, new Set(scope));

      if (!resolved.ok) {
        // A name that is not a capability is a request for a capability,
        // and belongs in the audit trail whether or not it was honoured.
        // Anything the loop refused first (scope, malformed arguments) did
        // NOT reach the execution authority, and inventing an invocation
        // for it would put a call in the audit trail that was never made.
        const invocationId = resolved.rule === 'unknown-tool'
          ? await journalUnknownTool(deps.fabric, call.name, context)
          : undefined;

        journal.write('tool.refused', {
          iteration,
          requestedName: call.name,
          argumentsSummary: resolved.argumentsSummary,
          rule: resolved.rule,
          reason: resolved.reason,
          invocationId,
        });
        messages.push({
          role: 'tool', toolCallId: call.id, name: call.name,
          content: JSON.stringify({ outcome: 'not-executed', detail: resolved.reason }),
        });
        tracker.recordStep(true);
        continue;
      }

      const { capability, input } = resolved;
      tracker.countToolCall();

      /* ── checkpoint before mutation ── */

      // Asked BEFORE the action, through the existing pre-flight API, so
      // "is a person already gating this" is answered by the one policy
      // engine rather than guessed at from the risk level.
      const evaluation: PolicyEvaluation | null = deps.fabric.evaluate(capability.id, context);
      const gated = evaluation ? evaluation.decision !== 'auto-execute' : true;

      if (isMutating(capability)) {
        const checkpoint = await captureCheckpoint(deps.fabric, capability.id, input, context);
        journal.write('checkpoint', {
          iteration,
          capabilityId: capability.id,
          captured: checkpoint.captured,
          via: checkpoint.captured ? checkpoint.via : undefined,
          invocationId: checkpoint.invocationId,
          why: checkpoint.captured ? undefined : checkpoint.why,
        });

        const verdict = mayProceedWithout(checkpoint, gated);
        if (!verdict.ok) {
          journal.write('tool.refused', {
            iteration,
            requestedName: call.name,
            argumentsSummary: resolved.argumentsSummary,
            rule: 'no-checkpoint',
            reason: verdict.reason,
          });
          messages.push({
            role: 'tool', toolCallId: call.id, name: call.name,
            content: JSON.stringify({ outcome: 'not-executed', detail: verdict.reason }),
          });
          tracker.recordStep(true);
          continue;
        }
      }

      /* ── invoke ── */

      inFlight.add(capability.id);
      const invocation = deps.fabric.invoke(capability.id, input, context);
      const settled = await raceKill(invocation, kill);
      inFlight.delete(capability.id);

      if (settled.killed) {
        // The invocation is left to the Fabric. It runs under the Fabric's
        // own bounds and writes its own audit record when it settles; the
        // loop simply stops waiting. Reporting it as anything other than
        // `unknown` would claim knowledge of an outcome nobody has yet.
        // See killSwitch.ts for why there is no cancellation port, and
        // `raceKill` for why abandoning it cannot become an unhandled
        // rejection.
        recordKill();
        return finish();
      }

      const result = settled.value;
      const stepOutcome: StepOutcome = readOutcome(result, capability);
      const observation = renderObservation(result, stepOutcome);

      journal.write('tool.result', {
        iteration,
        capabilityId: capability.id,
        invocationId: result.invocationId,
        outcome: stepOutcome,
        fabricOutcome: result.outcome,
        verified: result.verification.passed,
        policyRule: result.policy.rule,
        risk: result.policy.risk,
        approvalId: result.approvalId,
        observation,
      });

      steps.push({
        capabilityId: capability.id,
        invocationId: result.invocationId,
        outcome: stepOutcome,
        detail: result.detail,
      });
      if (stepOutcome === 'requires-approval') {
        parkedThisIteration += 1;
        if (result.approvalId) pendingApprovals.push(result.approvalId);
      }

      messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: observation });
      tracker.recordStep(countsAsFailure(stepOutcome));
    }

    for (const call of overflow) {
      messages.push({
        role: 'tool', toolCallId: call.id, name: call.name,
        content: JSON.stringify({
          outcome: 'not-executed',
          detail: `Only ${limits.maxToolCallsPerIteration} actions may be requested per turn. This one was not attempted — ask for it again next turn if you still need it.`,
        }),
      });
    }

    /* ── observe ── */

    // Two turns in a row where every action parked means the run cannot
    // make progress without a person. Continuing would burn iterations
    // re-asking questions that are already waiting for an answer.
    consecutiveParkedIterations = parkedThisIteration > 0 && parkedThisIteration === attempted.length
      ? consecutiveParkedIterations + 1
      : 0;

    if (consecutiveParkedIterations >= 2) {
      outcome = 'blocked-on-approval';
      detail = `Every action for two turns is waiting on your authorization (${pendingApprovals.length} pending). Nothing further can run until they are answered.`;
      answer = response.content;
      return finish();
    }
  }
}

/** The budget a run was actually given, for anything deriving a sub-agent. */
export function budgetOf(limits: AgentLimits, scope: readonly string[]): AgentBudget {
  return { limits, scope };
}
