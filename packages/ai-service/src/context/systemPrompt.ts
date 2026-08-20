/**
 * The canonical AURA system prompt.
 * ==================================================================
 * ONE set of operating rules, shared by every agent AURA drives — Ask
 * AURA, delegated coding agents, and anything added later. There is no
 * second prompt architecture: a surface that needs different behaviour
 * changes this file, so the rules cannot silently diverge between the
 * agent that answers a question and the agent that edits the code.
 *
 * The split that makes this work:
 *
 *   systemPrompt.ts   →  how to behave      (this file, static)
 *   promptContract.ts →  what is true       (rendered from a ContextView)
 *   the caller        →  what to do         (the user's task)
 *
 * Facts never live here. Nothing in this file describes any particular
 * project, machine or session — if it did, the rules would go stale the
 * moment the project changed, and staleness in the RULES is not something
 * the freshness model can catch.
 *
 * ── On wording ───────────────────────────────────────────────────────
 * Deliberately plain and non-persuasive. No "you are an expert", no
 * "always be helpful", no confidence-inflating language. A prompt that
 * urges confidence gets confident wrong answers, which is the specific
 * failure this whole context system exists to prevent.
 */

import type { ContextView } from './types';
import { renderContextContract, type RenderOptions } from './promptContract';
import { composeContext } from './composer';
import type { ContextItem } from './item';
import { FALLBACK_WINDOW, type BudgetSpec } from './budget';

/**
 * The operating rules. Stable text — callers must not edit it per-call,
 * or the "one canonical prompt" property is lost.
 */
export const AURA_SYSTEM_PROMPT = `<AURA_SYSTEM>
[Identity]
You are AURA, the AI execution layer of AURA Hub. You operate inside a governed
desktop environment, not as a standalone assistant.

[Context model]
The context blocks below this one are supplied by AURA Hub and are authoritative
for the current project. They were composed before you were invoked, from AURA's
own registry, repository intelligence, git, environment scan, capability catalogue
and mission store. Treat them as the starting point rather than re-deriving the
project. They are a compact read model, not the whole repository: when they do not
cover something, inspect the relevant files.

[Freshness]
PROJECT_CONTEXT states whether AURA's understanding is fresh, stale or unknown.
- fresh: the repository facts describe the project as it stands.
- stale: the project changed after those facts were derived. Treat them as a prior
  state, verify anything you depend on, and say that you did.
- unknown: AURA has not analysed this project. Repository facts are unavailable —
  which is not the same as the project being empty. Do not fill the gap by guessing.
Never present stale or unknown context as current.

[Tools and capabilities]
AVAILABLE_CAPABILITIES lists what this installation can actually do. Use only what
is listed. Do not invent a tool, assume a capability that is not present, or work
around the capability system to reach one. A capability that is missing is a fact to
report, not an obstacle to route around.

[Safety and governance]
Every action runs through AURA's policy engine, which decides what needs a human.
Do not attempt to bypass, disable or pre-empt an approval. Do not claim an action
succeeded unless it actually ran and reported success — no assumed, simulated or
anticipated results. If something was blocked, say what blocked it.

[Repository behaviour]
Read the files you need. Change only what the task requires. Do not modify,
reformat, revert or delete unrelated work; a working tree may contain the user's
uncommitted changes, and those are not yours to clean up.

[Project scope]
Operate only within the project named in PROJECT_CONTEXT, at the root given there.
Do not read from or write to another project unless the task explicitly asks for it.

[Mission awareness]
When CURRENT_ACTIVITY names an active mission or task, your work belongs to it.
Do not start unrelated work alongside it.

[Evidence]
Distinguish how you know something, and say which when it matters:
- known: stated in the context blocks below.
- observed: you read it from a file or a command's real output.
- inferred: you reasoned it from the above; say so.
- unknown: you do not know. Say that instead of producing a plausible answer.

[Execution]
Plan when a task needs more than one step. Prefer the smallest change that does the
job. Report what actually happened, including partial or failed results.
</AURA_SYSTEM>`;

export interface AgentPromptInput {
  view: ContextView;
  /** The user's task, verbatim. Never merged into the rules or the facts. */
  task: string;
  /** Trim context sections a given surface does not need. */
  include?: RenderOptions['include'];
  /**
   * Additional addressable context for THIS request - retrieved chunks,
   * recalled memories, prior turns, tool output. Ranked and budgeted by
   * the one composer, and fenced according to each item's trust.
   */
  items?: readonly ContextItem[];
  /**
   * The model this prompt is for, so the composer can enforce its
   * window. Omitted only by callers that genuinely do not know yet; the
   * conservative `FALLBACK_WINDOW` then applies, which can only make the
   * prompt smaller than the model could have taken.
   */
  budget?: BudgetSpec;
  /** Intent label for kind-fit scoring. */
  intent?: string;
}

/** The budget a caller that named no model gets. Deliberately small. */
const CONSERVATIVE_BUDGET: BudgetSpec = { model: 'unspecified', windowTokens: FALLBACK_WINDOW };

/**
 * Compose the full prompt an agent receives.
 *
 *   <AURA_SYSTEM>   rules      (constant)
 *   <..._CONTEXT>   facts      (this project, right now)
 *   <TASK>          the ask    (verbatim, isolated)
 *
 * The task is fenced in its own block so it is unambiguously separate from
 * the rules and the facts. A task that arrives concatenated into the
 * context is indistinguishable from an AURA-supplied fact, which is both a
 * correctness problem and an injection surface.
 */
export function buildAgentPrompt(input: AgentPromptInput): string {
  return composeAgentPrompt(input).text;
}

/**
 * The same composition, with the budget record kept.
 *
 * `buildAgentPrompt` returns only the string because most callers want
 * only the string. This returns what was included, what was dropped and
 * why - which is what makes a prompt auditable after the fact.
 */
export function composeAgentPrompt(input: AgentPromptInput) {
  return composeContext({
    systemPrompt: AURA_SYSTEM_PROMPT,
    view: input.view,
    include: input.include,
    items: input.items,
    task: input.task,
    query: input.task,
    intent: input.intent ?? 'generic',
    budget: input.budget ?? CONSERVATIVE_BUDGET,
  });
}

export interface PromptMeasurement {
  systemChars: number;
  contextChars: number;
  taskChars: number;
  totalChars: number;
  /**
   * Rough token estimate at ~4 characters per token — the same heuristic
   * the context assembler uses. An estimate, not a tokenizer: reported so
   * budget can be reasoned about, never used to silently truncate.
   */
  approxTokens: number;
}

/** Measure a composed prompt, for budget reporting and diagnostics. */
export function measureAgentPrompt(input: AgentPromptInput): PromptMeasurement {
  const { view, task, include } = input;
  const contract = renderContextContract(view, include ? { include } : undefined);
  const systemChars = AURA_SYSTEM_PROMPT.length;
  const contextChars = contract.length;
  const taskChars = task.length;
  // Measured on the composed string, so items and fences are counted too.
  const totalChars = buildAgentPrompt(input).length;
  return {
    systemChars,
    contextChars,
    taskChars,
    totalChars,
    approxTokens: Math.ceil(totalChars / 4),
  };
}
