/**
 * ContextItem - the one addressable unit of context.
 * ==================================================================
 * Before this existed there were two prompt builders, each concatenating
 * free strings. A string cannot answer any of the questions that decide
 * whether it belongs in a prompt, so neither builder could answer them
 * either. A `ContextItem` answers seven:
 *
 *   where did it come from      -> `source`
 *   when was it observed        -> `observedAt` / `validUntil` / `freshness`
 *   who or what created it      -> `producer`
 *   is it still valid           -> `freshness`
 *   who may see it              -> `sensitivity`
 *   why is it relevant          -> `relevance.reason`  (never null once scored)
 *   how much does it cost       -> `tokens`
 *
 * Two of those fields did not exist anywhere in AURA before:
 *
 *   `sensitivity` drives privacy routing - a `secret` item must never
 *   leave the machine, and a `private` one must not reach a third-party
 *   provider without an explicit decision.
 *
 *   `trust` drives prompt-injection defence. Retrieved content is DATA,
 *   never INSTRUCTION. File contents, web pages, tool output and another
 *   model's output are all `untrusted` and are fenced and labelled as
 *   such when rendered.
 *
 * -- The boundary rule -----------------------------------------------
 * `sensitivity` and `trust` are assigned ONCE, at the boundary where the
 * value enters AURA - that is what the `from*()` constructors below are
 * for. Everything downstream reads those fields; nothing downstream
 * re-derives them. A component that re-derives trust is a component that
 * can disagree with the boundary, and the disagreement is the exploit.
 */

import { createHash } from 'node:crypto';

/** What a context item is. Drives rendering and default trust. */
export type ContextItemKind =
  | 'file' | 'chunk' | 'memory' | 'turn' | 'tool-result'
  | 'env' | 'git' | 'mission' | 'web' | 'app' | 'event';

/**
 * Who may see this.
 *   public  - safe anywhere (documentation, open-source file paths)
 *   project - belongs to the user's repository; fine for a chosen provider
 *   private - the user's own machine/personal data; needs an explicit decision
 *   secret  - credential-shaped; must never be sent anywhere
 */
export type Sensitivity = 'public' | 'project' | 'private' | 'secret';

/**
 * Whether the content may be read as instruction.
 *   trusted   - AURA composed it, or the user typed it
 *   untrusted - it came from somewhere that could be adversarial
 */
export type Trust = 'trusted' | 'untrusted';

export type Freshness = 'fresh' | 'stale' | 'unknown';

export interface ContextItemSource {
  /** Which plane produced it: 'repository', 'memory', 'conversation', 'web'. */
  plane: string;
  /** Which driver inside that plane: 'coding-index', 'project-memory', 'cdp'. */
  driver: string;
  /** Where exactly: a path, a URL, a record id. Never a credential. */
  locator: string;
}

export interface ContextItemProducer {
  kind: 'user' | 'model' | 'tool' | 'system';
  id: string;
}

export interface ContextItemRelevance {
  score: number;
  /** Why this item is here. Human-readable. Never empty. */
  reason: string;
}

export interface ContextItem<T = unknown> {
  /** Stable and content-addressed: same content + locator gives the same id. */
  id: string;
  kind: ContextItemKind;
  value: T;
  source: ContextItemSource;
  observedAt: string;
  validUntil: string | null;
  producer: ContextItemProducer;
  freshness: Freshness;
  sensitivity: Sensitivity;
  relevance: ContextItemRelevance | null;
  confidence: number | null;
  trust: Trust;
  tokens: number;
}

/**
 * Interim token estimate - `length / 4`.
 *
 * THIS IS AN ESTIMATE, NOT A TOKENIZER. Phase 2 owns the real tokenizer.
 * The interface this module needs from it is exactly:
 *
 *     countTokens(text: string, model?: string): number
 *
 * When that lands, replace the body of `estimateTokens` with a call to
 * it and delete nothing else - every caller here already treats the
 * result as authoritative, and the budget enforcement is built to be
 * correct for any monotonic counter.
 *
 * Because it is an estimate, the budgeter applies a safety headroom
 * factor (see `budget.ts`) rather than spending the window to the last
 * token.
 */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

/** Render an item's value as the text that would enter a prompt. */
export function itemText(item: ContextItem): string {
  const v = item.value;
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return '';
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/**
 * Content-address an item. The id must be stable across runs so a budget
 * decision ("dropped chunk X") means the same thing in two different
 * assemblies, and so an item recorded in the journal can be found again.
 */
function contentId(kind: string, locator: string, text: string): string {
  const h = createHash('sha256').update(`${kind} ${locator} ${text}`).digest('hex');
  return `ci_${kind}_${h.slice(0, 16)}`;
}

export interface MakeContextItemInput<T = unknown> {
  kind: ContextItemKind;
  value: T;
  source: ContextItemSource;
  producer: ContextItemProducer;
  sensitivity: Sensitivity;
  trust: Trust;
  observedAt?: string;
  validUntil?: string | null;
  freshness?: Freshness;
  relevance?: ContextItemRelevance | null;
  confidence?: number | null;
}

/**
 * The ONE constructor. Everything that becomes context goes through it,
 * which is what makes "assigned at the boundary, once" enforceable: the
 * `from*` helpers below are the only callers a normal code path should
 * use, and each of them fixes `sensitivity` and `trust` for its class of
 * source.
 */
export function makeContextItem<T>(input: MakeContextItemInput<T>): ContextItem<T> {
  const observedAt = input.observedAt ?? new Date().toISOString();
  const text = typeof input.value === 'string' ? input.value : JSON.stringify(input.value ?? '');
  return {
    id: contentId(input.kind, input.source.locator, text),
    kind: input.kind,
    value: input.value,
    source: input.source,
    observedAt,
    validUntil: input.validUntil ?? null,
    producer: input.producer,
    freshness: input.freshness ?? 'unknown',
    sensitivity: input.sensitivity,
    relevance: input.relevance ?? null,
    confidence: input.confidence ?? null,
    trust: input.trust,
    tokens: estimateTokens(text),
  };
}

/* -- Boundary constructors ------------------------------------------
 *
 * Each one encodes a decision about a whole class of source. They are
 * deliberately not parameterised on `trust`: a caller that could choose
 * its own trust level is a caller that can get it wrong.
 */

/** Repository file or chunk. Project-sensitive, and NEVER instruction. */
export function fromRepositoryFile(input: {
  path: string; content: string; driver?: string;
  observedAt?: string; freshness?: Freshness;
  relevance?: ContextItemRelevance | null; kind?: 'file' | 'chunk';
}): ContextItem<string> {
  return makeContextItem({
    kind: input.kind ?? 'file',
    value: input.content,
    source: { plane: 'repository', driver: input.driver ?? 'filesystem', locator: input.path },
    producer: { kind: 'tool', id: input.driver ?? 'filesystem' },
    sensitivity: 'project',
    trust: 'untrusted',
    observedAt: input.observedAt,
    freshness: input.freshness ?? 'fresh',
    relevance: input.relevance ?? null,
  });
}

/** A recalled memory record. AURA wrote it, but it quotes untrusted material. */
export function fromMemory(input: {
  id: string; body: string; store: string;
  observedAt?: string; confidence?: number | null;
  relevance?: ContextItemRelevance | null;
}): ContextItem<string> {
  return makeContextItem({
    kind: 'memory',
    value: input.body,
    source: { plane: 'memory', driver: input.store, locator: input.id },
    producer: { kind: 'system', id: input.store },
    sensitivity: 'project',
    trust: 'untrusted',
    observedAt: input.observedAt,
    freshness: 'unknown',
    confidence: input.confidence ?? null,
    relevance: input.relevance ?? null,
  });
}

/**
 * A conversation turn.
 *
 * The user's own words are `trusted` - the user is the principal, and
 * treating their instruction as data would make the product useless. An
 * assistant turn is `untrusted`: it is another model's output, and a
 * model that can instruct its own next turn is a model that can be
 * talked into instructing itself.
 */
export function fromConversationTurn(input: {
  role: 'user' | 'assistant'; content: string; at: string; conversationId: string; index: number;
}): ContextItem<string> {
  return makeContextItem({
    kind: 'turn',
    value: input.content,
    source: { plane: 'conversation', driver: 'project-conversations', locator: `${input.conversationId}#${input.index}` },
    producer: input.role === 'user' ? { kind: 'user', id: 'user' } : { kind: 'model', id: 'assistant' },
    sensitivity: 'project',
    trust: input.role === 'user' ? 'trusted' : 'untrusted',
    observedAt: input.at,
    freshness: 'fresh',
  });
}

/** Output of a capability or tool. Always data. */
export function fromToolResult(input: {
  capabilityId: string; output: string; at?: string; nodeId?: string;
}): ContextItem<string> {
  return makeContextItem({
    kind: 'tool-result',
    value: input.output,
    source: { plane: 'capability', driver: input.nodeId ?? 'fabric', locator: input.capabilityId },
    producer: { kind: 'tool', id: input.capabilityId },
    sensitivity: 'project',
    trust: 'untrusted',
    observedAt: input.at,
    freshness: 'fresh',
  });
}

/**
 * A web page, a DOM node, a page title, a response body.
 *
 * The most adversarial source AURA has. `untrusted` is not a default
 * here, it is the entire reason the field exists.
 */
export function fromWeb(input: {
  url: string; content: string; driver?: string; at?: string;
}): ContextItem<string> {
  return makeContextItem({
    kind: 'web',
    value: input.content,
    source: { plane: 'web', driver: input.driver ?? 'http', locator: input.url },
    producer: { kind: 'tool', id: input.driver ?? 'http' },
    sensitivity: 'public',
    trust: 'untrusted',
    observedAt: input.at,
    freshness: 'fresh',
  });
}

/**
 * A fact AURA itself derived - environment scan, git signals, the
 * capability catalogue, mission state. AURA composed it from its own
 * registries, so it is `trusted`: it is not attacker-controlled text.
 */
export function fromAuraFact(input: {
  kind: 'env' | 'git' | 'mission' | 'event' | 'app';
  value: string; locator: string; driver: string;
  observedAt?: string; freshness?: Freshness;
  relevance?: ContextItemRelevance | null;
}): ContextItem<string> {
  return makeContextItem({
    kind: input.kind,
    value: input.value,
    source: { plane: 'aura', driver: input.driver, locator: input.locator },
    producer: { kind: 'system', id: 'aura' },
    sensitivity: 'project',
    trust: 'trusted',
    observedAt: input.observedAt,
    freshness: input.freshness ?? 'fresh',
    relevance: input.relevance ?? null,
  });
}

/* -- Reading the fields, never re-deriving them -------------------- */

/** Highest sensitivity present in a set. Used for privacy routing. */
export function maxSensitivity(items: readonly ContextItem[]): Sensitivity {
  const order: Sensitivity[] = ['public', 'project', 'private', 'secret'];
  let best = 0;
  for (const i of items) best = Math.max(best, order.indexOf(i.sensitivity));
  return order[best] ?? 'public';
}

/**
 * Items that must never leave the machine.
 *
 * Nothing in AURA currently *creates* a `secret` item - the design is
 * that credentials are redacted before they become context at all. This
 * exists so that the day a source legitimately carries one (a local
 * secrets-manager plane, say), the routing decision is already written
 * and does not have to be invented under pressure.
 */
export function localOnly(items: readonly ContextItem[]): ContextItem[] {
  return items.filter((i) => i.sensitivity === 'secret');
}
