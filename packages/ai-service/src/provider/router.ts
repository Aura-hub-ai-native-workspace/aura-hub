/**
 * router — which model, and what happens when it is not there.
 * ==================================================================
 * `RuntimeManager` holds exactly one `active` runtime and the retry loop
 * in `pipeline.ts` retries the SAME provider. So a provider that is down,
 * rate-limited, or simply unreachable because the machine is offline
 * meant AURA had no answer at all — and a piece of work that must not
 * leave the machine had no way to say so.
 *
 * This module makes both decidable. It is a **pure decision function**:
 * it takes a request's shape and the connected providers, and returns an
 * ordered chain of candidates plus the reason every rejected one was
 * rejected. It performs no I/O, activates nothing, and holds no state,
 * so its decisions are reproducible and testable — the same property the
 * policy engine has, for the same reason.
 *
 * ── Rule order (fixed, and the order matters) ─────────────────────
 *   1. PRIVACY   — `secret` context never leaves this machine. Checked
 *                  first, so nothing downstream can trade privacy for
 *                  capability, cost or availability.
 *   2. CAPABILITY— a task that needs tool calling cannot run on a model
 *                  that has none. An unfit model is not a cheap model.
 *   3. CONTEXT   — the prompt must fit `contextWindow`. This is the gate
 *                  that finally reads the field.
 *   4. COST      — among what is left, cheapest-and-healthy first; an
 *                  explicit per-call budget removes what exceeds it.
 *   5. FALLBACK  — the survivors, ordered: preferred/active provider →
 *                  sibling cloud provider → local model → refuse.
 *
 * Refusing is a real outcome and is returned as one. A router that always
 * answers is a router that will eventually answer with the wrong model.
 */

import type { ModelCapabilities } from './types';

/**
 * How sensitive the context of this request is.
 *
 * `secret` is the only level with a hard rule attached: it may not leave
 * the machine, ever, for any reason, including "no local model is
 * available" — in which case the correct answer is no answer.
 */
export type Sensitivity = 'public' | 'internal' | 'confidential' | 'secret';

export type TaskKind =
  | 'chat' | 'code' | 'plan' | 'review' | 'summarize' | 'classify' | 'embed';

export interface RouteRequest {
  taskKind: TaskKind;
  sensitivity: Sensitivity;
  /** Measured by `tokenizer/`, not guessed. See `contextGate`. */
  promptTokens: number;
  /** Head-room to reserve for the reply. Defaults to `DEFAULT_OUTPUT_RESERVE`. */
  expectedOutputTokens?: number;
  requiresTools?: boolean;
  requiresVision?: boolean;
  requiresJsonMode?: boolean;
  /** USD ceiling for THIS call. Absent means no budget constraint. */
  maxCostUsd?: number;
  /**
   * Is the machine's outbound network usable right now?
   *
   * Supplied by the caller because the router does no I/O. False removes
   * every non-local candidate — which is what turns "offline" from a
   * cascade of timeouts into one immediate, correct decision.
   */
  networkUp?: boolean;
  /** The provider to try first when it survives the gates (usually the active one). */
  preferProviderId?: string;
}

export interface RouteCandidate {
  providerId: string;
  providerName: string;
  modelId: string;
  /** The model runs on this machine. Asserted by the adapter, not inferred. */
  local: boolean;
  capabilities: ModelCapabilities;
  /** Last known health. Unknown (null) is treated as usable but ranked below healthy. */
  healthy: boolean | null;
  /** Last measured round-trip in ms, when known. Used only to break cost ties. */
  latencyMs?: number;
}

export type RouteRule =
  | 'privacy-gate'
  | 'capability-gate'
  | 'context-gate'
  | 'budget-gate'
  | 'network-gate'
  | 'no-candidates'
  | 'routed';

export interface RouteRejection {
  providerId: string;
  modelId: string;
  rule: RouteRule;
  reason: string;
}

export interface RouteDecision {
  ok: boolean;
  /**
   * Ordered: try `chain[0]`, and on failure `chain[1]`, and so on. Empty
   * exactly when `ok` is false.
   */
  chain: RouteCandidate[];
  rejected: RouteRejection[];
  rule: RouteRule;
  /** Plain language, always with a next step. Shown to the user on a refusal. */
  detail: string;
}

/** Reserve for the reply when the caller does not say. */
export const DEFAULT_OUTPUT_RESERVE = 2048;

/**
 * Assumed context window for a model that never reported one.
 *
 * NOT a guess dressed as a fact: it is used only by the context gate, and
 * only to avoid rejecting every model whose provider does not publish a
 * window. It is deliberately small, so an unknown model is preferred for
 * small prompts and skipped for large ones — failing toward the model
 * that is known to fit.
 */
export const UNKNOWN_CONTEXT_WINDOW = 8192;

/* ── 1. privacy ────────────────────────────────────────────────── */

/**
 * The one rule with no exceptions.
 *
 * `secret` means the text must not be transmitted. A cloud provider is
 * transmission by definition, so it is removed here — before capability,
 * before cost, before availability — so that no later stage can be the
 * thing that decides privacy loses.
 */
export function privacyGate(candidate: RouteCandidate, request: RouteRequest): string | null {
  if (request.sensitivity !== 'secret') return null;
  if (candidate.local) return null;
  return `${candidate.providerName} runs off this machine, and this request is marked 'secret'. Secret context is never sent to a third party.`;
}

/* ── 2. capability ─────────────────────────────────────────────── */

/**
 * `toolCalling`, `vision` and `jsonMode` are three-valued here: true,
 * false, or absent-meaning-unknown. Only an explicit `false` disqualifies.
 * Refusing every model that merely failed to advertise a capability would
 * disqualify most local models, which report almost nothing.
 */
export function capabilityGate(candidate: RouteCandidate, request: RouteRequest): string | null {
  const caps = candidate.capabilities;
  if (request.requiresTools && caps.toolCalling === false) {
    return `${candidate.modelId} does not support tool calling, which this task needs.`;
  }
  if (request.requiresVision && caps.vision === false) {
    return `${candidate.modelId} cannot read images, which this task needs.`;
  }
  if (request.requiresJsonMode && caps.jsonMode === false && caps.toolCalling === false) {
    return `${candidate.modelId} offers neither JSON mode nor tool calling, so a structured reply cannot be guaranteed.`;
  }
  return null;
}

/* ── 3. context ────────────────────────────────────────────────── */

/**
 * Does the prompt plus its reply fit?
 *
 * This is the gate `ModelCapabilities.contextWindow` was added for and
 * that nothing read. `promptTokens` must come from `tokenizer/` — a
 * `length / 4` number here would make the gate assert something it did
 * not measure.
 */
export function contextGate(candidate: RouteCandidate, request: RouteRequest): string | null {
  const window = candidate.capabilities.contextWindow ?? UNKNOWN_CONTEXT_WINDOW;
  const reserve = request.expectedOutputTokens ?? DEFAULT_OUTPUT_RESERVE;
  const needed = request.promptTokens + reserve;
  if (needed <= window) return null;
  const known = candidate.capabilities.contextWindow !== undefined;
  return `${candidate.modelId} holds ${window.toLocaleString()} tokens${known ? '' : ' (unreported — assumed)'}; this request needs about ${needed.toLocaleString()}.`;
}

/* ── 4. cost ───────────────────────────────────────────────────── */

/** USD for this request on this candidate, or null when it is unpriced. */
export function costOf(candidate: RouteCandidate, request: RouteRequest): number | null {
  const { inputCostPer1k, outputCostPer1k } = candidate.capabilities;
  if (inputCostPer1k === undefined && outputCostPer1k === undefined) return null;
  const out = request.expectedOutputTokens ?? DEFAULT_OUTPUT_RESERVE;
  return ((inputCostPer1k ?? 0) * request.promptTokens + (outputCostPer1k ?? 0) * out) / 1000;
}

export function budgetGate(candidate: RouteCandidate, request: RouteRequest): string | null {
  if (request.maxCostUsd === undefined) return null;
  const cost = costOf(candidate, request);
  // An UNPRICED model is not removed by a budget: AURA does not know it is
  // over, and pretending it is free would be worse than admitting it is
  // unknown. It is ranked last instead (see `rank`).
  if (cost === null) return null;
  if (cost <= request.maxCostUsd) return null;
  return `${candidate.modelId} would cost about $${cost.toFixed(4)} for this request, over the $${request.maxCostUsd.toFixed(4)} budget.`;
}

/* ── 5. ordering ───────────────────────────────────────────────── */

/**
 * The fallback chain's shape: **preferred → sibling cloud → local**.
 *
 * Local last among the survivors rather than first is deliberate and is
 * NOT a privacy statement — anything private was already routed to local
 * by rule 1. Here every survivor is permitted, and a local model is the
 * slowest and usually the least capable of them, so it is the answer when
 * the others are gone rather than the first thing tried.
 */
function tier(candidate: RouteCandidate, request: RouteRequest): number {
  if (candidate.providerId === request.preferProviderId) return 0;
  if (!candidate.local) return 1;
  return 2;
}

function rank(a: RouteCandidate, b: RouteCandidate, request: RouteRequest): number {
  const tierDelta = tier(a, request) - tier(b, request);
  if (tierDelta !== 0) return tierDelta;

  // A provider known to be unhealthy goes after one that is healthy or
  // simply unknown — a failed health check is evidence, an absent one is not.
  const healthScore = (c: RouteCandidate) => (c.healthy === false ? 1 : 0);
  const healthDelta = healthScore(a) - healthScore(b);
  if (healthDelta !== 0) return healthDelta;

  const costA = costOf(a, request);
  const costB = costOf(b, request);
  if (costA !== null && costB !== null && costA !== costB) return costA - costB;
  // Priced beats unpriced: a known number beats an unknown one.
  if (costA !== null && costB === null) return -1;
  if (costA === null && costB !== null) return 1;

  const latencyA = a.latencyMs ?? Number.MAX_SAFE_INTEGER;
  const latencyB = b.latencyMs ?? Number.MAX_SAFE_INTEGER;
  if (latencyA !== latencyB) return latencyA - latencyB;

  return a.modelId.localeCompare(b.modelId);
}

/* ── the decision ──────────────────────────────────────────────── */

export function route(candidates: RouteCandidate[], request: RouteRequest): RouteDecision {
  const rejected: RouteRejection[] = [];
  const survivors: RouteCandidate[] = [];

  for (const candidate of candidates) {
    const reject = (rule: RouteRule, reason: string) => {
      rejected.push({ providerId: candidate.providerId, modelId: candidate.modelId, rule, reason });
    };

    const privacy = privacyGate(candidate, request);
    if (privacy) { reject('privacy-gate', privacy); continue; }

    if (request.networkUp === false && !candidate.local) {
      reject('network-gate', `${candidate.providerName} needs a network connection, and this machine has none right now.`);
      continue;
    }

    const capability = capabilityGate(candidate, request);
    if (capability) { reject('capability-gate', capability); continue; }

    const context = contextGate(candidate, request);
    if (context) { reject('context-gate', context); continue; }

    const budget = budgetGate(candidate, request);
    if (budget) { reject('budget-gate', budget); continue; }

    survivors.push(candidate);
  }

  if (!survivors.length) {
    return {
      ok: false,
      chain: [],
      rejected,
      rule: rejected.length ? rejected[0].rule : 'no-candidates',
      detail: explainRefusal(rejected, request),
    };
  }

  const chain = [...survivors].sort((a, b) => rank(a, b, request));
  const head = chain[0];
  return {
    ok: true,
    chain,
    rejected,
    rule: 'routed',
    detail:
      `${head.providerName} · ${head.modelId}`
      + (head.local ? ' (on this machine)' : '')
      + (chain.length > 1 ? `, with ${chain.length - 1} fallback${chain.length > 2 ? 's' : ''}.` : ', with no fallback.'),
  };
}

/**
 * Why there is no answer, phrased so the user knows what to do.
 *
 * A refusal that only says "no model available" is indistinguishable from
 * a bug. Naming the gate that emptied the field is what makes it a
 * decision.
 */
function explainRefusal(rejected: RouteRejection[], request: RouteRequest): string {
  if (!rejected.length) {
    return 'No AI provider is connected. Connect one in Settings, or install Ollama or LM Studio to run a model on this machine.';
  }
  const counts = new Map<RouteRule, number>();
  for (const r of rejected) counts.set(r.rule, (counts.get(r.rule) ?? 0) + 1);

  if (counts.get('privacy-gate') === rejected.length) {
    return 'This request is marked \'secret\', so it may only run on a model on this machine — and none is available. '
      + 'Install Ollama (`ollama pull llama3.2`) or load a model in LM Studio, then try again. Nothing was sent anywhere.';
  }
  if (counts.get('network-gate') === rejected.length) {
    return 'This machine is offline and every connected provider needs a network connection. '
      + 'Install Ollama or LM Studio to keep working offline, or reconnect and try again.';
  }
  if ((counts.get('context-gate') ?? 0) > 0 && (counts.get('context-gate') ?? 0) === rejected.length) {
    return `About ${request.promptTokens.toLocaleString()} tokens of context is more than any connected model can hold. `
      + 'Narrow the question, or connect a model with a larger context window.';
  }
  const first = rejected[0];
  return `No connected model can run this request. Closest was ${first.modelId}: ${first.reason}`;
}
