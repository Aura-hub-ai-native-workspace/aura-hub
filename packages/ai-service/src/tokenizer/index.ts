/**
 * tokenizer — how many tokens is this, really?
 * ==================================================================
 * Three copies of `Math.ceil(text.length / 4)` decided AURA's context
 * budget: `intelligence/contextAssembler.ts`, `context/systemPrompt.ts`
 * and `packages/retrieval/src/types.ts`. Four characters per token is
 * roughly right for English prose and badly wrong for the things AURA
 * actually sends — minified code, deep indentation, JSON, CJK text, long
 * identifiers — which is how a "fits comfortably" estimate becomes a
 * context-length error at the provider.
 *
 * This module answers the question with, in order of preference:
 *
 *   1. **The provider's own counter.** Anthropic exposes
 *      `POST /v1/messages/count_tokens`; Gemini exposes
 *      `:countTokens`; Ollama reports `prompt_eval_count` for the model
 *      that will actually run. These are exact by construction — they
 *      are the same tokenizer the request will be billed and truncated
 *      by. Method: `provider`.
 *
 *   2. **A real BPE tokenizer** over a vocabulary present on this
 *      machine (`tokenizer/bpe.ts`). Exact for the model whose
 *      vocabulary it is. Method: `bpe`.
 *
 *   3. **A structural estimate.** Not `/4`: it pre-tokenizes with the
 *      GPT-family regex and prices each piece by its byte length, which
 *      tracks real tokenizers far more closely on code and on non-Latin
 *      text. Still an estimate, and it says so. Method: `estimate`.
 *
 *   4. **`length / 4`**, reachable only when even pre-tokenization
 *      fails. Labelled `chars-over-4` so a number derived this way is
 *      never mistaken for a measurement.
 *
 * Every result carries which of those produced it. A caller that must
 * not guess (the router's context gate refusing a request that would
 * overflow) can therefore refuse to guess.
 */

import { countWithRanks, loadRankTable, preTokenize } from './bpe';

export type CountMethod = 'provider' | 'bpe' | 'estimate' | 'chars-over-4';

export interface TokenCount {
  tokens: number;
  method: CountMethod;
  /** True only for `provider` and `bpe`. */
  exact: boolean;
  /** Where the number came from, in one phrase, for logs and the UI. */
  detail: string;
}

/* ── 4. the labelled last resort ───────────────────────────────── */

/**
 * The historical estimate, kept ONLY as the floor of the ladder and
 * clearly named. Nothing should call this directly; `countTokens()`
 * reaches it when everything else is unavailable.
 */
export function charsOverFour(text: string): number {
  return Math.ceil(text.length / 4);
}

/* ── 3. a structural estimate that is not chars/4 ──────────────── */

/**
 * Estimate by pre-token, not by character.
 *
 * Real BPE vocabularies hold whole common words, so a short word is one
 * token regardless of length, while an unusual or non-Latin run splits
 * roughly every 2-3 UTF-8 bytes. Counting that way tracks a real
 * tokenizer far better than a flat divisor, and it degrades in the right
 * direction: it over-counts dense text rather than under-counting it,
 * and a budget that errs high fits, whereas one that errs low fails at
 * the provider.
 */
export function estimateTokensStructural(text: string): number {
  if (!text) return 0;
  let total = 0;
  for (const piece of preTokenize(text)) {
    const bytes = Buffer.byteLength(piece, 'utf8');
    if (bytes === 0) continue;
    // Whitespace runs collapse hard in every GPT-family vocabulary.
    if (!/\S/.test(piece)) { total += Math.max(1, Math.ceil(bytes / 8)); continue; }
    // A short ASCII word is overwhelmingly one vocabulary entry.
    if (bytes <= 7 && piece.length === bytes) { total += 1; continue; }
    // Anything longer, or any multi-byte text, splits into subwords.
    total += Math.max(1, Math.ceil(bytes / 3));
  }
  return total;
}

/* ── 2. real BPE when a vocabulary is present ──────────────────── */

/**
 * The vocabulary a provider's models use, by the name of the
 * `.tiktoken` file a user would drop into `<AURA_HOME>/tokenizer/`.
 *
 * Only providers whose tokenizer is actually published are listed. A
 * provider absent from this map has no BPE step and falls to the
 * estimate — which is the honest outcome, not a gap.
 */
const VOCAB_BY_PROVIDER: Record<string, string> = {
  openai: 'cl100k_base',
  groq: 'cl100k_base',
  mistral: 'cl100k_base',
  cerebras: 'cl100k_base',
  novita: 'cl100k_base',
  nvidia: 'cl100k_base',
  openrouter: 'cl100k_base',
};

/** `o200k_base` is the vocabulary for GPT-4o and the o-series. */
function vocabFor(providerId: string, modelId: string): string | null {
  if (providerId === 'openai' && /^(gpt-4o|gpt-4\.1|o1|o3|o4)/i.test(modelId)) return 'o200k_base';
  return VOCAB_BY_PROVIDER[providerId] ?? null;
}

export function countWithLocalVocab(text: string, providerId: string, modelId: string): TokenCount | null {
  const name = vocabFor(providerId, modelId);
  if (!name) return null;
  const table = loadRankTable(name);
  if (!table) return null;
  return {
    tokens: countWithRanks(text, table),
    method: 'bpe',
    exact: true,
    detail: `byte-pair encoded with the ${name} vocabulary`,
  };
}

/* ── 1. the provider's own counter ─────────────────────────────── */

/**
 * A provider that can count its own tokens.
 *
 * Implemented per provider rather than on `ProviderAdapter` because most
 * providers offer nothing of the kind, and widening the adapter
 * interface with a method eleven of thirteen adapters must stub is how
 * an interface starts lying.
 */
export type ProviderCounter = (text: string, model: string, credential: string) => Promise<number | null>;

/** Anthropic — `POST /v1/messages/count_tokens`. Exact, and free. */
export const anthropicCounter: ProviderCounter = async (text, model, apiKey) => {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: text }] }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const json = await res.json() as { input_tokens?: number };
    return typeof json.input_tokens === 'number' ? json.input_tokens : null;
  } catch { return null; }
};

/** Gemini — `models/<model>:countTokens`. Exact, and free. */
export const geminiCounter: ProviderCounter = async (text, model, apiKey) => {
  try {
    const name = model.startsWith('models/') ? model : `models/${model}`;
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/${name}:countTokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text }] }] }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const json = await res.json() as { totalTokens?: number };
    return typeof json.totalTokens === 'number' ? json.totalTokens : null;
  } catch { return null; }
};

export const PROVIDER_COUNTERS: Record<string, ProviderCounter> = {
  anthropic: anthropicCounter,
  gemini: geminiCounter,
};

/* ── the ladder ────────────────────────────────────────────────── */

export interface CountOptions {
  providerId?: string;
  modelId?: string;
  /**
   * The provider credential, when the caller is willing to spend a
   * network round-trip on an exact count. Absent means "do not call out"
   * — which is the right default for sizing a prompt on the hot path.
   */
  credential?: string;
  /**
   * A counter supplied by the caller, used ahead of the built-in map.
   * This is how a LOCAL model's own count reaches the ladder: an Ollama
   * runtime can report `prompt_eval_count` for the exact model that will
   * run, and nothing about that is knowable from a provider id.
   */
  counter?: ProviderCounter;
}

/** Synchronous count. Never makes a network call, so never `provider`. */
export function countTokensSync(text: string, options: CountOptions = {}): TokenCount {
  if (!text) return { tokens: 0, method: 'bpe', exact: true, detail: 'empty text' };
  const { providerId, modelId } = options;
  if (providerId && modelId) {
    const bpe = countWithLocalVocab(text, providerId, modelId);
    if (bpe) return bpe;
  }
  try {
    return {
      tokens: estimateTokensStructural(text),
      method: 'estimate',
      exact: false,
      detail: 'structural estimate — pre-tokenized, no vocabulary available',
    };
  } catch {
    return {
      tokens: charsOverFour(text),
      method: 'chars-over-4',
      exact: false,
      detail: 'LAST RESORT: characters ÷ 4. Not a tokenizer.',
    };
  }
}

/**
 * Count, spending a network round-trip when one is offered and would be
 * exact. Falls all the way down the ladder on any failure.
 */
export async function countTokens(text: string, options: CountOptions = {}): Promise<TokenCount> {
  if (!text) return { tokens: 0, method: 'bpe', exact: true, detail: 'empty text' };
  const { providerId, modelId, credential, counter } = options;
  const chosen = counter ?? (providerId ? PROVIDER_COUNTERS[providerId] : undefined);
  if (chosen && modelId && (credential !== undefined || counter)) {
    const exact = await chosen(text, modelId, credential ?? '');
    if (typeof exact === 'number' && exact >= 0) {
      return {
        tokens: exact,
        method: 'provider',
        exact: true,
        detail: `counted by ${providerId ?? 'the model server'} itself`,
      };
    }
  }
  return countTokensSync(text, options);
}

export { preTokenize } from './bpe';
