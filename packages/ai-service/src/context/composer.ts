/**
 * The ONE composer.
 * ==================================================================
 * There used to be two, and they did not agree about anything that
 * mattered.
 *
 *   Path A (chat)   pipeline.ts -> intelligence/contextAssembler.ts
 *                   Selected context with a `switch` on an intent label.
 *                   No redaction. No budget. Fixed item caps chosen by
 *                   whoever wrote each branch.
 *
 *   Path B (agent)  context/systemPrompt.ts -> context/promptContract.ts
 *                   Rendered a ContextView through one `block()` helper
 *                   that applied `redact()` to everything passing
 *                   through it, with real provenance and derived
 *                   constraints - but only six fixed blocks, and no way
 *                   for a caller to contribute anything.
 *
 * Path B's contract renderer was the better design, so it is the one
 * that survived. This module is the pipeline in front of it:
 *
 *   CANDIDATES -> SCORE -> BUDGET -> COMPRESS -> ASSEMBLE
 *
 * Path A is now a CALLER. It supplies retrieved chunks, recalled
 * memories and conversation turns as `ContextItem`s and gets back a
 * composed prompt. It no longer builds one. That is what makes "every
 * item passes redact() exactly once" a structural property rather than
 * a rule someone has to remember: there is only one place that can turn
 * a context item into prompt text, and that place redacts.
 *
 * -- What this module refuses to do ----------------------------------
 * It does not silently truncate. If the assembly will not fit the
 * chosen model's window after dropping, truncating and summarising, it
 * throws `ContextBudgetExceededError` naming what was dropped. The
 * caller decides what to do about it; the composer does not decide on
 * the caller's behalf by quietly sending less than it claimed.
 */

import type { ContextView } from './types';
import type { ContextItem } from './item';
import { estimateTokens } from './item';
import { renderContextContract, renderContextItems, type RenderOptions } from './promptContract';
import { rank, type StructuralModel, type ScoreWeights } from './score';
import {
  enforceBudget, availableTokens,
  type BudgetSpec, type BudgetDecision, type GroupBudgetConfig,
} from './budget';

export interface ComposeInput {
  /**
   * AURA's operating rules. Incompressible: it is the part of the prompt
   * that says what the model may not do, so trimming it to make room is
   * trimming the safety properties to make room for the thing they
   * protect against.
   */
  systemPrompt?: string | null;

  /** The canonical project read model, rendered as the facts blocks. */
  view?: ContextView | null;
  /** Trim view sections a surface does not need. */
  include?: RenderOptions['include'];

  /** Everything a caller wants considered. Ranked and budgeted here. */
  items?: readonly ContextItem[];

  /** The user's task or question, verbatim. Incompressible. */
  task?: string | null;

  /**
   * What the task is about, for scoring. Defaults to `task`.
   * Separated because a task can be long and a query should be specific.
   */
  query?: string;
  /** Intent label from `intelligence/`; drives kind-fit only. */
  intent?: string;
  structural?: StructuralModel;
  weights?: Partial<ScoreWeights>;

  /** The model this is being assembled for. Required for enforcement. */
  budget: BudgetSpec;
  /** Per-kind budget overrides. */
  policy?: Partial<Record<ContextItem['kind'], GroupBudgetConfig>>;
  /** Item ids that must survive the budget if anything does. */
  floorItemIds?: readonly string[];

  now?: number;
}

export interface ComposeResult {
  /** The assembled prompt. */
  text: string;
  /** Items as included, in order, already compressed. */
  included: ContextItem[];
  /** One entry per candidate: what happened to it and why. */
  decisions: BudgetDecision[];
  tokens: {
    /** System rules + rendered view + task. Cannot be reduced. */
    floor: number;
    items: number;
    total: number;
    /** What the model's window allowed this assembly. */
    budget: number;
  };
  model: string;
  /** Highest sensitivity that reached the prompt. Drives privacy routing. */
  sensitivity: ContextItem['sensitivity'];
  /** True when any untrusted item was fenced into the prompt. */
  containsUntrusted: boolean;
}

const SEP = '\n\n';

/**
 * Compose. Throws `ContextBudgetExceededError` rather than overrunning.
 *
 * The order of assembly is load-bearing:
 *   1. rules      - how to behave, including how to treat what follows
 *   2. facts      - what is true about the project, with its freshness
 *   3. items      - the evidence selected for this request, fenced
 *   4. task       - what to do, isolated in its own block
 *
 * Rules before evidence, because a rule that arrives after the content
 * it governs has already been read too late.
 */
export function composeContext(input: ComposeInput): ComposeResult {
  const rules = input.systemPrompt?.trim() ? input.systemPrompt.trim() : '';
  const contract = input.view ? renderContextContract(input.view, input.include ? { include: input.include } : undefined) : '';
  const taskBlock = input.task?.trim() ? `<TASK>\n${input.task.trim()}\n</TASK>` : '';

  /* The floor is measured on the text that will actually be emitted,
     separators included, so the budget is spent against the real string
     rather than an idealised sum of its parts. */
  const floorText = [rules, contract, taskBlock].filter(Boolean).join(SEP);
  const floorTokens = estimateTokens(floorText);

  const candidates = input.items ?? [];

  /* SCORE. Every candidate leaves with a non-null relevance reason. */
  const ranked = candidates.length
    ? rank(candidates, {
      query: input.query ?? input.task ?? '',
      intent: input.intent ?? 'generic',
      structural: input.structural,
      weights: input.weights,
      now: input.now,
    })
    : [];

  /* BUDGET + COMPRESS. Throws if the floor alone does not fit. */
  const budgeted = enforceBudget({
    items: ranked,
    spec: input.budget,
    floorTokens,
    policy: input.policy,
    floorItemIds: input.floorItemIds,
  });

  /* ASSEMBLE. Items render between the facts and the task: after the
     facts because they are evidence for them, before the task because
     the task is the last thing the model should read. */
  const itemsBlock = renderContextItems(budgeted.included);
  const text = [rules, contract, itemsBlock, taskBlock].filter(Boolean).join(SEP);

  const total = estimateTokens(text);
  const allowed = availableTokens(input.budget);

  /* Final post-condition on the REAL string. Rendering adds provenance
     lines and fences, which cost tokens the item accounting does not
     see. Without this check the composer could satisfy its own
     arithmetic and still overrun the window - which is precisely the
     failure this whole module exists to prevent. */
  if (total > allowed) {
    const overhead = total - (floorTokens + budgeted.usedTokens);
    const trimmed = trimToFit(budgeted.included, budgeted.decisions, {
      rules, contract, taskBlock, allowed, overheadHint: overhead,
    });
    return finish(trimmed.text, trimmed.included, trimmed.decisions, floorTokens, allowed, input.budget.model);
  }

  return finish(text, budgeted.included, budgeted.decisions, floorTokens, allowed, input.budget.model);
}

function finish(
  text: string,
  included: ContextItem[],
  decisions: BudgetDecision[],
  floorTokens: number,
  allowed: number,
  model: string,
): ComposeResult {
  const total = estimateTokens(text);
  const itemTokens = included.reduce((s, i) => s + i.tokens, 0);
  const order: ContextItem['sensitivity'][] = ['public', 'project', 'private', 'secret'];
  let sens = 0;
  for (const i of included) sens = Math.max(sens, order.indexOf(i.sensitivity));
  return {
    text,
    included,
    decisions,
    tokens: { floor: floorTokens, items: itemTokens, total, budget: allowed },
    model,
    sensitivity: included.length ? (order[sens] ?? 'public') : 'public',
    containsUntrusted: included.some((i) => i.trust === 'untrusted'),
  };
}

/**
 * Rendering overhead pushed the assembly over. Drop the lowest-ranked
 * items, one at a time, re-rendering after each, until the REAL string
 * fits. Measuring after each drop rather than estimating how many to
 * drop is slower and correct; estimating is faster and is how a budget
 * system ends up off by one fence.
 *
 * If the floor alone still does not fit, `composeContext`'s caller would
 * already have seen `ContextBudgetExceededError` from `enforceBudget`,
 * because the floor is checked there first.
 */
function trimToFit(
  included: ContextItem[],
  decisions: BudgetDecision[],
  ctx: { rules: string; contract: string; taskBlock: string; allowed: number; overheadHint: number },
): { text: string; included: ContextItem[]; decisions: BudgetDecision[] } {
  const keep = [...included];
  const out = [...decisions];
  let text = render(keep);

  while (estimateTokens(text) > ctx.allowed && keep.length > 0) {
    const victim = keep.pop()!;
    const idx = out.findIndex((d) => d.id === victim.id && d.compression !== 'dropped');
    const note = `dropped: rendering overhead (provenance lines and fences, about ${ctx.overheadHint} tokens) put the assembly over the ${ctx.allowed}-token budget`;
    if (idx >= 0) out[idx] = { ...out[idx], finalTokens: 0, compression: 'dropped', reason: note };
    else out.push({ id: victim.id, kind: victim.kind, originalTokens: victim.tokens, finalTokens: 0, compression: 'dropped', reason: note });
    text = render(keep);
  }
  return { text, included: keep, decisions: out };

  function render(items: ContextItem[]): string {
    return [ctx.rules, ctx.contract, renderContextItems(items), ctx.taskBlock].filter(Boolean).join(SEP);
  }
}

export { ContextBudgetExceededError } from './budget';
export type { BudgetSpec, BudgetDecision } from './budget';
