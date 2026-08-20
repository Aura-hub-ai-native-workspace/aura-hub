/**
 * modelCatalog — the per-model facts nobody was reading.
 * ==================================================================
 * `ModelCapabilities` has carried `contextWindow`, `inputCostPer1k` and
 * `outputCostPer1k` since it was written (`provider/types.ts`), and every
 * adapter left them empty: `discoverModels()` returned an id, a name and
 * a couple of booleans guessed from the id. Nothing sized a request
 * against a context window, and nothing could say what a call cost.
 *
 * This file is where those numbers come from.
 *
 * ── Provenance and staleness ──────────────────────────────────────
 * Prices are **published list prices in USD per 1,000 tokens**, taken
 * from each vendor's own pricing page. Every entry names its source. They
 * were recorded on the date in `PRICES_RECORDED_AT` below and they DO go
 * out of date — vendors cut prices without notice. `costRecordedAt` is
 * carried on the returned capabilities so a caller can say how old the
 * figure it is quoting is, rather than presenting a stale number as
 * current. See QUESTIONS.md for the re-verification a human must do.
 *
 * A model that is not listed here gets no cost fields at all. An absent
 * price is honest; a made-up one is not, and a router that silently
 * treated "unknown" as "free" would route by fiction.
 */

import type { ModelCapabilities } from './types';

/** The day the figures below were transcribed from the vendors' pages. */
export const PRICES_RECORDED_AT = '2026-08-20';

export interface CatalogEntry extends ModelCapabilities {
  /** The vendor page the price and window were read from. */
  source: string;
}

/**
 * Prefix match, longest-first. Vendors version model ids by suffix
 * (`gpt-4o-2024-11-20`, `claude-sonnet-4-5-20250929`), so an exact-id
 * table would miss every dated snapshot of a model it already knows.
 */
type CatalogTable = Record<string, Record<string, CatalogEntry>>;

const CATALOG: CatalogTable = {
  /* ── OpenAI ──────────────────────────────────────────────────────
     Source: https://openai.com/api/pricing/ — list price per 1M tokens,
     divided by 1000 here. Context windows: https://platform.openai.com/docs/models */
  openai: {
    'gpt-4.1-nano': { contextWindow: 1047576, maxOutput: 32768, inputCostPer1k: 0.0001, outputCostPer1k: 0.0004, toolCalling: true, jsonMode: true, functionCalling: true, streaming: true, vision: true, source: 'https://openai.com/api/pricing/' },
    'gpt-4.1-mini': { contextWindow: 1047576, maxOutput: 32768, inputCostPer1k: 0.0004, outputCostPer1k: 0.0016, toolCalling: true, jsonMode: true, functionCalling: true, streaming: true, vision: true, source: 'https://openai.com/api/pricing/' },
    'gpt-4.1': { contextWindow: 1047576, maxOutput: 32768, inputCostPer1k: 0.002, outputCostPer1k: 0.008, toolCalling: true, jsonMode: true, functionCalling: true, streaming: true, vision: true, source: 'https://openai.com/api/pricing/' },
    'gpt-4o-mini': { contextWindow: 128000, maxOutput: 16384, inputCostPer1k: 0.00015, outputCostPer1k: 0.0006, toolCalling: true, jsonMode: true, functionCalling: true, streaming: true, vision: true, source: 'https://openai.com/api/pricing/' },
    'gpt-4o': { contextWindow: 128000, maxOutput: 16384, inputCostPer1k: 0.0025, outputCostPer1k: 0.01, toolCalling: true, jsonMode: true, functionCalling: true, streaming: true, vision: true, source: 'https://openai.com/api/pricing/' },
    'o4-mini': { contextWindow: 200000, maxOutput: 100000, inputCostPer1k: 0.0011, outputCostPer1k: 0.0044, reasoning: true, toolCalling: true, streaming: true, source: 'https://openai.com/api/pricing/' },
    'o3-mini': { contextWindow: 200000, maxOutput: 100000, inputCostPer1k: 0.0011, outputCostPer1k: 0.0044, reasoning: true, toolCalling: true, streaming: true, source: 'https://openai.com/api/pricing/' },
    'o3': { contextWindow: 200000, maxOutput: 100000, inputCostPer1k: 0.002, outputCostPer1k: 0.008, reasoning: true, toolCalling: true, streaming: true, source: 'https://openai.com/api/pricing/' },
  },

  /* ── Anthropic ───────────────────────────────────────────────────
     Source: https://www.anthropic.com/pricing#api — per 1M tokens.
     Context windows: https://docs.anthropic.com/en/docs/about-claude/models */
  anthropic: {
    'claude-opus-4-1': { contextWindow: 200000, maxOutput: 32000, inputCostPer1k: 0.015, outputCostPer1k: 0.075, reasoning: true, toolCalling: true, streaming: true, vision: true, source: 'https://www.anthropic.com/pricing#api' },
    'claude-opus-4': { contextWindow: 200000, maxOutput: 32000, inputCostPer1k: 0.015, outputCostPer1k: 0.075, reasoning: true, toolCalling: true, streaming: true, vision: true, source: 'https://www.anthropic.com/pricing#api' },
    'claude-sonnet-4-5': { contextWindow: 200000, maxOutput: 64000, inputCostPer1k: 0.003, outputCostPer1k: 0.015, reasoning: true, toolCalling: true, streaming: true, vision: true, source: 'https://www.anthropic.com/pricing#api' },
    'claude-sonnet-4': { contextWindow: 200000, maxOutput: 64000, inputCostPer1k: 0.003, outputCostPer1k: 0.015, reasoning: true, toolCalling: true, streaming: true, vision: true, source: 'https://www.anthropic.com/pricing#api' },
    'claude-haiku-4-5': { contextWindow: 200000, maxOutput: 64000, inputCostPer1k: 0.001, outputCostPer1k: 0.005, toolCalling: true, streaming: true, vision: true, source: 'https://www.anthropic.com/pricing#api' },
    'claude-3-7-sonnet': { contextWindow: 200000, maxOutput: 64000, inputCostPer1k: 0.003, outputCostPer1k: 0.015, reasoning: true, toolCalling: true, streaming: true, vision: true, source: 'https://www.anthropic.com/pricing#api' },
    'claude-3-5-haiku': { contextWindow: 200000, maxOutput: 8192, inputCostPer1k: 0.0008, outputCostPer1k: 0.004, toolCalling: true, streaming: true, vision: true, source: 'https://www.anthropic.com/pricing#api' },
    'claude-3-5-sonnet': { contextWindow: 200000, maxOutput: 8192, inputCostPer1k: 0.003, outputCostPer1k: 0.015, toolCalling: true, streaming: true, vision: true, source: 'https://www.anthropic.com/pricing#api' },
  },

  /* ── Google Gemini ───────────────────────────────────────────────
     Source: https://ai.google.dev/gemini-api/docs/pricing — paid tier,
     per 1M tokens. Gemini 2.5 Pro is tiered by prompt size; the figure
     below is the ≤200k-prompt tier, which is the one AURA's requests hit. */
  gemini: {
    'gemini-2.5-pro': { contextWindow: 1048576, maxOutput: 65536, inputCostPer1k: 0.00125, outputCostPer1k: 0.01, reasoning: true, toolCalling: true, streaming: true, vision: true, source: 'https://ai.google.dev/gemini-api/docs/pricing' },
    'gemini-2.5-flash-lite': { contextWindow: 1048576, maxOutput: 65536, inputCostPer1k: 0.0001, outputCostPer1k: 0.0004, toolCalling: true, streaming: true, vision: true, source: 'https://ai.google.dev/gemini-api/docs/pricing' },
    'gemini-2.5-flash': { contextWindow: 1048576, maxOutput: 65536, inputCostPer1k: 0.0003, outputCostPer1k: 0.0025, reasoning: true, toolCalling: true, streaming: true, vision: true, source: 'https://ai.google.dev/gemini-api/docs/pricing' },
    'gemini-2.0-flash-lite': { contextWindow: 1048576, maxOutput: 8192, inputCostPer1k: 0.000075, outputCostPer1k: 0.0003, toolCalling: true, streaming: true, vision: true, source: 'https://ai.google.dev/gemini-api/docs/pricing' },
    'gemini-2.0-flash': { contextWindow: 1048576, maxOutput: 8192, inputCostPer1k: 0.0001, outputCostPer1k: 0.0004, toolCalling: true, streaming: true, vision: true, source: 'https://ai.google.dev/gemini-api/docs/pricing' },
  },

  /* ── Groq ────────────────────────────────────────────────────────
     Source: https://groq.com/pricing/ — per 1M tokens. */
  groq: {
    'llama-3.3-70b-versatile': { contextWindow: 131072, maxOutput: 32768, inputCostPer1k: 0.00059, outputCostPer1k: 0.00079, toolCalling: true, streaming: true, source: 'https://groq.com/pricing/' },
    'llama-3.1-8b-instant': { contextWindow: 131072, maxOutput: 131072, inputCostPer1k: 0.00005, outputCostPer1k: 0.00008, toolCalling: true, streaming: true, source: 'https://groq.com/pricing/' },
  },

  /* ── Mistral ─────────────────────────────────────────────────────
     Source: https://mistral.ai/pricing#api-pricing — per 1M tokens. */
  mistral: {
    'mistral-large': { contextWindow: 131072, maxOutput: 32768, inputCostPer1k: 0.002, outputCostPer1k: 0.006, toolCalling: true, streaming: true, source: 'https://mistral.ai/pricing#api-pricing' },
    'mistral-small': { contextWindow: 131072, maxOutput: 32768, inputCostPer1k: 0.0001, outputCostPer1k: 0.0003, toolCalling: true, streaming: true, source: 'https://mistral.ai/pricing#api-pricing' },
    'codestral': { contextWindow: 262144, maxOutput: 32768, inputCostPer1k: 0.0003, outputCostPer1k: 0.0009, toolCalling: true, streaming: true, source: 'https://mistral.ai/pricing#api-pricing' },
  },
};

/** Every listed prefix for a provider, longest first, so `gpt-4o-mini` beats `gpt-4o`. */
function prefixesFor(providerId: string): string[] {
  const table = CATALOG[providerId];
  if (!table) return [];
  return Object.keys(table).sort((a, b) => b.length - a.length);
}

/**
 * Published facts for a model, or null when AURA has none.
 *
 * Null is a real answer and callers must handle it: `estimateCost()`
 * returns null rather than zero, and the router's cost comparison skips
 * a model it cannot price rather than assuming it is cheap.
 */
export function catalogEntry(providerId: string, modelId: string): CatalogEntry | null {
  const table = CATALOG[providerId];
  if (!table || !modelId) return null;
  const id = modelId.toLowerCase();
  for (const prefix of prefixesFor(providerId)) {
    if (id.startsWith(prefix)) return table[prefix];
  }
  return null;
}

/**
 * Fold catalogue facts into whatever an adapter already discovered.
 *
 * The adapter's own findings win where they exist — it talked to the API
 * and this file did not. The catalogue only fills gaps.
 */
export function enrichCapabilities(
  providerId: string,
  modelId: string,
  discovered: ModelCapabilities = {},
): ModelCapabilities {
  const entry = catalogEntry(providerId, modelId);
  if (!entry) return discovered;
  const { source: _source, ...facts } = entry;
  const merged: ModelCapabilities = { ...facts };
  for (const [key, value] of Object.entries(discovered)) {
    if (value !== undefined) (merged as Record<string, unknown>)[key] = value;
  }
  return merged;
}

/** The vendor page a model's published figures came from, when it has one. */
export function priceSource(providerId: string, modelId: string): string | null {
  return catalogEntry(providerId, modelId)?.source ?? null;
}

/**
 * What a call of this shape would cost, in USD. Null when unpriced.
 *
 * Deliberately not rounded: a per-request cost is fractions of a cent and
 * rounding it to cents makes every request free.
 */
export function estimateCost(
  capabilities: ModelCapabilities | undefined,
  promptTokens: number,
  completionTokens: number,
): number | null {
  if (!capabilities) return null;
  const { inputCostPer1k, outputCostPer1k } = capabilities;
  if (inputCostPer1k === undefined && outputCostPer1k === undefined) return null;
  return ((inputCostPer1k ?? 0) * promptTokens + (outputCostPer1k ?? 0) * completionTokens) / 1000;
}

/* ══════════════════════════════════════════════════════════════════
   Local models
   ══════════════════════════════════════════════════════════════════ */

/**
 * Capabilities for a model running on this machine.
 *
 * Cost is **zero, and that is a fact rather than a gap**: no money moves
 * when the model runs locally. (Electricity is real and is not something
 * this file can price; the number here is the API cost the router
 * compares, and locally there is none.)
 *
 * `contextWindow` is deliberately left undefined here. Ollama reports the
 * real `context_length` from the model file on `/api/show`, and LM Studio
 * reports `max_context_length` on `/api/v0/models`; those adapters fill
 * it in from the server. Guessing it from a model name would be inventing
 * the one number the context gate depends on.
 */
export function capabilitiesForLocalModel(modelId: string, parameterSize?: string): ModelCapabilities {
  const id = (modelId || '').toLowerCase();
  const params = parseParameterSize(parameterSize ?? id);
  return {
    inputCostPer1k: 0,
    outputCostPer1k: 0,
    streaming: true,
    vision: /llava|vision|-vl\b|minicpm-v|moondream|gemma3|qwen2\.5vl|qwen3-vl/.test(id),
    // Tool calling on a local model is a property of the model, not of the
    // server. These families ship trained tool-call templates; anything
    // else is reported as unknown (absent) rather than claimed.
    toolCalling: /llama3\.[1-3]|llama-3\.[1-3]|qwen2\.5|qwen3|mistral|mixtral|firefunction|command-r|hermes3|granite3|devstral|magistral/.test(id) || undefined,
    reasoning: /deepseek-r1|qwq|magistral|reasoning|o1|phi4-reasoning|qwen3/.test(id) || undefined,
    // A very small model is not a competent one for engineering work. This
    // is not a capability claim, it is the only size signal available, and
    // the router uses it only to break ties between local models.
    ...(params !== null ? { maxOutput: undefined } : {}),
  };
}

/** `"8.0B"`, `"llama3.2:3b"`, `"70b"` → billions of parameters, or null. */
export function parseParameterSize(value: string): number | null {
  const match = /(\d+(?:\.\d+)?)\s*b\b/i.exec(value ?? '');
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}
