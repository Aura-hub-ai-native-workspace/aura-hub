/**
 * Scoring - four independent signals, each of which must justify itself.
 * ==================================================================
 * The composer this feeds used to select context with a `switch` on an
 * intent label. A switch cannot say WHY it included something, which
 * means nobody could ever audit a prompt, and it cannot rank, which
 * means nobody could ever cut one down to a budget.
 *
 * Four signals, deliberately independent so that a weak one cannot mask
 * a strong one and each contributes its own sentence of justification:
 *
 *   lexical    - does the text actually contain the query's terms?
 *                BM25, the same Okapi shape and constants already used by
 *                `knowledge-coding/src/store/invertedIndex.ts`, computed
 *                here over the candidate set rather than a global index
 *                because the candidates are what we are ranking.
 *
 *   structural - how close is it to what the task is about? Graph
 *                distance over the relation edges the caller supplies
 *                (imports, containment, same-directory), decayed per hop.
 *
 *   temporal   - how recent is it? The exact recency shape already used
 *                at `knowledge-coding/src/search.ts:61-63`:
 *                    1 + 0.15 * 0.5^(ageDays / 60)
 *                A 60-day half-life, contributing at most 15%. Recency is
 *                a tiebreak, never a ranking in its own right - the newest
 *                file is not the most relevant file.
 *
 *   task-match - does the item's KIND suit what is being asked? A bug
 *                report wants code and diagnoses; an architecture
 *                question wants module summaries and the graph.
 *
 * Every signal returns a `reason`. The composer refuses to include an
 * item whose relevance is null, so "every inclusion carries a reason" is
 * a structural property, not a convention.
 */

import type { ContextItem, ContextItemRelevance } from './item';
import { itemText } from './item';

/* -- Tokenisation ---------------------------------------------------- */

const STOP = new Set([
  'the', 'a', 'an', 'is', 'are', 'to', 'of', 'in', 'on', 'and', 'or', 'for',
  'how', 'what', 'where', 'does', 'do', 'this', 'that', 'with', 'it', 'be',
  'i', 'you', 'we', 'my', 'me', 'can', 'should', 'would', 'if', 'as', 'at',
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
}

/* -- Signal 1: lexical (BM25) ---------------------------------------- */

/** Okapi BM25 constants, identical to the inverted index's. */
const K1 = 1.2;
const B = 0.75;

interface LexicalModel {
  df: Map<string, number>;
  n: number;
  avgdl: number;
  docs: Map<string, { tf: Map<string, number>; dl: number }>;
}

/** Build the corpus statistics over exactly the candidates being ranked. */
function buildLexicalModel(items: readonly ContextItem[]): LexicalModel {
  const df = new Map<string, number>();
  const docs = new Map<string, { tf: Map<string, number>; dl: number }>();
  let totalLen = 0;
  for (const item of items) {
    const toks = tokenize(itemText(item));
    const tf = new Map<string, number>();
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    docs.set(item.id, { tf, dl: toks.length });
    totalLen += toks.length;
  }
  const n = items.length;
  return { df, n, avgdl: n ? totalLen / n : 1, docs };
}

/**
 * BM25 for one item against the query, normalised to 0..1 by the best
 * achievable score in this candidate set. Normalising per-set is correct
 * here: we are choosing among these items, not comparing across runs.
 */
function lexicalRaw(model: LexicalModel, item: ContextItem, queryTokens: string[]): { score: number; matched: string[] } {
  const doc = model.docs.get(item.id);
  if (!doc || doc.dl === 0) return { score: 0, matched: [] };
  const matched: string[] = [];
  let score = 0;
  for (const q of new Set(queryTokens)) {
    const tf = doc.tf.get(q);
    if (!tf) continue;
    const dfq = model.df.get(q) ?? 1;
    const idf = Math.log(1 + (model.n - dfq + 0.5) / (dfq + 0.5));
    const norm = (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (doc.dl / (model.avgdl || 1))));
    score += idf * norm;
    matched.push(q);
  }
  return { score, matched };
}

/* -- Signal 2: structural (graph distance) --------------------------- */

/**
 * The caller supplies what it knows about structure: which locators the
 * task is anchored on, and an adjacency map between locators. This module
 * does not build a graph - `@aura/knowledge-coding` owns that - it only
 * measures distance in one it is handed.
 */
export interface StructuralModel {
  /** Locators the task is directly about (a file the user named, the open file). */
  anchors: string[];
  /** locator -> locators one hop away. */
  edges?: Map<string, string[]>;
  /** Maximum hops worth counting. */
  maxHops?: number;
}

/** Hops from any anchor to `locator`, or null when unreachable. */
function hopsFrom(model: StructuralModel, locator: string): number | null {
  if (model.anchors.includes(locator)) return 0;
  const edges = model.edges;
  const maxHops = model.maxHops ?? 3;
  if (!edges || edges.size === 0) return null;
  const seen = new Set<string>(model.anchors);
  let frontier = [...model.anchors];
  for (let hop = 1; hop <= maxHops; hop++) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const n of edges.get(node) ?? []) {
        if (seen.has(n)) continue;
        seen.add(n);
        if (n === locator) return hop;
        next.push(n);
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }
  return null;
}

/**
 * Directory proximity is a real structural signal even with no graph: two
 * files in the same directory are related in a way two files in different
 * trees are not. Used only when the edge map cannot answer.
 */
function directoryProximity(anchors: string[], locator: string): number {
  const segs = (p: string) => p.replace(/\\/g, '/').split('/').filter(Boolean);
  const l = segs(locator);
  let best = 0;
  for (const a of anchors) {
    const s = segs(a);
    let common = 0;
    while (common < s.length - 1 && common < l.length - 1 && s[common] === l[common]) common++;
    const depth = Math.max(1, Math.min(s.length, l.length) - 1);
    best = Math.max(best, common / depth);
  }
  return best;
}

/* -- Signal 3: temporal ---------------------------------------------- */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The recency shape already used by coding search: a multiplier between
 * 1.0 and 1.15 with a 60-day half-life. Returned here as the 0..0.15
 * bonus portion so it can be combined additively with the other signals
 * and still be recognisable as the same curve.
 */
export function recencyBonus(observedAt: string, now = Date.now()): number {
  const t = Date.parse(observedAt);
  if (!Number.isFinite(t)) return 0;
  const ageDays = Math.max(0, (now - t) / DAY_MS);
  return 0.15 * Math.pow(0.5, ageDays / 60);
}

/* -- Signal 4: task match -------------------------------------------- */

/**
 * How well an item's KIND suits the task. The intent labels are the ones
 * `intelligence/types.ts` already produces, so this replaces the `switch`
 * without inventing a second intent vocabulary.
 *
 * A kind absent from a row scores `DEFAULT_KIND_FIT` rather than zero: an
 * unexpected kind is a weak signal, not a disqualification.
 */
const DEFAULT_KIND_FIT = 0.4;

const KIND_FIT: Record<string, Partial<Record<ContextItem['kind'], number>>> = {
  project_overview: { mission: 0.9, env: 0.8, git: 0.8, memory: 0.7, file: 0.5, chunk: 0.4, turn: 0.6 },
  architecture: { file: 0.8, chunk: 0.8, memory: 0.7, git: 0.5, env: 0.4, turn: 0.5 },
  module_explanation: { chunk: 1.0, file: 0.9, memory: 0.6, turn: 0.5 },
  function_explanation: { chunk: 1.0, file: 0.9, memory: 0.4, turn: 0.5 },
  bug_fix: { chunk: 1.0, file: 0.9, 'tool-result': 0.9, git: 0.8, memory: 0.8, turn: 0.6 },
  debugging: { chunk: 1.0, file: 0.9, 'tool-result': 0.9, git: 0.8, memory: 0.8, turn: 0.6 },
  code_search: { chunk: 1.0, file: 0.9, memory: 0.3, turn: 0.3 },
  api_reference: { chunk: 1.0, file: 0.9, memory: 0.4, turn: 0.3 },
  testing: { chunk: 0.9, file: 0.9, 'tool-result': 0.8, memory: 0.5, turn: 0.4 },
};

export function taskFit(kind: ContextItem['kind'], intent: string): number {
  const row = KIND_FIT[intent];
  if (!row) return DEFAULT_KIND_FIT;
  return row[kind] ?? DEFAULT_KIND_FIT;
}

/* -- Combination ------------------------------------------------------ */

export interface ScoreWeights {
  lexical: number;
  structural: number;
  temporal: number;
  task: number;
}

/**
 * Lexical dominates because it is the only signal that can be WRONG in a
 * way the user notices immediately (an excerpt that does not mention what
 * they asked about). Temporal is deliberately the smallest: it is the
 * shape borrowed from coding search, where it is a tiebreak.
 */
export const DEFAULT_WEIGHTS: ScoreWeights = {
  lexical: 0.5,
  structural: 0.2,
  temporal: 0.1,
  task: 0.2,
};

export interface ScoreInput {
  query: string;
  intent: string;
  structural?: StructuralModel;
  weights?: Partial<ScoreWeights>;
  now?: number;
}

export interface ScoredItem {
  item: ContextItem;
  relevance: ContextItemRelevance;
  signals: { lexical: number; structural: number; temporal: number; task: number };
}

/**
 * Score every candidate. Returns items sorted best-first, each with a
 * non-null `relevance` carrying a sentence that names the signals that
 * actually contributed.
 *
 * A pinned or explicitly-anchored item is NOT special-cased here. If it
 * must survive the budget, it is passed to the budgeter as a floor item -
 * ranking and protection are different decisions and mixing them is how
 * "why is this in my prompt?" becomes unanswerable.
 */
export function scoreItems(items: readonly ContextItem[], input: ScoreInput): ScoredItem[] {
  const w = { ...DEFAULT_WEIGHTS, ...(input.weights ?? {}) };
  const now = input.now ?? Date.now();
  const queryTokens = tokenize(input.query);
  const model = buildLexicalModel(items);

  const raw = items.map((item) => {
    const lex = lexicalRaw(model, item, queryTokens);
    return { item, lex };
  });
  const bestLex = raw.reduce((m, r) => Math.max(m, r.lex.score), 0);

  const scored: ScoredItem[] = raw.map(({ item, lex }) => {
    const lexical = bestLex > 0 ? lex.score / bestLex : 0;

    let structural = 0;
    let structuralReason = '';
    if (input.structural && input.structural.anchors.length) {
      const hops = hopsFrom(input.structural, item.source.locator);
      if (hops !== null) {
        structural = Math.pow(0.5, hops);
        structuralReason = hops === 0
          ? 'is the file the task names'
          : `is ${hops} hop${hops === 1 ? '' : 's'} from the file the task names`;
      } else {
        const prox = directoryProximity(input.structural.anchors, item.source.locator);
        if (prox > 0) {
          structural = prox * 0.5;
          structuralReason = 'shares a directory with the file the task names';
        }
      }
    }

    const temporalBonus = recencyBonus(item.observedAt, now);
    // Normalise the 0..0.15 bonus into a 0..1 signal so the weights mean
    // what they say; the CURVE is the borrowed one, the scale is local.
    const temporal = temporalBonus / 0.15;

    const task = taskFit(item.kind, input.intent);

    const score =
      w.lexical * lexical +
      w.structural * structural +
      w.temporal * temporal +
      w.task * task;

    /* The reason is assembled from the signals that actually fired.
       An item that scored only on kind-fit says so, plainly, rather than
       borrowing the language of a lexical match it did not get. */
    const parts: string[] = [];
    if (lexical > 0 && lex.matched.length) {
      parts.push(`matches ${lex.matched.slice(0, 5).map((t) => `"${t}"`).join(', ')}`);
    }
    if (structuralReason) parts.push(structuralReason);
    if (temporal > 0.5) {
      const ageDays = Math.max(0, (now - Date.parse(item.observedAt)) / DAY_MS);
      parts.push(`observed ${ageDays < 1 ? 'today' : `${Math.round(ageDays)}d ago`}`);
    }
    parts.push(`${item.kind} suits a ${input.intent.replace(/_/g, ' ')} question`);

    return {
      item,
      relevance: { score: Number(score.toFixed(6)), reason: parts.join('; ') },
      signals: { lexical, structural, temporal, task },
    };
  });

  return scored.sort((a, b) => b.relevance.score - a.relevance.score);
}

/** Attach the computed relevance back onto the items, best-first. */
export function rank(items: readonly ContextItem[], input: ScoreInput): ContextItem[] {
  return scoreItems(items, input).map((s) => ({ ...s.item, relevance: s.relevance }));
}
