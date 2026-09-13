/**
 * agentEventStream — pure SSE plumbing for the Central Agent live stream.
 * ------------------------------------------------------------------
 * No fetch, no timers, no React: splitting byte buffers into frames and
 * suppressing replay duplicates. Extracted so the reconnect/dedupe
 * contract is unit-testable (see agentEventStream.test.ts); the live
 * connection itself stays in `centralAgentClient.events`, which consumes
 * exactly these primitives.
 */

export interface StreamFrame {
  /** Bus sequence from the SSE `id:` line, or null for legacy frames. */
  seq: number | null;
  /** The `data:` payload text (null when the block carried none). */
  data: string | null;
}

/** Split complete `\n\n`-terminated blocks off a buffer. Heartbeat
 *  comments (`: ...`) survive as blocks with null data and are ignored
 *  downstream — they prove liveness, nothing else. */
export function splitBlocks(buffer: string): { blocks: string[]; rest: string } {
  const blocks: string[] = [];
  let rest = buffer;
  let idx: number;
  while ((idx = rest.indexOf('\n\n')) !== -1) {
    blocks.push(rest.slice(0, idx));
    rest = rest.slice(idx + 2);
  }
  return { blocks, rest };
}

/** Parse one block into its sequence id and data lines. Malformed `id:`
 *  values degrade to null (legacy treatment) rather than failing. */
export function parseBlock(block: string): StreamFrame {
  let seq: number | null = null;
  let data: string | null = null;
  for (const line of block.split('\n')) {
    if (line.startsWith('id:')) {
      const n = Number(line.slice(3).trim());
      seq = Number.isInteger(n) && n >= 0 ? n : null;
    } else if (line.startsWith('data:')) {
      // Later data lines win within a block; multi-line data payloads
      // are not part of this contract (payloads are single JSON lines).
      data = line.slice(5).trim();
    }
  }
  return { seq, data };
}

/** Cursor-aware duplicate suppression: sequence-first, with a legacy
 *  `type@at` fallback for frames that predate server sequences.
 *  One instance per stream subscription. */
export class FrameDeduper {
  private seenSeq = new Set<number>();
  private seenLegacy = new Set<string>();
  private lastSeq: number | null = null;

  /** Last seen sequence, for the Last-Event-ID cursor. */
  get cursor(): number | null {
    return this.lastSeq;
  }

  /** Returns true exactly once per unique frame. */
  check(seq: number | null, legacyKey: string): boolean {
    if (seq !== null) {
      if (this.seenSeq.has(seq)) return false;
      this.seenSeq.add(seq);
      this.lastSeq = this.lastSeq === null ? seq : Math.max(this.lastSeq, seq);
      // Unbounded growth guard: the bus tail itself is capped, so a
      // stream that somehow sees more unique sequences than any replay
      // window can hold is already broken — keep memory proportional
      // to the replay horizon instead of the session lifetime.
      if (this.seenSeq.size > 2000) {
        const sorted = [...this.seenSeq].sort((a, b) => a - b);
        for (const old of sorted.slice(0, this.seenSeq.size - 2000)) {
          if (old !== this.lastSeq) this.seenSeq.delete(old);
        }
      }
      return true;
    }
    if (this.seenLegacy.has(legacyKey)) return false;
    this.seenLegacy.add(legacyKey);
    return true;
  }
}
