/**
 * bpe — a real byte-pair-encoding tokenizer, with no dependencies.
 * ==================================================================
 * The repository has **zero third-party runtime dependencies** in the
 * backend. That is a property worth keeping, and it is the reason this
 * file exists rather than an `npm i gpt-tokenizer`.
 *
 * What is here is the genuine GPT-2/`tiktoken`-family algorithm:
 *
 *   1. split the text with the model's pre-tokenizer regex,
 *   2. convert each piece to UTF-8 bytes,
 *   3. repeatedly merge the adjacent pair with the lowest rank,
 *   4. count the resulting tokens.
 *
 * What is NOT here is a vocabulary. A cl100k merge table is ~1.7 MB of
 * data; shipping it would be vendoring a dependency in all but name, and
 * inventing one would produce numbers that look precise and are wrong.
 * So the ranks are **loaded from disk if the user has them** —
 * `<AURA_HOME>/tokenizer/<name>.tiktoken`, the exact file format
 * OpenAI publishes — and the tokenizer reports honestly that it has none
 * when they are absent. See `countTokens()` for what happens then, and
 * QUESTIONS.md for the dependency decision this defers to the user.
 *
 * The algorithm is exercised by `model-router-verify` against a small
 * hand-built rank table, so "real BPE" is a claim with a test behind it
 * rather than an assertion about code nobody ran.
 */

import fs from 'node:fs';
import path from 'node:path';
import { homePath } from '../persist';

/**
 * GPT-2 / cl100k pre-tokenizer split.
 *
 * Written without lookbehind so it runs on every JS engine AURA targets.
 * The order of alternatives is significant: contractions first, then
 * letters, then digits, then punctuation runs, then whitespace.
 */
const PRE_TOKEN = /'(?:[sdmt]|ll|ve|re)| ?[\p{L}]+| ?[\p{N}]+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu;

export function preTokenize(text: string): string[] {
  return text.match(PRE_TOKEN) ?? [];
}

export interface RankTable {
  name: string;
  /** token bytes (as a latin1 string) → rank */
  ranks: Map<string, number>;
}

/** Bytes → a lossless string key. latin1 is a byte-for-byte mapping. */
function key(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('latin1');
}

/**
 * One BPE merge pass over a byte sequence.
 *
 * The classic O(n²) formulation: find the lowest-ranked adjacent pair,
 * merge every occurrence of it, repeat. Pre-tokens are short (a word),
 * so this is fast in practice and is what the reference implementations
 * do.
 */
export function bpeMerge(bytes: Uint8Array, ranks: Map<string, number>): number {
  if (bytes.length <= 1) return bytes.length;
  let parts: Uint8Array[] = Array.from(bytes, (b) => Uint8Array.of(b));

  for (;;) {
    let bestRank = Infinity;
    let bestIndex = -1;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const merged = new Uint8Array(parts[i].length + parts[i + 1].length);
      merged.set(parts[i], 0);
      merged.set(parts[i + 1], parts[i].length);
      const rank = ranks.get(key(merged));
      if (rank !== undefined && rank < bestRank) { bestRank = rank; bestIndex = i; }
    }
    if (bestIndex === -1) break;
    const merged = new Uint8Array(parts[bestIndex].length + parts[bestIndex + 1].length);
    merged.set(parts[bestIndex], 0);
    merged.set(parts[bestIndex + 1], parts[bestIndex].length);
    parts = [...parts.slice(0, bestIndex), merged, ...parts.slice(bestIndex + 2)];
  }
  return parts.length;
}

/** Token count for `text` under `table`. The real thing, not an estimate. */
export function countWithRanks(text: string, table: RankTable): number {
  let total = 0;
  for (const piece of preTokenize(text)) {
    const bytes = new Uint8Array(Buffer.from(piece, 'utf8'));
    // A pre-token that is itself in the vocabulary is one token — the
    // common case for ordinary words, and the fast path.
    if (table.ranks.has(key(bytes))) { total += 1; continue; }
    total += bpeMerge(bytes, table.ranks);
  }
  return total;
}

/* ── loading ranks from disk ───────────────────────────────────── */

/**
 * OpenAI's published `.tiktoken` format: one `base64(tokenBytes) rank`
 * pair per line. Parsed exactly, with malformed lines skipped rather
 * than aborting a 100k-line file over one bad row.
 */
export function parseTiktoken(contents: string, name: string): RankTable {
  const ranks = new Map<string, number>();
  for (const line of contents.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const space = trimmed.indexOf(' ');
    if (space <= 0) continue;
    const rank = Number(trimmed.slice(space + 1));
    if (!Number.isSafeInteger(rank)) continue;
    try {
      ranks.set(Buffer.from(trimmed.slice(0, space), 'base64').toString('latin1'), rank);
    } catch { /* not base64 — skip the line, keep the file */ }
  }
  return { name, ranks };
}

/** Where a user drops a vocabulary they already have. */
export function tokenizerDir(): string { return homePath('tokenizer'); }

const cache = new Map<string, RankTable | null>();

/**
 * Load `<AURA_HOME>/tokenizer/<name>.tiktoken`, or null when absent.
 *
 * Cached including the null: a missing file must not be stat'd on every
 * token count, and a user who adds one restarts the service.
 */
export function loadRankTable(name: string): RankTable | null {
  if (cache.has(name)) return cache.get(name) ?? null;
  const file = path.join(tokenizerDir(), `${name}.tiktoken`);
  let table: RankTable | null = null;
  try {
    const contents = fs.readFileSync(file, 'utf8');
    const parsed = parseTiktoken(contents, name);
    table = parsed.ranks.size > 0 ? parsed : null;
  } catch {
    table = null;
  }
  cache.set(name, table);
  return table;
}

/** Test seam — lets a verification script install a table without a file. */
export function __installRankTable(name: string, table: RankTable | null): void {
  cache.set(name, table);
}
