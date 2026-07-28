/**
 * InvertedIndex — a real keyword index with BM25 ranking.
 * ==================================================================
 * Tokenizes with code-aware splitting (camelCase + snake_case → also
 * indexes sub-tokens), maintains term→chunk postings with term
 * frequencies and per-chunk lengths, and scores with BM25. Supports
 * exact, prefix and fuzzy (bounded edit-distance) term expansion.
 *
 * `chunkTerms` is the canonical serialized form; postings + lengths are
 * derived, so persistence is compact and reload is exact. No vectors.
 */

const K1 = 1.5;
const B = 0.75;

export type ExpansionKind = 'exact' | 'prefix' | 'fuzzy';

export interface RawHit {
  chunkId: string;
  score: number;
  matched: string[]; // query tokens that contributed
  reasons: string[]; // 'bm25' + expansion kinds used
}

function splitIdentifier(tok: string): string[] {
  const out: string[] = [];
  for (const part of tok.split(/[_$\-]+/).filter(Boolean)) {
    const camel = part
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .split(/\s+/);
    out.push(...camel);
  }
  return out;
}

export function tokenize(text: string): string[] {
  const matches = text.match(/[A-Za-z0-9_$]+/g) ?? [];
  const out: string[] = [];
  for (const tok of matches) {
    const lower = tok.toLowerCase();
    if (lower.length >= 2 && lower.length <= 40) out.push(lower);
    for (const sub of splitIdentifier(tok)) {
      const s = sub.toLowerCase();
      if (s.length >= 2 && s.length <= 40 && s !== lower) out.push(s);
    }
  }
  return out;
}

/** Bounded Levenshtein — returns a distance capped at `max + 1`. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev = new Array<number>(b.length + 1);
  const cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}

export class InvertedIndex {
  private postings = new Map<string, Map<string, number>>();
  private chunkTerms = new Map<string, Array<[string, number]>>();
  private lengths = new Map<string, number>();
  private totalLen = 0;

  get chunkCount(): number {
    return this.lengths.size;
  }
  private get avgdl(): number {
    return this.chunkCount ? this.totalLen / this.chunkCount : 1;
  }

  add(chunkId: string, text: string): void {
    if (this.chunkTerms.has(chunkId)) this.remove(chunkId);
    const tokens = tokenize(text);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);

    const entries: Array<[string, number]> = [];
    for (const [term, count] of tf) {
      entries.push([term, count]);
      let p = this.postings.get(term);
      if (!p) this.postings.set(term, (p = new Map()));
      p.set(chunkId, count);
    }
    this.chunkTerms.set(chunkId, entries);
    this.lengths.set(chunkId, tokens.length);
    this.totalLen += tokens.length;
  }

  remove(chunkId: string): void {
    const entries = this.chunkTerms.get(chunkId);
    if (!entries) return;
    for (const [term] of entries) {
      const p = this.postings.get(term);
      if (p) {
        p.delete(chunkId);
        if (p.size === 0) this.postings.delete(term);
      }
    }
    this.totalLen -= this.lengths.get(chunkId) ?? 0;
    this.lengths.delete(chunkId);
    this.chunkTerms.delete(chunkId);
  }

  /** Expand one query token into matching index terms with weights. */
  private expand(token: string, modes: Set<ExpansionKind>, maxDist: number) {
    const hits: Array<{ term: string; weight: number; kind: ExpansionKind }> = [];
    if (this.postings.has(token)) hits.push({ term: token, weight: 1, kind: 'exact' });

    if (modes.has('prefix') && token.length >= 2) {
      for (const term of this.postings.keys()) {
        if (term !== token && term.startsWith(token)) hits.push({ term, weight: 0.5, kind: 'prefix' });
      }
    }
    if (modes.has('fuzzy') && token.length >= 4) {
      for (const term of this.postings.keys()) {
        if (term === token || term.startsWith(token)) continue;
        if (Math.abs(term.length - token.length) > maxDist) continue;
        const d = editDistance(token, term, maxDist);
        if (d <= maxDist) hits.push({ term, weight: 0.35 * (1 - d / (maxDist + 1)), kind: 'fuzzy' });
      }
    }
    return hits;
  }

  search(queryTokens: string[], modes: Set<ExpansionKind>, maxDist: number): RawHit[] {
    const N = this.chunkCount;
    if (N === 0) return [];
    const avgdl = this.avgdl;

    // chunkId → accumulated score / matched tokens / reasons
    const acc = new Map<string, { score: number; matched: Set<string>; reasons: Set<string> }>();
    const uniqueQ = [...new Set(queryTokens)];

    for (const qtok of uniqueQ) {
      const expansions = this.expand(qtok, modes, maxDist);
      for (const { term, weight, kind } of expansions) {
        const posting = this.postings.get(term);
        if (!posting) continue;
        const df = posting.size;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        for (const [chunkId, tf] of posting) {
          const dl = this.lengths.get(chunkId) ?? avgdl;
          const norm = tf * (K1 + 1) / (tf + K1 * (1 - B + B * (dl / avgdl)));
          const contrib = weight * idf * norm;
          let e = acc.get(chunkId);
          if (!e) acc.set(chunkId, (e = { score: 0, matched: new Set(), reasons: new Set(['bm25']) }));
          e.score += contrib;
          e.matched.add(qtok);
          e.reasons.add(kind);
        }
      }
    }

    return [...acc.entries()]
      .map(([chunkId, e]) => ({ chunkId, score: e.score, matched: [...e.matched], reasons: [...e.reasons] }))
      .sort((a, b) => b.score - a.score);
  }

  /* ── Serialization (canonical = chunkTerms) ──────────────────────── */

  toJSON(): { chunkTerms: Array<[string, Array<[string, number]>]> } {
    return { chunkTerms: [...this.chunkTerms.entries()] };
  }

  static fromJSON(data: { chunkTerms: Array<[string, Array<[string, number]>]> }): InvertedIndex {
    const idx = new InvertedIndex();
    for (const [chunkId, entries] of data.chunkTerms) {
      idx.chunkTerms.set(chunkId, entries);
      let len = 0;
      for (const [term, count] of entries) {
        let p = idx.postings.get(term);
        if (!p) idx.postings.set(term, (p = new Map()));
        p.set(chunkId, count);
        len += count;
      }
      idx.lengths.set(chunkId, len);
      idx.totalLen += len;
    }
    return idx;
  }
}
