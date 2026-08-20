/**
 * Budget - score, allocate, compress, and REFUSE.
 * ==================================================================
 * Harvested from `packages/retrieval/src/budget/tokenBudget.ts`, which
 * contained a correct, deterministic global allocator and a compressor
 * strategy interface, and had zero importers. `packages/retrieval` was
 * never dead code; it was unwired code. What is kept:
 *
 *   - `BudgetAllocator.allocate()`  - the priority split with a single
 *     redistribution pass of leftover from capped groups. Arithmetic
 *     preserved exactly; the unit changed from "engine" to "group",
 *     because the thing being budgeted is now a class of context item
 *     rather than a retrieval engine.
 *   - the `Compressor` strategy interface and `TruncateCompressor`.
 *
 * What is NOT kept: `PlaceholderSummarizeCompressor`, which fell back to
 * truncation while claiming the `summarize` id. A compressor that lies
 * about what it did makes the "which compression was applied" record on
 * each item worthless, and that record is the point.
 *
 * -- What did not exist before, at all --------------------------------
 * ENFORCEMENT. Both prompt paths concatenated whatever they had and sent
 * it. There was no ceiling, no measurement against the model's window,
 * and no failure mode - an over-long prompt became the provider's
 * problem, surfacing as a 400 with no indication of what was too big.
 *
 * The ladder here is: DROP -> TRUNCATE -> SUMMARISE, in that order, and
 * what was applied is recorded on the item. If the floor (the parts that
 * cannot be compressed - the system rules and the user's own task) still
 * does not fit, the assembly REFUSES with a typed error naming exactly
 * what was dropped. It never silently truncates.
 */

import type { ContextItem } from './item';
import { estimateTokens, itemText } from './item';

/* -- Model window ---------------------------------------------------- */

/**
 * The provider registry (`provider/types.ts: ModelCapabilities.contextWindow`)
 * is the authority for how large a model's window is. This module never
 * looks a model up - the caller passes the number in. `FALLBACK_WINDOW`
 * applies only when the registry itself does not know, and is
 * deliberately small: guessing large is how you discover the real window
 * as a runtime failure.
 */
export const FALLBACK_WINDOW = 8_192;

/**
 * Fraction of the window the assembled context may occupy.
 *
 * The rest is headroom for the model's own reply and for the error in
 * the interim `length / 4` estimate. 1M tokens is a CEILING, NOT A
 * TARGET: the goal is the smallest context that answers the question.
 */
export const DEFAULT_CONTEXT_FRACTION = 0.6;

export interface BudgetSpec {
  /** Model id, recorded on the result so a budget decision is attributable. */
  model: string;
  /** The model's context window in tokens, from the provider registry. */
  windowTokens: number;
  /** Tokens reserved for the model's reply. Defaults to `maxOutput` if known. */
  reserveTokens?: number;
  /** Override the 0..1 fraction of the window context may occupy. */
  contextFraction?: number;
}

/** Tokens actually available to the assembled context. */
export function availableTokens(spec: BudgetSpec): number {
  const window = spec.windowTokens > 0 ? spec.windowTokens : FALLBACK_WINDOW;
  const fraction = spec.contextFraction ?? DEFAULT_CONTEXT_FRACTION;
  const reserve = spec.reserveTokens ?? 0;
  return Math.max(0, Math.floor(window * fraction) - reserve);
}

/* -- Compressors ------------------------------------------------------ */

export type CompressionId = 'none' | 'truncate' | 'summarize';

export interface Compressor {
  readonly id: CompressionId;
  compress(text: string, targetTokens: number): { text: string; compressed: boolean };
}

export const NoopCompressor: Compressor = {
  id: 'none',
  compress: (text) => ({ text, compressed: false }),
};

/** Harvested verbatim in behaviour from the retrieval package. */
export const TruncateCompressor: Compressor = {
  id: 'truncate',
  compress(text, targetTokens) {
    if (estimateTokens(text) <= targetTokens) return { text, compressed: false };
    const maxChars = Math.max(0, targetTokens * 4 - 1);
    return { text: text.slice(0, maxChars).trimEnd() + '…', compressed: true };
  },
};

/**
 * Extractive summarisation. Real, deterministic, and honest about being
 * extractive: it selects the highest-signal lines from the text rather
 * than paraphrasing, so nothing it emits was not in the input.
 *
 * That property matters more than fluency here. An abstractive
 * summariser needs a model call, which would make context assembly
 * depend on the thing it is assembling context FOR, and would put
 * generated text into a prompt while claiming it came from a file. When
 * a model-backed summariser is wired, it must produce a NEW context item
 * with `producer: { kind: 'model' }` rather than quietly replacing the
 * value of an existing one.
 */
export const ExtractiveSummarizeCompressor: Compressor = {
  id: 'summarize',
  compress(text, targetTokens) {
    if (estimateTokens(text) <= targetTokens) return { text, compressed: false };
    const lines = text.split(/\r?\n/);
    if (lines.length < 4) return TruncateCompressor.compress(text, targetTokens);

    /* Score lines by information density: declarations, headings and
       non-blank structural lines beat continuation and closing-brace
       lines. Order is preserved so the extract still reads top-down. */
    const scored = lines.map((line, index) => {
      const t = line.trim();
      let s = 0;
      if (!t) s -= 5;
      if (/^(#{1,6})\s/.test(t)) s += 4;
      if (/^(export|public|def|class|interface|type|function|fn|impl|struct|enum)\b/.test(t)) s += 4;
      if (/^(import|from|use|require)\b/.test(t)) s += 1;
      if (/^[}\])]+;?$/.test(t)) s -= 3;
      if (/^(\/\/|\*|#)/.test(t)) s -= 1;
      s += Math.min(2, t.length / 40);
      return { line, index, s };
    });

    const keep: typeof scored = [];
    let used = 0;
    const budgetChars = targetTokens * 4;
    for (const cand of [...scored].sort((a, b) => b.s - a.s)) {
      if (used + cand.line.length + 1 > budgetChars) continue;
      keep.push(cand);
      used += cand.line.length + 1;
    }
    if (keep.length === 0) return TruncateCompressor.compress(text, targetTokens);

    keep.sort((a, b) => a.index - b.index);
    const out: string[] = [];
    let prev = -1;
    for (const k of keep) {
      if (prev >= 0 && k.index > prev + 1) out.push(`... ${k.index - prev - 1} line(s) omitted ...`);
      out.push(k.line);
      prev = k.index;
    }
    const joined = out.join('\n');
    // The elision markers can push it back over; truncate the extract, not the source.
    if (estimateTokens(joined) > targetTokens) return TruncateCompressor.compress(joined, targetTokens);
    return { text: joined, compressed: true };
  },
};

const COMPRESSORS: Record<CompressionId, Compressor> = {
  none: NoopCompressor,
  truncate: TruncateCompressor,
  summarize: ExtractiveSummarizeCompressor,
};

export const getCompressor = (id: CompressionId): Compressor => COMPRESSORS[id];

/* -- Group allocation (harvested BudgetAllocator) --------------------- */

export interface GroupBudgetConfig {
  /** Max tokens this group may contribute. */
  maxContext: number;
  /** Weight (0..1) in the global allocation between groups. */
  priority: number;
  /** How this group shrinks an item that does not fit. */
  compression: CompressionId;
}

export interface GlobalBudget {
  maxTokens: number;
  reserveTokens?: number;
}

/**
 * Splits the global budget across groups by priority, capped by each
 * group's `maxContext`. Deterministic. Leftover from capped groups is
 * redistributed once to uncapped groups.
 *
 * Arithmetic preserved from `retrieval/src/budget/tokenBudget.ts:79-98`.
 */
export class BudgetAllocator {
  constructor(private readonly global: GlobalBudget) {}

  allocate(groups: { id: string; config: GroupBudgetConfig }[]): Map<string, number> {
    const available = Math.max(0, this.global.maxTokens - (this.global.reserveTokens ?? 0));
    const totalPriority = groups.reduce((s, g) => s + Math.max(0, g.config.priority), 0) || 1;

    const result = new Map<string, number>();
    let leftover = 0;
    const uncapped: { id: string; config: GroupBudgetConfig }[] = [];

    for (const g of groups) {
      const fair = Math.floor((Math.max(0, g.config.priority) / totalPriority) * available);
      const grant = Math.min(fair, g.config.maxContext);
      result.set(g.id, grant);
      if (grant < fair) leftover += fair - grant;
      else uncapped.push(g);
    }

    if (leftover > 0 && uncapped.length) {
      const share = Math.floor(leftover / uncapped.length);
      for (const g of uncapped) {
        const cur = result.get(g.id) ?? 0;
        result.set(g.id, Math.min(g.config.maxContext, cur + share));
      }
    }
    return result;
  }
}

/**
 * Default per-kind budget policy.
 *
 * `maxContext` is `Number.MAX_SAFE_INTEGER` for the kinds that should
 * absorb leftover, and finite for the kinds that should not grow without
 * bound however much room there is - environment listings and mission
 * state say everything they have to say in a few hundred tokens, and
 * spending 40k on them because the window is large is exactly the "1M is
 * a target" mistake.
 */
export const DEFAULT_GROUP_POLICY: Record<ContextItem['kind'], GroupBudgetConfig> = {
  turn: { maxContext: 12_000, priority: 0.9, compression: 'truncate' },
  chunk: { maxContext: Number.MAX_SAFE_INTEGER, priority: 1.0, compression: 'summarize' },
  file: { maxContext: Number.MAX_SAFE_INTEGER, priority: 0.9, compression: 'summarize' },
  memory: { maxContext: 6_000, priority: 0.7, compression: 'truncate' },
  'tool-result': { maxContext: 8_000, priority: 0.8, compression: 'truncate' },
  git: { maxContext: 1_500, priority: 0.5, compression: 'truncate' },
  env: { maxContext: 1_500, priority: 0.4, compression: 'truncate' },
  mission: { maxContext: 1_500, priority: 0.5, compression: 'truncate' },
  event: { maxContext: 1_500, priority: 0.3, compression: 'truncate' },
  app: { maxContext: 2_000, priority: 0.3, compression: 'truncate' },
  web: { maxContext: 8_000, priority: 0.6, compression: 'summarize' },
};

/* -- Enforcement ------------------------------------------------------ */

/** What happened to one item on the way into (or out of) the prompt. */
export interface BudgetDecision {
  id: string;
  kind: ContextItem['kind'];
  /** Tokens before any compression. */
  originalTokens: number;
  /** Tokens as included. Zero when dropped. */
  finalTokens: number;
  compression: CompressionId | 'dropped';
  /** Why it is in, or why it is out. Never empty. */
  reason: string;
}

export interface BudgetResult {
  /** Items as they should be rendered, in rank order, already compressed. */
  included: ContextItem[];
  decisions: BudgetDecision[];
  /** Tokens the included items occupy. */
  usedTokens: number;
  /** Tokens the items were allowed. */
  itemBudget: number;
  /** Tokens the whole assembly is allowed. */
  totalBudget: number;
  model: string;
}

/**
 * Thrown when the assembly cannot be made to fit.
 *
 * This is the failure mode that did not exist. It carries the numbers and
 * the names, because "context too large" without saying what was dropped
 * is not actionable by a user OR by a caller deciding what to retry with.
 */
export class ContextBudgetExceededError extends Error {
  readonly code = 'CONTEXT_BUDGET_EXCEEDED' as const;
  constructor(
    readonly model: string,
    readonly requiredTokens: number,
    readonly budgetTokens: number,
    readonly dropped: BudgetDecision[],
    readonly floorTokens: number,
  ) {
    const names = dropped.length
      ? dropped.map((d) => `${d.kind}:${d.id} (${d.originalTokens}t)`).join(', ')
      : 'nothing - the incompressible floor alone is over budget';
    super(
      `Context does not fit ${model}: ${requiredTokens} tokens required, ${budgetTokens} available. ` +
      `The incompressible floor (system rules and the task) is ${floorTokens} tokens. Dropped: ${names}.`,
    );
    this.name = 'ContextBudgetExceededError';
  }
}

export interface EnforceInput {
  /** Ranked candidates, best-first. Each MUST already carry a relevance reason. */
  items: readonly ContextItem[];
  spec: BudgetSpec;
  /**
   * Tokens the assembly must spend no matter what: the system rules and
   * the user's task. Cannot be compressed and cannot be dropped.
   */
  floorTokens: number;
  /** Per-kind policy override. */
  policy?: Partial<Record<ContextItem['kind'], GroupBudgetConfig>>;
  /**
   * Ids that must be included if the budget allows anything at all -
   * pinned memories, the file the user explicitly named. Protection is a
   * SEPARATE decision from ranking, on purpose.
   */
  floorItemIds?: readonly string[];
}

/**
 * DROP -> TRUNCATE -> SUMMARISE, then refuse.
 *
 * The order is the one that preserves the most meaning per token spent:
 * losing the least relevant item entirely costs less than mangling the
 * most relevant one. Within a group, items are taken best-first; the
 * first that does not fit whole is offered its group's compressor, and
 * only if the compressed form fits AND still carries enough to be worth
 * a line is it kept.
 */
export function enforceBudget(input: EnforceInput): BudgetResult {
  const total = availableTokens(input.spec);
  const itemBudget = Math.max(0, total - input.floorTokens);
  const policy = { ...DEFAULT_GROUP_POLICY, ...(input.policy ?? {}) };
  const protectedIds = new Set(input.floorItemIds ?? []);

  if (input.floorTokens > total) {
    /* The floor alone is over. Nothing can be dropped to fix this, so
       there is nothing to try - refuse immediately and say so. */
    throw new ContextBudgetExceededError(
      input.spec.model, input.floorTokens, total,
      input.items.map((i) => decisionFor(i, 'dropped', 0, 'the incompressible floor alone exceeds the budget')),
      input.floorTokens,
    );
  }

  /* Which groups are present, and what each may spend. */
  const present = [...new Set(input.items.map((i) => i.kind))];
  const allocator = new BudgetAllocator({ maxTokens: itemBudget });
  const grants = allocator.allocate(present.map((k) => ({ id: k, config: policy[k] })));

  const decisions: BudgetDecision[] = [];
  const included: ContextItem[] = [];
  const spentByGroup = new Map<string, number>();
  let used = 0;

  /* Protected items first, at their group's expense, so a pin cannot be
     starved by a merely high-scoring chunk that happened to rank above it. */
  const ordered = [
    ...input.items.filter((i) => protectedIds.has(i.id)),
    ...input.items.filter((i) => !protectedIds.has(i.id)),
  ];

  for (const item of ordered) {
    const grant = grants.get(item.kind) ?? 0;
    const spent = spentByGroup.get(item.kind) ?? 0;
    const groupRoom = Math.max(0, grant - spent);
    const globalRoom = Math.max(0, itemBudget - used);
    const room = Math.min(groupRoom, globalRoom);
    const isProtected = protectedIds.has(item.id);

    if (item.tokens <= room) {
      included.push(item);
      used += item.tokens;
      spentByGroup.set(item.kind, spent + item.tokens);
      decisions.push(decisionFor(item, 'none', item.tokens, item.relevance?.reason ?? 'included'));
      continue;
    }

    /* Does not fit whole. Offer it the group's compressor - but only if
       there is enough room left for a compressed form to say anything.
       MIN_USEFUL_TOKENS is a floor below which an excerpt is noise. */
    const MIN_USEFUL_TOKENS = 60;
    const target = isProtected ? Math.min(item.tokens, Math.max(room, MIN_USEFUL_TOKENS)) : room;
    if (target >= MIN_USEFUL_TOKENS) {
      const compressor = getCompressor(policy[item.kind].compression);
      const text = itemText(item);
      const out = compressor.compress(text, target);
      const finalTokens = estimateTokens(out.text);
      if (out.compressed && finalTokens <= Math.max(target, room) && finalTokens > 0) {
        const compressed: ContextItem = { ...item, value: out.text, tokens: finalTokens };
        included.push(compressed);
        used += finalTokens;
        spentByGroup.set(item.kind, spent + finalTokens);
        decisions.push(decisionFor(
          item, compressor.id, finalTokens,
          `${item.relevance?.reason ?? 'included'} (${compressor.id === 'summarize' ? 'extractively summarised' : 'truncated'} from ${item.tokens} to ${finalTokens} tokens to fit)`,
        ));
        continue;
      }
    }

    decisions.push(decisionFor(
      item, 'dropped', 0,
      `dropped: needs ${item.tokens} tokens, ${room} left in the ${item.kind} allowance`,
    ));
  }

  /* Post-condition. `used` is arithmetic over the same estimator the
     renderer will use, so this can only fire on a bug - but a budget
     system that trusts its own arithmetic is a budget system that
     silently overruns the day the arithmetic is wrong. */
  if (used + input.floorTokens > total) {
    throw new ContextBudgetExceededError(
      input.spec.model, used + input.floorTokens, total,
      decisions.filter((d) => d.compression === 'dropped'), input.floorTokens,
    );
  }

  return { included, decisions, usedTokens: used, itemBudget, totalBudget: total, model: input.spec.model };
}

function decisionFor(
  item: ContextItem, compression: CompressionId | 'dropped', finalTokens: number, reason: string,
): BudgetDecision {
  return { id: item.id, kind: item.kind, originalTokens: item.tokens, finalTokens, compression, reason };
}
